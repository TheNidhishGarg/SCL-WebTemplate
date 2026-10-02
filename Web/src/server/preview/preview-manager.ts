import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { StoreError } from "@/server/store/errors";
import type { TemplatePreviewStore } from "@/server/store/template-previews";
import { applyOperation, buildExport, missingAssets, opContext, structureView, verifyTemplate } from "@/server/templates";
import { readOverrides } from "@/server/templates/operations";
import { createWorkspace, inspectWorkspace, readEditable, removeWorkspace, reprocessWorkspace, saveBrand, savePageContent, upgradeWorkspace, workspacePaths, type WorkspaceInfo } from "./workspace";

// Live previews of generated templates: one preview process per template
// (scripts/preview-host.mjs), started, stopped and restarted from the
// dashboard. Processes are recorded in the database so a Web restart can
// find them; each also stops itself when the dashboard stops looking at it.
//
// Modes:
//   local  - processes on this machine, served on 127.0.0.1:<port>, i.e. to a
//            browser on this machine. "localhost" is the viewer's computer.
//   remote - isolated preview servers with authenticated URLs: not available
//            yet (see docs/template-preview.md); reported, never faked.
//   off    - previews disabled.

export type PreviewMode = "local" | "remote" | "off";
export type PreviewState = "stopped" | "starting" | "building" | "ready" | "error";
export type MissingAsset = { ref: string; from: string };
export type PreviewStatus = {
  state: PreviewState;
  buildId: number;
  error: string | null;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  builtAt: string | null;
  // Local files the current build refers to but does not have, and files the
  // browser asked the preview for that do not exist.
  missingAssets: MissingAsset[];
  notFound: string[];
};

export type PreviewConfig = {
  mode: PreviewMode;
  root: string; // workspaces live here
  hostScript: string;
  sarHome: string | null;
  portMin: number;
  portMax: number;
  maxRunning: number;
  idleMs: number;
  frameAncestors: string;
  nodePath?: string;
  startTimeoutMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stopped: PreviewStatus = { state: "stopped", buildId: 0, error: null, port: null, url: null, startedAt: null, builtAt: null, missingAssets: [], notFound: [] };

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

export function createPreviewManager(cfg: PreviewConfig, deps: { registry: TemplatePreviewStore }) {
  const { registry } = deps;
  const paths = (jobId: string) => workspacePaths(cfg.root, jobId);

  // Is this pid really this job's preview host? (pids get reused.)
  const isOurs = (jobId: string, pid: number | null) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    const cmd = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
    return cmd.includes(cfg.hostScript) && cmd.includes(paths(jobId).template);
  };

  const readState = (jobId: string) => {
    try {
      return JSON.parse(readFileSync(paths(jobId).state, "utf8")) as { state: PreviewState | "stopped"; buildId: number; error: string | null; startedAt: string; builtAt: string | null; notFound?: string[] };
    } catch {
      return null;
    }
  };

  // Missing assets of the current build, scanned once per build.
  const scans = new Map<string, { buildId: number; missing: MissingAsset[] }>();
  const scan = (jobId: string, buildId: number) => {
    const hit = scans.get(jobId);
    if (hit?.buildId === buildId) return hit.missing;
    let missing: MissingAsset[] = [];
    try {
      missing = missingAssets(`${paths(jobId).template}/dist`).slice(0, 200);
    } catch {
      /* dist being rewritten: scanned on the next poll */
      return hit?.missing ?? [];
    }
    scans.set(jobId, { buildId, missing });
    return missing;
  };

  const heartbeat = (jobId: string) => {
    const hb = paths(jobId).heartbeat;
    const t = new Date();
    try {
      utimesSync(hb, t, t);
    } catch {
      writeFileSync(hb, "");
    }
  };

  const kill = async (jobId: string, pid: number | null) => {
    if (pid && isOurs(jobId, pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
      for (let i = 0; i < 30 && isOurs(jobId, pid); i++) await sleep(100);
      if (isOurs(jobId, pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    rmSync(paths(jobId).heartbeat, { force: true });
  };

  const self = {
    mode: cfg.mode,

    availability(): { ok: true } | { ok: false; reason: string } {
      if (cfg.mode === "off") return { ok: false, reason: "Live previews are turned off on this server (PREVIEW_MODE)." };
      if (cfg.mode === "remote") return { ok: false, reason: "Remote previews (isolated preview servers with authenticated URLs) are not available yet. Use local previews in development." };
      if (!existsSync(cfg.hostScript)) return { ok: false, reason: "The preview host script is missing from this installation." };
      return { ok: true };
    },

    workspace: (jobId: string): WorkspaceInfo | null => inspectWorkspace(cfg.root, jobId, cfg.sarHome),

    // Creates the editable copy from the stored ZIP if there is none yet.
    ensureWorkspace(jobId: string, zip: () => Uint8Array): WorkspaceInfo {
      const ws = self.workspace(jobId);
      if (!ws) return createWorkspace(cfg.root, jobId, zip(), cfg.sarHome);
      if (upgradeWorkspace(cfg.root, jobId, zip)) return self.workspace(jobId)!;
      return ws;
    },

    // Throws away edits: a fresh copy from the stored ZIP.
    async reset(jobId: string, zip: () => Uint8Array): Promise<WorkspaceInfo> {
      await self.stop(jobId);
      removeWorkspace(cfg.root, jobId);
      return createWorkspace(cfg.root, jobId, zip(), cfg.sarHome);
    },

    status(jobId: string): PreviewStatus {
      const row = registry.get(jobId);
      if (!row || row.status !== "running") return { ...stopped, error: row?.error ?? null };
      if (!isOurs(jobId, row.pid)) {
        const last = readState(jobId);
        const why = last?.state === "error" ? last.error : "The preview process stopped (it was idle, or ended unexpectedly).";
        registry.markStopped(jobId, last?.state === "stopped" ? null : why);
        return { ...stopped, error: last?.state === "stopped" ? null : why };
      }
      // The dashboard is looking: keep it alive.
      heartbeat(jobId);
      registry.touch(jobId);
      const s = readState(jobId);
      const state = s && s.state !== "stopped" ? (s.state as PreviewState) : "starting";
      return {
        state,
        buildId: s?.buildId ?? 0,
        error: s?.error ?? null,
        port: row.port,
        url: row.port ? `http://127.0.0.1:${row.port}` : null,
        startedAt: row.startedAt,
        builtAt: s?.builtAt ?? null,
        missingAssets: s?.buildId ? scan(jobId, s.buildId) : [],
        notFound: s?.notFound ?? [],
      };
    },

    async start(jobId: string, projectId: string): Promise<PreviewStatus> {
      const avail = self.availability();
      if (!avail.ok) throw new StoreError("conflict", avail.reason);
      const ws = self.workspace(jobId);
      if (!ws) throw new StoreError("conflict", "Open the template first.");
      if (!ws.verification.ok) throw new StoreError("conflict", ws.verification.reason);
      await self.cleanup();
      const current = self.status(jobId);
      if (current.state !== "stopped") return current;
      if (registry.running().length >= cfg.maxRunning) throw new StoreError("conflict", `${cfg.maxRunning} previews are already running. Stop one first.`);

      // A free port in the configured range, not held by another preview.
      const used = registry.usedPorts();
      let port: number | null = null;
      for (let p = cfg.portMin; p <= cfg.portMax; p++) {
        if (!used.has(p) && (await portFree(p))) {
          port = p;
          break;
        }
      }
      if (!port) throw new StoreError("conflict", `No free port for a preview between ${cfg.portMin} and ${cfg.portMax}.`);

      const p = paths(jobId);
      rmSync(p.state, { force: true });
      writeFileSync(p.heartbeat, "");
      const log = openSync(p.log, "a");
      const child = spawn(
        cfg.nodePath ?? process.execPath,
        [cfg.hostScript, "--dir", p.template, "--port", String(port), "--state", p.state, "--heartbeat", p.heartbeat, "--frame-ancestors", cfg.frameAncestors, "--idle-ms", String(cfg.idleMs)],
        { detached: true, stdio: ["ignore", log, log], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv, shell: false },
      );
      closeSync(log);
      if (!child.pid) throw new StoreError("conflict", "The preview process could not be started.");
      child.unref(); // a preview outlives the request; it is tracked by pid
      registry.markRunning(jobId, projectId, child.pid, port);

      // Wait until it is serving (or has failed), so the caller gets a real state.
      const until = Date.now() + (cfg.startTimeoutMs ?? 15_000);
      while (Date.now() < until) {
        const s = readState(jobId);
        if (s && s.state !== "starting") break;
        if (!isOurs(jobId, child.pid)) break;
        await sleep(100);
      }
      const s = self.status(jobId);
      if (s.state === "stopped") {
        const tail = existsSync(p.log) ? readFileSync(p.log, "utf8").trim().split("\n").slice(-5).join("\n") : "";
        throw new StoreError("conflict", `The preview could not start. ${s.error ?? ""} ${tail}`.trim().slice(0, 1500));
      }
      return s;
    },

    async stop(jobId: string): Promise<PreviewStatus> {
      const row = registry.get(jobId);
      if (row?.status === "running") {
        await kill(jobId, row.pid);
        registry.markStopped(jobId);
      }
      return stopped;
    },

    async restart(jobId: string, projectId: string): Promise<PreviewStatus> {
      await self.stop(jobId);
      return self.start(jobId, projectId);
    },

    // Stops previews nobody is looking at, and forgets ones whose process is gone.
    async cleanup(): Promise<number> {
      let n = 0;
      for (const row of registry.running()) {
        if (!isOurs(row.jobId, row.pid)) {
          registry.markStopped(row.jobId, null);
          n++;
        } else if (!row.lastSeenAt || Date.now() - Date.parse(row.lastSeenAt) > cfg.idleMs) {
          await kill(row.jobId, row.pid);
          registry.markStopped(row.jobId, null);
          n++;
        }
      }
      return n;
    },

    // ---- structure: composition, overrides, tokens, reports, checks, export

    structure: (jobId: string) => structureView(paths(jobId).template, paths(jobId).capture, paths(jobId).reports),

    // Applied to the working copy; a running preview rebuilds by itself.
    applyOperation(jobId: string, op: unknown) {
      const p = paths(jobId);
      return applyOperation(p.template, op, opContext(p.template, p.capture));
    },

    // Rebuilds the working copy from the stored ZIP and replays the overrides
    // (without the one undone). Edits are put back where their field still exists.
    async replay(jobId: string, projectId: string, zip: () => Uint8Array, without: number | null) {
      const p = paths(jobId);
      const ops = readOverrides(p.template).operations;
      if (without !== null && !ops[without]) throw new StoreError("not_found", "That override is not in this template's list.");
      const wasRunning = self.status(jobId).state !== "stopped";
      await self.stop(jobId); // the preview watches the folder being replaced
      const result = reprocessWorkspace(cfg.root, jobId, zip(), without === null ? ops : ops.filter((_, i) => i !== without));
      if (wasRunning) await self.start(jobId, projectId);
      return result;
    },

    verify(jobId: string) {
      const ws = self.workspace(jobId);
      if (!ws) throw new StoreError("conflict", "Open the template first.");
      if (!ws.verification.ok) throw new StoreError("conflict", ws.verification.reason);
      const p = paths(jobId);
      return verifyTemplate(p.template, p.verifyDist, `${p.reports}/verification.json`);
    },

    exportZip: (jobId: string, zip: () => Uint8Array) => buildExport(paths(jobId).template, paths(jobId).capture, paths(jobId).reports, zip()),

    editable: (jobId: string) => readEditable(paths(jobId).template),
    saveBrand: (jobId: string, input: Parameters<typeof saveBrand>[1]) => saveBrand(paths(jobId).template, input),
    savePageContent: (jobId: string, pageId: string, input: Parameters<typeof savePageContent>[2]) => savePageContent(paths(jobId).template, pageId, input),
  };
  return self;
}

export type PreviewManager = ReturnType<typeof createPreviewManager>;

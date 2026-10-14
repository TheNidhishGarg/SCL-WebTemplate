import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, resolve, sep } from "node:path";

// Runs SaveAllResources' own command-line tool (app/cli.mjs) as a separate
// operating-system process: URL in, website-template.zip out. Nothing from
// SaveAllResources is imported or copied; Web only starts the program with an
// argument list, reads the files it writes, and sends it signals.
//
// This module knows nothing about projects or workflows. It reports what the
// process did; the pipeline (src/server/pipeline) decides what that means.
// Production can swap it for a remote worker that implements TemplateRunner.

export type RunOptions = { maxPages: number; maxDepth: number; maxMinutes: number };
// `download`: a ZIP saved with the Chrome Web Store build of Save All Resources,
// templatised with SaveAllResources' `--import` instead of capturing `url`
// (which is then the page the download was made from).
export type RunSpec = { runId: string; url: string; options: RunOptions; download?: { filename: string; bytes: Uint8Array } };

// Stable stages, mapped from SaveAllResources' own job status. "finishing":
// SaveAllResources says it is done; the process is copying the export out.
export type RunStage = "starting" | "capturing" | "packaging" | "templatising" | "verifying" | "finishing";
export type RunProgress = { stage: RunStage; sarJobId: string | null; pages: { discovered: number; captured: number; failed: number; pending: number } | null };

export type RunOutcome =
  | { kind: "succeeded"; sarJobId: string | null; zipPath: string; zipSha256: string; zipBytes: number }
  | { kind: "failed"; sarJobId: string | null; code: "sar_failed" | "missing_zip" | "timeout" | "spawn_failed" | "interrupted" | "stopped_outside_web"; message: string }
  | { kind: "cancelled"; sarJobId: string | null };

export type RunHandlers = {
  onProgress: (p: RunProgress) => void;
  onExit: (o: RunOutcome) => void;
};

export interface TemplateRunner {
  readonly mode: string;
  availability(): { ok: true } | { ok: false; reason: string };
  // Importing a download needs no browser extension, so it can be available when capturing is not.
  importAvailability(): { ok: true } | { ok: false; reason: string };
  // Resolves once the process is running (with its pid); throws RunnerError if it cannot start.
  start(spec: RunSpec, handlers: RunHandlers): Promise<{ pid: number | null }>;
  // Asks a run to stop. The outcome arrives through onExit once the process has ended.
  cancel(runId: string): boolean;
  isRunning(runId: string): boolean;
  // After a Web restart: follow a run whose process is still alive. false if it is gone.
  reattach(runId: string, pid: number, handlers: RunHandlers): boolean;
  // Removes the bulky working data of a finished run, keeping the log and the ZIP.
  discardWorkingData(runId: string): void;
  // Removes run folders older than the retention period, except the ones listed.
  prune(keep: Set<string>, olderThanMs: number): number;
}

export class RunnerError extends Error {
  constructor(
    readonly code: "unavailable" | "busy" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SAR_PORT = 4100; // compiled into the SaveAllResources extension build

// ------------------------------------------------------------------ install

export function resolveSarHome(env: { SAR_HOME?: string; NODE_ENV: string }, cwd = process.cwd()): string | null {
  if (env.SAR_HOME) return resolve(cwd, env.SAR_HOME);
  // Development convenience only: a sibling checkout. Production must set SAR_HOME.
  if (env.NODE_ENV === "development") {
    const sibling = resolve(cwd, "..", "SaveAllResources");
    return existsSync(join(sibling, "app", "cli.mjs")) ? sibling : null;
  }
  return null;
}

// What a usable installation looks like. Reasons name the missing step, not paths.
export function checkSarInstallation(home: string | null, purpose: "capture" | "import" = "capture"): { ok: true; home: string; cli: string } | { ok: false; reason: string } {
  if (!home) return { ok: false, reason: "SaveAllResources is not configured: set SAR_HOME to its installation folder." };
  if (!isAbsolute(home) || !existsSync(home) || !statSync(home).isDirectory()) return { ok: false, reason: "SAR_HOME does not point to a folder." };
  const cli = join(home, "app", "cli.mjs");
  if (!existsSync(cli)) return { ok: false, reason: "SAR_HOME has no app/cli.mjs: it is not a SaveAllResources installation." };
  try {
    const pkg = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
    if (pkg.name !== "sar-website-template") return { ok: false, reason: "SAR_HOME/package.json is not the SaveAllResources template package." };
  } catch {
    return { ok: false, reason: "SAR_HOME has no readable package.json." };
  }
  if (!existsSync(join(home, "node_modules", "puppeteer", "package.json"))) return { ok: false, reason: "SaveAllResources dependencies are not installed: run `npm ci` in SAR_HOME." };
  if (purpose === "capture" && !existsSync(join(home, "extension", "dist", "extension-id.txt"))) return { ok: false, reason: "The SaveAllResources extension is not built: run `npm run build:extension` in SAR_HOME." };
  return { ok: true, home, cli };
}

// ----------------------------------------------------------------- progress

const STAGES: Record<string, RunStage> = {
  awaiting_extension: "starting",
  capturing: "capturing",
  packaging: "packaging",
  templatising: "templatising",
  verifying: "verifying",
  completed: "finishing",
  completed_with_warnings: "finishing",
  failed: "finishing",
  cancelled: "finishing",
};
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

// SaveAllResources' job.json is its internal state, not a contract: read only
// what is recognisable, and report nothing rather than guess.
export function parseSarJob(raw: unknown): { sarJobId: string | null; status: string | null; stage: RunStage | null; pages: RunProgress["pages"] } {
  const j = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = typeof j.status === "string" ? j.status : null;
  const p = ((j.capture as Record<string, unknown> | null)?.progress ?? null) as Record<string, unknown> | null;
  const nums = p ? [count(p.discovered), count(p.captured), count(p.failed), count(p.pending)] : [];
  return {
    sarJobId: typeof j.jobId === "string" && RUN_ID.test(j.jobId) ? j.jobId : null,
    status,
    stage: status && status in STAGES ? STAGES[status] : null,
    pages: nums.length && nums.every((n) => n !== null) ? { discovered: nums[0]!, captured: nums[1]!, failed: nums[2]!, pending: nums[3]! } : null,
  };
}

// ---------------------------------------------------------------- the runner

type Active = { child: ChildProcess | null; pid: number; cancelRequested: boolean; timedOut: boolean; timers: NodeJS.Timeout[]; sarJobId: string | null; lastProgress: string; tail: string[] };

const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "XDG_CACHE_HOME", "PUPPETEER_CACHE_DIR", "PUPPETEER_EXECUTABLE_PATH", "SystemRoot"];

export function createLocalRunner(cfg: {
  home: string | null;
  runsDir: string; // where run folders live (inside Web's data directory)
  nodePath?: string;
  pollMs?: number;
  // Extra time after the capture limit for processing (templatising, verifying).
  processingGraceMs?: number;
  killGraceMs?: number;
  timeoutMs?: (o: RunOptions) => number;
  portInUse?: () => Promise<boolean>;
}): TemplateRunner {
  const install = checkSarInstallation(cfg.home);
  const importInstall = checkSarInstallation(cfg.home, "import");
  const pollMs = cfg.pollMs ?? 1000;
  const killGraceMs = cfg.killGraceMs ?? 90_000;
  const timeoutOf = cfg.timeoutMs ?? ((o: RunOptions) => o.maxMinutes * 60_000 + (cfg.processingGraceMs ?? 20 * 60_000));
  const portInUse = cfg.portInUse ?? (() => new Promise<boolean>((r) => {
    const s = connect({ host: "127.0.0.1", port: SAR_PORT });
    s.once("connect", () => (s.destroy(), r(true)));
    s.once("error", () => r(false));
    s.setTimeout(1000, () => (s.destroy(), r(false)));
  }));
  const g = globalThis as typeof globalThis & { __sclSarRuns?: Map<string, Active> };
  const active = (g.__sclSarRuns ??= new Map<string, Active>()); // survives dev hot reloads

  const runDir = (runId: string) => {
    if (!RUN_ID.test(runId)) throw new RunnerError("invalid", "Invalid run id.");
    const root = resolve(cfg.runsDir);
    const dir = resolve(root, runId);
    if (!dir.startsWith(root + sep)) throw new RunnerError("invalid", "Invalid run directory.");
    return { dir, out: join(dir, "out"), data: join(dir, "sar-data"), log: join(dir, "sar.log") };
  };
  // Never show filesystem paths to users.
  const sanitize = (s: string, runId: string) => {
    let t = s;
    if (cfg.home) t = t.split(cfg.home).join("<SAR_HOME>");
    t = t.split(runDir(runId).dir).join("<run>");
    return t.replace(/\/(Users|home)\/[^\s'"]+/g, "<path>").slice(0, 600);
  };

  const readProgress = (runId: string, a: Active): RunProgress | null => {
    const jobs = join(runDir(runId).data, "jobs");
    if (!existsSync(jobs)) return null;
    const id = a.sarJobId ?? readdirSync(jobs).find((d) => RUN_ID.test(d));
    if (!id) return null;
    try {
      const parsed = parseSarJob(JSON.parse(readFileSync(join(jobs, id, "job.json"), "utf8")));
      a.sarJobId ??= parsed.sarJobId ?? id;
      return parsed.stage ? { stage: parsed.stage, sarJobId: a.sarJobId, pages: parsed.pages } : null;
    } catch {
      return null; // mid-write or unreadable: report nothing new
    }
  };

  const findZip = (runId: string, sarJobId: string | null): string | null => {
    const { out } = runDir(runId);
    // Runtime data paths, not build inputs: excluded from output file tracing.
    if (!existsSync(/*turbopackIgnore: true*/ out)) return null;
    const named = sarJobId ? join(out, `${sarJobId}-website-template.zip`) : null;
    if (named && existsSync(named)) return named;
    const all = readdirSync(/*turbopackIgnore: true*/ out).filter((f) => f.endsWith("-website-template.zip"));
    return all.length === 1 ? join(out, all[0]) : null;
  };

  const succeededOrMissing = (runId: string, sarJobId: string | null): RunOutcome => {
    const zip = findZip(runId, sarJobId);
    if (!zip) return { kind: "failed", sarJobId, code: "missing_zip", message: "SaveAllResources finished but no website-template.zip was produced." };
    // Hashed in chunks: a 200 MB template is never held whole just to fingerprint it.
    const hash = createHash("sha256");
    const fd = openSync(/*turbopackIgnore: true*/ zip, "r");
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let size = 0;
    try {
      for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
        hash.update(chunk.subarray(0, n));
        size += n;
      }
    } finally {
      closeSync(fd);
    }
    return { kind: "succeeded", sarJobId, zipPath: zip, zipSha256: hash.digest("hex"), zipBytes: size };
  };

  const watch = (runId: string, a: Active, handlers: RunHandlers) => {
    const poll = setInterval(() => {
      const p = readProgress(runId, a);
      if (!p) return;
      const key = JSON.stringify(p);
      if (key !== a.lastProgress) {
        a.lastProgress = key;
        handlers.onProgress(p);
      }
    }, pollMs);
    a.timers.push(poll);
  };

  const signal = (a: Active, sig: NodeJS.Signals, group = false) => {
    try {
      process.kill(group ? -a.pid : a.pid, sig);
    } catch {
      /* already gone */
    }
  };

  const self: TemplateRunner = {
    mode: "local-process",

    availability: () => (install.ok ? { ok: true } : { ok: false, reason: install.reason }),
    importAvailability: () => (importInstall.ok ? { ok: true } : { ok: false, reason: importInstall.reason }),

    async start(spec, handlers) {
      const inst = spec.download ? importInstall : install;
      if (!inst.ok) throw new RunnerError("unavailable", inst.reason);
      if (!/^https?:\/\//i.test(spec.url)) throw new RunnerError("invalid", "Only http(s) URLs can be captured.");
      if (active.size > 0) throw new RunnerError("busy", "SaveAllResources is busy with another generation.");
      // An import starts no SaveAllResources server, so it does not need port 4100.
      if (!spec.download && (await portInUse())) throw new RunnerError("busy", "SaveAllResources is busy: its port 4100 is in use (another capture is running, perhaps started outside Web).");
      const d = runDir(spec.runId);
      mkdirSync(d.out, { recursive: true });
      mkdirSync(d.data, { recursive: true });
      const env: Record<string, string> = { SAR_DATA_DIR: d.data };
      for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k]!;
      // Argument list, never a shell string; the URL is validated http(s), so it cannot read as an option.
      let args: string[];
      if (spec.download) {
        // Kept under its own (sanitised) name: SaveAllResources reads the site's host from it too.
        const input = join(d.dir, "input", spec.download.filename.replace(/[^A-Za-z0-9._() -]/g, "_").replace(/^[.-]+/, "").slice(0, 120) || "download.zip");
        mkdirSync(join(d.dir, "input"), { recursive: true });
        writeFileSync(input, spec.download.bytes);
        args = [inst.cli, "--import", input, "--entry-url", spec.url, "--out", d.out];
      } else {
        args = [inst.cli, spec.url, "--max-pages", String(spec.options.maxPages), "--max-depth", String(spec.options.maxDepth), "--max-minutes", String(spec.options.maxMinutes), "--out", d.out];
      }
      const child = spawn(cfg.nodePath ?? process.execPath, args, { cwd: inst.home, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false, windowsHide: true });
      const a: Active = { child, pid: child.pid ?? -1, cancelRequested: false, timedOut: false, timers: [], sarJobId: null, lastProgress: "", tail: [] };
      active.set(spec.runId, a);
      let logged = 0;
      const onOutput = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (logged < 1_000_000) {
          appendFileSync(d.log, text);
          logged += text.length;
        }
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          a.tail.push(line);
          if (a.tail.length > 40) a.tail.shift();
          const m = /^Job (\S+)$/.exec(line.trim());
          if (m && RUN_ID.test(m[1])) a.sarJobId = m[1];
        }
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      const timeout = setTimeout(() => {
        a.timedOut = true;
        signal(a, "SIGINT");
        a.timers.push(setTimeout(() => signal(a, "SIGKILL", true), killGraceMs));
      }, timeoutOf(spec.options));
      a.timers.push(timeout);
      watch(spec.runId, a, handlers);

      return new Promise((resolveStart, rejectStart) => {
        let started = false;
        child.once("spawn", () => {
          started = true;
          resolveStart({ pid: child.pid ?? null });
        });
        child.once("error", (e) => {
          if (!started) {
            a.timers.forEach(clearTimeout);
            active.delete(spec.runId);
            rejectStart(new RunnerError("unavailable", `SaveAllResources could not be started: ${e.message}`));
          }
        });
        child.once("close", (code) => {
          a.timers.forEach((t) => clearTimeout(t));
          const last = readProgress(spec.runId, a);
          if (last) handlers.onProgress(last);
          active.delete(spec.runId);
          if (!started) return;
          let outcome: RunOutcome;
          if (a.cancelRequested) outcome = { kind: "cancelled", sarJobId: a.sarJobId };
          else if (a.timedOut) outcome = { kind: "failed", sarJobId: a.sarJobId, code: "timeout", message: `SaveAllResources did not finish within the time limit (${Math.round(timeoutOf(spec.options) / 60_000)} minutes).` };
          else if (code === 0) outcome = succeededOrMissing(spec.runId, a.sarJobId);
          else if (code === 130) outcome = { kind: "failed", sarJobId: a.sarJobId, code: "stopped_outside_web", message: "SaveAllResources was stopped outside Web." };
          else {
            const reason = a.tail.filter((l) => /^(error:|Error|Invalid job|Cannot listen|The extension)/.test(l.trim())).slice(-3).join(" ") || a.tail.slice(-2).join(" ");
            outcome = { kind: "failed", sarJobId: a.sarJobId, code: "sar_failed", message: sanitize(`SaveAllResources failed (exit ${code ?? "signal"}). ${reason}`, spec.runId) };
          }
          handlers.onExit(outcome);
        });
      });
    },

    cancel(runId) {
      const a = active.get(runId);
      if (!a) return false;
      a.cancelRequested = true;
      // SaveAllResources' own graceful cancel; the whole process group is killed only if it does not stop.
      signal(a, "SIGINT");
      a.timers.push(setTimeout(() => signal(a, "SIGKILL", true), killGraceMs));
      return true;
    },

    isRunning: (runId) => active.has(runId),

    reattach(runId, pid, handlers) {
      if (active.has(runId)) return true;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (!alive) return false;
      // Only follow the process if it is really this run's SaveAllResources command.
      const cmd = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
      if (!install.ok || !cmd.includes(install.cli) || !cmd.includes(runDir(runId).out)) return false;
      const a: Active = { child: null, pid, cancelRequested: false, timedOut: false, timers: [], sarJobId: null, lastProgress: "", tail: [] };
      active.set(runId, a);
      watch(runId, a, handlers);
      const check = setInterval(() => {
        try {
          process.kill(pid, 0);
          return;
        } catch {
          /* ended */
        }
        a.timers.forEach((t) => clearTimeout(t));
        active.delete(runId);
        // Not our child: no exit code. Judge by what SaveAllResources recorded and wrote.
        const jobs = join(runDir(runId).data, "jobs");
        let status: string | null = null;
        try {
          const id = a.sarJobId ?? readdirSync(jobs)[0];
          status = parseSarJob(JSON.parse(readFileSync(join(jobs, id, "job.json"), "utf8"))).status;
        } catch {
          status = null;
        }
        if (a.cancelRequested || status === "cancelled") handlers.onExit({ kind: "cancelled", sarJobId: a.sarJobId });
        else if (status === "completed" || status === "completed_with_warnings") handlers.onExit(succeededOrMissing(runId, a.sarJobId));
        else handlers.onExit({ kind: "failed", sarJobId: a.sarJobId, code: "interrupted", message: "The run ended while Web was restarting, without a usable result." });
      }, pollMs);
      a.timers.push(check);
      return true;
    },

    discardWorkingData(runId) {
      rmSync(runDir(runId).data, { recursive: true, force: true });
    },

    prune(keep, olderThanMs) {
      const root = resolve(cfg.runsDir);
      if (!existsSync(root)) return 0;
      let n = 0;
      for (const name of readdirSync(root)) {
        if (!RUN_ID.test(name) || keep.has(name) || active.has(name)) continue;
        const dir = join(root, name);
        if (Date.now() - statSync(dir).mtimeMs > olderThanMs) {
          rmSync(dir, { recursive: true, force: true });
          n++;
        }
      }
      return n;
    },
  };
  return self;
}

// When SaveAllResources is not configured: the feature is off, with the reason.
export function unavailableRunner(reason: string): TemplateRunner {
  const no = () => {
    throw new RunnerError("unavailable", reason);
  };
  return { mode: "unavailable", availability: () => ({ ok: false, reason }), importAvailability: () => ({ ok: false, reason }), start: async () => no(), cancel: () => false, isRunning: () => false, reattach: () => false, discardWorkingData: () => {}, prune: () => 0 };
}

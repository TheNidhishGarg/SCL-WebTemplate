import { readFileSync } from "node:fs";
import { normaliseReferenceUrl, MAX_CAPTURE_BYTES } from "@/domain/reference";
import { readSaveAllResourcesExport, sarCaptureMeta, sarSourceRegistration, type SarExport } from "@/server/integrations/save-all-resources";
import { RunnerError, type RunOptions, type RunOutcome, type RunProgress, type TemplateRunner } from "@/server/integrations/sar-runner";
import { now, StoreError } from "@/server/store/errors";
import type { Store } from "@/server/store/store";
import { STAGE_KEYS, type JobStatus, type Stage, type StageKey, type TemplateJob } from "@/server/store/template-jobs";

// Website-template pipeline: URL -> SaveAllResources (separate process, via a
// TemplateRunner) -> website-template.zip stored as an artifact -> WF-02
// capture -> WF-03 source and analysis -> WF-04 and WF-05 under their
// existing gates. It only orchestrates: every workflow step is an existing
// store function, called with the same inputs a person would give it.
//
// Every step is idempotent (it checks what the job already recorded), so a
// retry, a resumed gate or a restart never registers anything twice.

// Size limits. The product limit is MAX_CAPTURE_BYTES (200 MB, inclusive):
// a generated website-template.zip up to that size goes through WF-02 and
// WF-03. A bigger one is still stored for diagnosis and download (up to a
// retention ceiling derived from the same constant) but blocked from WF-02,
// never registered in part.
export const MAX_TEMPLATE_ARTIFACT_BYTES = Math.floor(2.5 * MAX_CAPTURE_BYTES);
export const WF02_CAPTURE_LIMIT_BYTES = MAX_CAPTURE_BYTES;
export const fitsWf02 = (bytes: number, limit = WF02_CAPTURE_LIMIT_BYTES) => bytes <= limit; // same rule as references.addCapture

export const RUN_RETENTION_MS = 7 * 24 * 3600_000;
const MAX_PAGES_LIMIT = 100;

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

type Deps = {
  store: Pick<Store, "references" | "sources" | "brands" | "content" | "getProject" | "templateJobs" | "logActivity">;
  runner: TemplateRunner;
  defaults: RunOptions;
  limits?: { artifactBytes?: number; wf02Bytes?: number };
  retentionMs?: number;
  log?: (message: string, e?: unknown) => void;
};

export function createTemplatePipeline(deps: Deps) {
  const { store, runner } = deps;
  const jobs = store.templateJobs;
  const artifactLimit = deps.limits?.artifactBytes ?? MAX_TEMPLATE_ARTIFACT_BYTES;
  const wf02Limit = deps.limits?.wf02Bytes ?? WF02_CAPTURE_LIMIT_BYTES;
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[template-pipeline] ${m}`, e ?? ""));
  // Notified when a job reaches an end state (tests, and the UI's server rendering).
  const settled = new Map<string, ((j: TemplateJob) => void)[]>();

  const fresh = (id: string) => jobs.byId(id)!;
  const setStage = (id: string, key: StageKey, patch: Partial<Stage>) => {
    const j = fresh(id);
    const cur = j.stages[key];
    const next: Stage = { ...cur, ...patch };
    if (patch.status === "running" && !cur.startedAt) next.startedAt = now();
    if (patch.status && ["done", "failed", "blocked", "cancelled"].includes(patch.status)) next.completedAt = now();
    jobs.update(id, { stages: { ...j.stages, [key]: next } });
  };

  // The job's overall state, from its stages (a state machine, not scattered flags).
  const derive = (j: TemplateJob): JobStatus => {
    const st = STAGE_KEYS.map((k) => j.stages[k].status);
    if (st.includes("cancelled")) return "cancelled";
    if (st.includes("failed")) return "failed";
    if (j.locked) return j.startedAt ? "running" : "queued";
    if (st.includes("running") || st.includes("pending")) return st.includes("blocked") ? "blocked" : "running";
    if (st.includes("blocked")) return "blocked";
    if (st.includes("waiting")) return "waiting";
    return "completed";
  };
  const settle = (id: string) => {
    const j = fresh(id);
    const status = derive(j);
    jobs.update(id, { status, completed_at: ["completed", "waiting", "blocked", "failed", "cancelled"].includes(status) ? (j.completedAt ?? now()) : null });
    if (!["queued", "running"].includes(status)) {
      const list = settled.get(id) ?? [];
      settled.delete(id);
      list.forEach((fn) => fn(fresh(id)));
    }
  };
  const fail = (id: string, key: StageKey, code: string, message: string) => {
    setStage(id, key, { status: "failed", error: message });
    jobs.update(id, { error_code: code, error_message: message });
    settle(id);
  };

  // ---------------------------------------------------------- the SAR stage

  const handlers = (id: string) => ({
    onProgress: (p: RunProgress) => {
      const j = jobs.byId(id);
      if (!j || !j.locked) return;
      jobs.update(id, { stage: p.stage, progress: p.pages, ...(p.sarJobId ? { sar_job_id: p.sarJobId } : {}) });
      setStage(id, "sar", { status: "running", detail: p.stage });
    },
    onExit: (o: RunOutcome) => {
      try {
        finishRun(id, o);
      } catch (e) {
        log(`finishing ${id} failed`, e);
        if (jobs.byId(id)) fail(id, "artifact", "internal", "Web could not finish handling the generated template. Retry, or generate again.");
      }
    },
  });

  const finishRun = (id: string, o: RunOutcome) => {
    const j = jobs.byId(id);
    if (!j) return; // project deleted meanwhile
    jobs.update(id, { run_lock: null, sar_job_id: o.sarJobId ?? j.sarJobId, stage: o.kind === "succeeded" ? "artifact" : o.kind });
    if (o.kind === "cancelled") {
      // Only now, after the process ended: cancelled jobs never reach WF-02/WF-03.
      jobs.update(id, { cancelled_at: now() });
      setStage(id, "sar", { status: "cancelled", detail: "Cancelled; nothing was registered." });
      settle(id);
      return;
    }
    if (o.kind === "failed") return fail(id, "sar", o.code, o.message);
    setStage(id, "sar", { status: "done", detail: "Website captured and reconstructed" });
    jobs.update(id, { sar_output_sha256: o.zipSha256 });
    handoff(id, o.zipPath, o.zipBytes, o.zipSha256);
  };

  // ------------------------------------------------------ artifact handoff

  const handoff = (id: string, zipPath: string, zipBytes: number, zipSha256: string) => {
    setStage(id, "artifact", { status: "running" });
    if (zipBytes > artifactLimit) return fail(id, "artifact", "artifact_too_large", `The generated ZIP is ${mb(zipBytes)}; Web keeps artifacts up to ${mb(artifactLimit)}. It was not stored.`);
    const bytes = new Uint8Array(readFileSync(zipPath));
    try {
      readSaveAllResourcesExport(bytes); // the existing importer's validation
    } catch (e) {
      if ((e as Error).name !== "StoreError") throw e;
      return fail(id, "artifact", "invalid_zip", `The generated ZIP is not a usable SaveAllResources template: ${(e as Error).message}`);
    }
    const j = jobs.storeArtifact(fresh(id), zipPath.split(/[\\/]/).pop()!, bytes);
    if (j.artifact!.sha256 !== zipSha256) return fail(id, "artifact", "artifact_mismatch", "The stored artifact does not match the file SaveAllResources produced.");
    setStage(id, "artifact", { status: "done", detail: `${mb(j.artifact!.bytes)} · SHA-256 ${j.artifact!.sha256.slice(0, 12)}…` });
    store.logActivity(j.projectId, "template_generated", `Website template generated from ${j.sourceUrl} (${mb(j.artifact!.bytes)})`);
    try {
      runner.discardWorkingData(id); // the bulky SaveAllResources working folder; the log and ZIP copy stay until pruned
    } catch (e) {
      log(`cleanup of ${id} failed`, e);
    }
    advance(id);
  };

  // ------------------------------------------------ WF-02 .. WF-05 (gated)

  const advance = (id: string): TemplateJob => {
    let j = fresh(id);
    if (!j.artifact || j.status === "cancelled" || j.stages.sar.status !== "done") return j;
    const p = j.projectId;
    const run = <T>(key: StageKey, fn: () => T): T | null => {
      try {
        return fn();
      } catch (e) {
        if ((e as Error).name !== "StoreError") throw e;
        fail(id, key, "workflow_refused", (e as Error).message);
        return null;
      }
    };
    jobs.update(id, { error_code: null, error_message: null });
    let x: SarExport | null = null;
    const exportOf = () => (x ??= readSaveAllResourcesExport(jobs.readArtifact(fresh(id))));

    // WF-02: reference + capture of the exact stored ZIP.
    if (!j.captureId) {
      if (!fitsWf02(j.artifact.bytes, wf02Limit)) {
        setStage(id, "wf02", {
          status: "blocked",
          error: `Artifact too large for WF-02: ${mb(j.artifact.bytes)} (${j.artifact.bytes} bytes); WF-02 accepts captures up to ${mb(wf02Limit)} (${wf02Limit} bytes). The ZIP is kept and can be downloaded; nothing was registered.`,
        });
        jobs.update(id, { error_code: "artifact_too_large_for_wf02", error_message: "Artifact too large for WF-02." });
        settle(id);
        return fresh(id);
      }
      setStage(id, "wf02", { status: "running" });
      const ok = run("wf02", () => {
        const url = normaliseReferenceUrl(j.sourceUrl)!;
        const ref = store.references.list(p).find((v) => v.reference.url === url)?.reference ?? store.references.add(p, { url, label: "", pageType: "" });
        const existing = store.references.get(p, ref.id).captures.find((c) => c.file.sha256 === j.artifact!.sha256);
        const capture = existing ?? store.references.addCapture(p, ref.id, sarCaptureMeta(exportOf()), { filename: j.artifact!.filename, mimeType: "application/zip", bytes: jobs.readArtifact(j) });
        jobs.update(id, { reference_id: ref.id, capture_id: capture.id });
        return true;
      });
      if (!ok) return fresh(id);
      setStage(id, "wf02", { status: "done", detail: "Reference and SaveAllResources capture registered" });
      j = fresh(id);
    }

    // WF-03: source (authority as declared) + analysis.
    if (!j.sourceId) {
      setStage(id, "wf03", { status: "running" });
      const ok = run("wf03", () => {
        const already = store.sources.list(p).find((s) => s.source.archive.sha256 === j.artifact!.sha256);
        const auth = j.authority === "client_owned" ? { basis: "client_owned" as const, note: j.authorizedBy, license: "" } : undefined;
        const source = already?.source ?? store.sources.registerFromCapture(p, j.referenceId!, j.captureId!, sarSourceRegistration(exportOf(), auth));
        jobs.update(id, { source_id: source.id });
        return true;
      });
      if (!ok) return fresh(id);
      j = fresh(id);
    }
    if (!j.scanId) {
      setStage(id, "wf03", { status: "running" });
      const scan = run("wf03", () => store.sources.runScan(p, j.sourceId!));
      if (!scan) return fresh(id);
      jobs.update(id, { scan_id: scan.id, scan_digest: scan.digest });
      setStage(id, "wf03", { status: "done", detail: `Analysis complete · digest ${scan.digest.slice(0, 12)}…` });
      j = fresh(id);
    }

    // WF-04: only from a client-owned source (WF-03's existing rule). Read
    // the source's authority now: a person may have changed it since.
    const basis = run("wf04", () => store.sources.get(p, j.sourceId!).source.authorization.basis);
    if (basis === null) return fresh(id);
    if (basis !== "client_owned") {
      setStage(id, "wf04", { status: "waiting", detail: "Waiting for client-owned authority: brand suggestions only come from the client's own sources." });
    } else if (!j.brandId) {
      setStage(id, "wf04", { status: "running" });
      const res = run("wf04", () => {
        const site = store.content.site(p).brandId;
        const brands = store.brands.list(p);
        const brand = brands.find((b) => b.brand.id === site)?.brand ?? brands[0]?.brand ?? store.brands.create(p, { name: `${new URL(j.sourceUrl).hostname}`.slice(0, 80) });
        const latest = store.brands.get(p, brand.id).latest;
        // Suggestions only fill fields that are still open; nothing is approved here.
        const applied = latest.status === "draft" ? store.brands.suggest(p, brand.id, latest.id).applied.length : null;
        jobs.update(id, { brand_id: brand.id });
        return { applied };
      });
      if (!res) return fresh(id);
      setStage(id, "wf04", {
        status: "done",
        detail: res.applied === null ? "The brand's latest version is approved; suggestions apply to its next draft." : `Brand draft prepared (${res.applied} suggestion${res.applied === 1 ? "" : "s"} applied). Approval stays with a person.`,
      });
    }
    j = fresh(id);
    if (j.stages.wf04.status === "failed") return j;

    // WF-05: page drafts only from an approved brief; publishing stays with people.
    const approved = store.getProject(p)?.approved?.content;
    if (!approved) {
      setStage(id, "wf05", { status: "waiting", detail: "Waiting for brief approval: page drafts are generated from the approved brief." });
    } else if (!j.pagesGenerated) {
      setStage(id, "wf05", { status: "running" });
      const r = run("wf05", () => store.content.generateFromBrief(p));
      if (!r) return fresh(id);
      jobs.update(id, { pages_generated: true });
      setStage(id, "wf05", { status: "done", detail: `${r.created} page draft(s) created${r.skipped ? `, ${r.skipped} already existed` : ""}. Writing, review and publishing stay with people.` });
    }
    settle(id);
    return fresh(id);
  };

  // ------------------------------------------------------------- public API

  const self = {
    availability: () => runner.availability(),

    async start(projectId: string, input: { url: unknown; authority: unknown; authorizedBy?: unknown; maxPages?: unknown; maxDepth?: unknown }): Promise<TemplateJob> {
      const raw = typeof input.url === "string" ? input.url.trim() : "";
      const url = raw.length <= 2000 ? normaliseReferenceUrl(raw) : null;
      if (!url || !new URL(url).hostname) throw new StoreError("invalid", "Enter a full http(s) website URL without a username or password.", [{ path: "url", message: "Enter a full http(s) URL" }]);
      const authority = input.authority === "client_owned" ? "client_owned" : input.authority === "study_only" || input.authority === undefined ? "study_only" : null;
      if (!authority) throw new StoreError("invalid", "Choose the source authority.", [{ path: "authority", message: "Choose one" }]);
      const authorizedBy = typeof input.authorizedBy === "string" ? input.authorizedBy.trim().slice(0, 1000) : "";
      // Ownership is never inferred from a URL: it must be declared, with who authorised it (WF-03's rule).
      if (authority === "client_owned" && !authorizedBy) throw new StoreError("invalid", "Say who authorised use of this client-owned site.", [{ path: "authorizedBy", message: "Required for client-owned" }]);
      const int = (v: unknown, def: number, min: number, max: number) => {
        if (v === undefined || v === null || v === "") return def;
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) throw new StoreError("invalid", `Choose a value between ${min} and ${max}.`, [{ path: "options", message: "Out of range" }]);
        return n;
      };
      const options = { maxPages: int(input.maxPages, deps.defaults.maxPages, 1, MAX_PAGES_LIMIT), maxDepth: int(input.maxDepth, deps.defaults.maxDepth, 0, 10), maxMinutes: deps.defaults.maxMinutes };
      const avail = runner.availability();
      if (!avail.ok) throw new StoreError("conflict", avail.reason);
      self.recover(); // never let a stale lock block a new run
      const job = jobs.createLocked(projectId, { sourceUrl: url, authority, authorizedBy, options });
      try {
        const { pid } = await runner.start({ runId: job.id, url, options }, handlers(job.id));
        jobs.update(job.id, { pid, started_at: now(), status: "running" });
        setStage(job.id, "sar", { status: "running", detail: "starting" });
        store.logActivity(projectId, "template_started", `Website template generation started: ${url}`);
      } catch (e) {
        const message = e instanceof RunnerError ? e.message : `SaveAllResources could not be started: ${(e as Error).message}`;
        jobs.update(job.id, { run_lock: null });
        fail(job.id, "sar", e instanceof RunnerError ? e.code : "spawn_failed", message);
        if (e instanceof RunnerError && e.code === "busy") throw new StoreError("conflict", message);
      }
      return fresh(job.id);
    },

    get: (projectId: string, id: string) => jobs.get(projectId, id),
    list: (projectId: string) => jobs.list(projectId),
    readArtifact: (projectId: string, id: string) => {
      const j = jobs.get(projectId, id);
      return { job: j, bytes: jobs.readArtifact(j) };
    },

    cancel(projectId: string, id: string): TemplateJob {
      const j = jobs.get(projectId, id);
      if (!j.locked) throw new StoreError("conflict", "This generation is no longer running, so it cannot be cancelled.");
      jobs.update(id, { cancel_requested: true });
      if (!runner.cancel(id)) {
        // Lock held but no process to stop (it ended unseen): close it as cancelled.
        finishRun(id, { kind: "cancelled", sarJobId: j.sarJobId });
      } else setStage(id, "sar", { status: "running", detail: "cancelling" });
      return fresh(id);
    },

    // Re-runs the registration stages (safe: each step checks what is done).
    retry(projectId: string, id: string): TemplateJob {
      const j = jobs.get(projectId, id);
      if (!j.artifact) throw new StoreError("conflict", "Nothing was generated to retry; start a new generation.");
      for (const k of ["wf02", "wf03", "wf04", "wf05"] as const) if (j.stages[k].status === "failed") setStage(id, k, { status: "pending", error: null });
      return advance(id);
    },

    // A gate may have opened (brief approved, authority changed): continue waiting jobs.
    advanceProject(projectId: string): void {
      for (const j of jobs.waitingIn(projectId)) {
        try {
          advance(j.id);
        } catch (e) {
          log(`advancing ${j.id} failed`, e);
        }
      }
    },

    // After a restart: follow runs whose process survived, end the rest, never leave a ghost.
    recover(): void {
      for (const j of jobs.lockHolders()) {
        if (runner.isRunning(j.id)) continue;
        if (j.pid && runner.reattach(j.id, j.pid, handlers(j.id))) continue;
        jobs.update(j.id, { run_lock: null });
        fail(j.id, "sar", "interrupted", "Web restarted while SaveAllResources was running, and the run could not be recovered. Nothing was registered; generate again.");
      }
      for (const j of jobs.unfinished()) {
        if (j.locked) continue;
        if (j.artifact) advance(j.id);
        else fail(j.id, "artifact", "interrupted", "Web stopped before the generated ZIP was stored. Nothing was registered; generate again.");
      }
      try {
        runner.prune(new Set(jobs.lockHolders().map((x) => x.id)), deps.retentionMs ?? RUN_RETENTION_MS);
      } catch (e) {
        log("pruning old runs failed", e);
      }
    },

    // Resolves when the job reaches an end state (for tests and scripts).
    whenSettled(id: string): Promise<TemplateJob> {
      const j = jobs.byId(id);
      if (j && !["queued", "running"].includes(j.status)) return Promise.resolve(j);
      return new Promise((res) => settled.set(id, [...(settled.get(id) ?? []), res]));
    },
  };
  return self;
}

export type TemplatePipeline = ReturnType<typeof createTemplatePipeline>;

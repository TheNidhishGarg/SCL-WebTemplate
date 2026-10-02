import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { completeConventionalDraft } from "@/domain/test-fixtures";
import { createLocalRunner } from "@/server/integrations/sar-runner";
import { makeStubSarHome, stubExport, stubExportOfSize } from "@/server/integrations/sar-test-stub";
import { openDatabase } from "@/server/store/db";
import { createStore, StoreError, type Store } from "@/server/store/store";
import { createTemplatePipeline, fitsWf02 } from "./template-pipeline";

// The URL -> SaveAllResources -> artifact -> WF-02 -> WF-03 -> WF-04/WF-05
// pipeline with the real store and runner, and a stub SaveAllResources
// installation (same command-line interface, no browser).

let dir: string;
let home: string;
let store: Store;
let dbFile: string;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function pipeline(over: Partial<Parameters<typeof createTemplatePipeline>[0]> = {}) {
  return createTemplatePipeline({
    store,
    runner: createLocalRunner({ home, runsDir: join(dir, "runs"), pollMs: 20, killGraceMs: 500, portInUse: async () => false }),
    defaults: { maxPages: 2, maxDepth: 1, maxMinutes: 1 },
    log: () => {},
    ...over,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-pipeline-"));
  home = makeStubSarHome(join(dir, "sar"), stubExport({ entryUrl: "http://ok.test/" }));
  dbFile = join(dir, "scl.sqlite");
  store = createStore(openDatabase(dbFile), join(dir, "uploads"), { checkUrl: async () => { throw new Error("no network in tests"); } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fails = async (p: Promise<unknown> | (() => unknown), code: string) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected StoreError");
};
const project = (name = "P") => store.createProject({ name, clientName: name });
const approveBrief = (projectId: string) => {
  const v1 = store.getProject(projectId)!.latest;
  store.saveDraft(projectId, v1.id, completeConventionalDraft());
  store.approveBrief(projectId, v1.id);
};

describe("generate a website template from a URL", () => {
  it("runs SaveAllResources, stores the exact ZIP, registers WF-02 and WF-03, and stops at the WF-04/WF-05 gates", async () => {
    const pl = pipeline();
    const p = project();
    const started = await pl.start(p.id, { url: "http://ok.test/", authority: "study_only" });
    expect(started).toMatchObject({ status: "running", locked: true, authority: "study_only" });
    const job = await pl.whenSettled(started.id);

    const fixture = readFileSync(join(home, "fixture.zip"));
    expect(job).toMatchObject({ status: "waiting", locked: false, error: null, sarOutputSha256: sha(fixture) });
    expect(job.sarJobId).toMatch(/^job_stub_/);
    expect(job.artifact).toMatchObject({ bytes: fixture.byteLength, sha256: sha(fixture) });
    expect(Buffer.from(pl.readArtifact(p.id, job.id).bytes)).toEqual(fixture); // byte for byte
    expect(Object.fromEntries(Object.entries(job.stages).map(([k, v]) => [k, v.status]))).toEqual({ sar: "done", artifact: "done", wf02: "done", wf03: "done", wf04: "waiting", wf05: "waiting" });
    expect(job.stages.wf04.detail).toMatch(/Waiting for client-owned authority/);
    expect(job.stages.wf05.detail).toMatch(/Waiting for brief approval/);

    // WF-02: the reference and a SaveAllResources capture of the same bytes.
    const ref = store.references.get(p.id, job.referenceId!);
    expect(ref.reference.url).toBe("http://ok.test/");
    expect(ref.captures).toHaveLength(1);
    expect(ref.captures[0]).toMatchObject({ id: job.captureId, tool: "SaveAllResources", file: { sha256: sha(fixture) } });
    expect(ref.captures[0].notes).toMatch(/job job_stub/);
    // WF-03: study-only source, analysed; the digest equals a manual import of the same ZIP.
    const src = store.sources.get(p.id, job.sourceId!);
    expect(src.source).toMatchObject({ authorization: { basis: "study_only" }, captureId: job.captureId, originRef: expect.stringMatching(/^saveallresources:job=/) });
    expect(src.latest!.scan.id).toBe(job.scanId);
    const other = project("Manual");
    const manual = store.sources.registerUpload(other.id, { label: "Manual", originUrl: "", originRef: "", authorization: { basis: "study_only", note: "", license: "" } }, { filename: "x.zip", bytes: new Uint8Array(fixture) });
    expect(store.sources.runScan(other.id, manual.id).digest).toBe(job.scanDigest);
    // Gates hold: no brand from a study-only source, no pages without an approved brief.
    expect(store.brands.list(p.id)).toHaveLength(0);
    expect(store.content.pages(p.id)).toHaveLength(0);
    // Study only: extraction stays refused.
    const cand = src.latest!.analysis.templateCandidates[0];
    if (cand) await fails(() => store.sources.extractTemplate(p.id, store.sources.acceptCandidate(p.id, job.sourceId!, cand.key).id), "conflict");

    // Retrying and re-advancing never duplicates anything.
    pl.retry(p.id, job.id);
    pl.advanceProject(p.id);
    expect(store.references.get(p.id, job.referenceId!).captures).toHaveLength(1);
    expect(store.sources.list(p.id)).toHaveLength(1);

    // Gates opening later: approve the brief -> WF-05; raise authority -> WF-04.
    approveBrief(p.id);
    pl.advanceProject(p.id);
    let now = pl.get(p.id, job.id);
    expect(now.stages.wf05).toMatchObject({ status: "done", detail: expect.stringMatching(/page draft\(s\) created/) });
    expect(store.content.pages(p.id).length).toBeGreaterThan(0);
    expect(store.content.pages(p.id).every((pg) => pg.status === "draft")).toBe(true); // never published
    expect(now.status).toBe("waiting");
    store.sources.updateAuthorization(p.id, job.sourceId!, { basis: "client_owned", note: "Client confirmed ownership in writing on 2026-10-01.", license: "" });
    pl.advanceProject(p.id);
    now = pl.get(p.id, job.id);
    expect(now).toMatchObject({ status: "completed", stages: { wf04: { status: "done" } } });
    const brand = store.brands.get(p.id, now.brandId!);
    expect(brand.approved).toBeNull(); // prepared, never approved by the pipeline
    pl.advanceProject(p.id);
    expect(store.brands.list(p.id)).toHaveLength(1);
  });

  it("client-owned must be declared with who authorised it; then WF-04 prepares a brand draft", async () => {
    const pl = pipeline();
    const p = project();
    await fails(pl.start(p.id, { url: "http://ok.test/", authority: "client_owned" }), "invalid");
    const job = await pl.whenSettled((await pl.start(p.id, { url: "http://ok.test/", authority: "client_owned", authorizedBy: "Jane Doe, client CTO, email 2026-10-01" })).id);
    expect(store.sources.get(p.id, job.sourceId!).source.authorization).toMatchObject({ basis: "client_owned", note: "Jane Doe, client CTO, email 2026-10-01" });
    expect(job.stages.wf04).toMatchObject({ status: "done", detail: expect.stringMatching(/Brand draft prepared/) });
    expect(store.brands.get(p.id, job.brandId!).latest.status).toBe("draft");
    expect(job.stages.wf05.status).toBe("waiting");
  });

  it("refuses unsafe or malformed URLs before anything runs", async () => {
    const pl = pipeline();
    const p = project();
    for (const url of ["javascript:alert(1)", "ftp://x.test/", "http://", "not a url", "http://user:pw@x.test/", `http://x.test/${"a".repeat(2100)}`, "--help"]) await fails(pl.start(p.id, { url, authority: "study_only" }), "invalid");
    await fails(pl.start(p.id, { url: "http://ok.test/", authority: "owner" }), "invalid");
    await fails(pl.start(p.id, { url: "http://ok.test/", authority: "study_only", maxPages: 0 }), "invalid");
    expect(pl.list(p.id)).toHaveLength(0);
  });

  it("failures register nothing and release the lock: SaveAllResources fails, no ZIP, malformed ZIP", async () => {
    const pl = pipeline();
    const p = project();
    const f = await pl.whenSettled((await pl.start(p.id, { url: "http://fail.test/", authority: "study_only" })).id);
    expect(f).toMatchObject({ status: "failed", locked: false, error: { code: "sar_failed" }, artifact: null, captureId: null });
    expect(f.stages.sar.error).toMatch(/navigation to the site failed/);
    const n = await pl.whenSettled((await pl.start(p.id, { url: "http://nozip.test/", authority: "study_only" })).id);
    expect(n).toMatchObject({ status: "failed", error: { code: "missing_zip" } });
    writeFileSync(join(home, "fixture.zip"), "this is not a zip");
    const m = await pl.whenSettled((await pl.start(p.id, { url: "http://ok.test/", authority: "study_only" })).id);
    expect(m).toMatchObject({ status: "failed", error: { code: "invalid_zip" }, artifact: null });
    expect(store.references.list(p.id)).toHaveLength(0);
    expect(store.sources.list(p.id)).toHaveLength(0);
  });

  it("cancels gracefully: running until the process has ended, then cancelled, and nothing registered", async () => {
    const pl = pipeline();
    const p = project();
    const job = await pl.start(p.id, { url: "http://slow.test/", authority: "study_only" });
    await new Promise((r) => setTimeout(r, 200));
    expect(pl.get(p.id, job.id).progress).toMatchObject({ discovered: 3, captured: 1 }); // real numbers, never invented
    // Another project cannot see or cancel it.
    const q = project("Q");
    await fails(() => pl.cancel(q.id, job.id), "not_found");
    const c = pl.cancel(p.id, job.id);
    expect(c.status).toBe("running");
    const done = await pl.whenSettled(job.id);
    expect(done).toMatchObject({ status: "cancelled", locked: false, captureId: null, sourceId: null, artifact: null });
    expect(done.cancelledAt).not.toBeNull();
    expect(store.references.list(p.id)).toHaveLength(0);
    await fails(() => pl.cancel(p.id, job.id), "conflict");
  });

  it("one SaveAllResources run at a time, held in the database; a dead run is recovered, never a ghost", async () => {
    const pl = pipeline();
    const p = project();
    const q = project("Q");
    const running = await pl.start(p.id, { url: "http://slow.test/", authority: "study_only" });
    const e = await fails(pl.start(q.id, { url: "http://ok.test/", authority: "study_only" }), "conflict");
    expect(e.message).toMatch(/SaveAllResources is busy/);
    pl.cancel(p.id, running.id);
    await pl.whenSettled(running.id);

    // A restart: a row still holds the lock, its process is gone.
    const ghost = store.templateJobs.createLocked(p.id, { sourceUrl: "http://ok.test/", authority: "study_only", authorizedBy: "", options: { maxPages: 1, maxDepth: 0, maxMinutes: 1 } });
    store.templateJobs.update(ghost.id, { pid: 999_999, status: "running", started_at: new Date().toISOString() });
    const afterRestart = pipeline();
    afterRestart.recover();
    expect(afterRestart.get(p.id, ghost.id)).toMatchObject({ status: "failed", locked: false, error: { code: "interrupted" } });
    const next = await afterRestart.whenSettled((await afterRestart.start(p.id, { url: "http://ok.test/", authority: "study_only" })).id);
    expect(next.status).toBe("waiting");

    // A restart after the ZIP was stored but before registration finished: resumed, not duplicated.
    store.templateJobs.update(next.id, { status: "running", capture_id: null, source_id: null, scan_id: null });
    pipeline().recover();
    const resumed = afterRestart.get(p.id, next.id);
    expect(resumed.status).toBe("waiting");
    expect(store.references.list(p.id).flatMap((v) => v.captures)).toHaveLength(1);
    expect(store.sources.list(p.id)).toHaveLength(1);
  });
});

describe("artifact size and the WF-02 limit", () => {
  it("uses WF-02's own rule: up to and including the limit", () => {
    expect(fitsWf02(MAX_CAPTURE_BYTES - 1)).toBe(true);
    expect(fitsWf02(MAX_CAPTURE_BYTES)).toBe(true);
    expect(fitsWf02(MAX_CAPTURE_BYTES + 1)).toBe(false);
  });

  it("accepts a normal 49 MB template, a realistic 150 MB one and exactly 200 MB through WF-02 and WF-03; 200 MB + 1 byte is kept but blocked", async () => {
    const pl = pipeline();
    for (const [size, expected] of [
      [49 * 1024 * 1024, "done"], // a typical SaveAllResources template (a real one-page site was 42.5 MB)
      [150 * 1024 * 1024, "done"], // realistic large template: no other hidden limit in WF-02/WF-03
      [MAX_CAPTURE_BYTES, "done"], // inclusive
      [MAX_CAPTURE_BYTES + 1, "blocked"],
    ] as const) {
      const p = project(`Size ${size}`);
      writeFileSync(join(home, "fixture.zip"), stubExportOfSize(size, "http://ok.test/"));
      const job = await pl.whenSettled((await pl.start(p.id, { url: "http://ok.test/", authority: "study_only" })).id);
      expect(job.artifact!.bytes).toBe(size);
      expect(job.artifact!.sha256).toBe(job.sarOutputSha256);
      expect(job.stages.wf02.status).toBe(expected);
      if (expected === "blocked") {
        expect(job.status).toBe("blocked");
        expect(job.stages.wf02.error).toBe(`Artifact too large for WF-02: 200.0 MB (${size} bytes); WF-02 accepts captures up to 200.0 MB (${MAX_CAPTURE_BYTES} bytes). The ZIP is kept and can be downloaded; nothing was registered.`);
        expect(store.references.list(p.id)).toHaveLength(0);
        expect(store.sources.list(p.id)).toHaveLength(0);
        expect(store.templateJobs.readArtifact(job).byteLength).toBe(size);
      } else {
        // WF-02 holds the capture, WF-03 registered and analysed it: no hidden size limit in between.
        expect(store.references.get(p.id, job.referenceId!).captures[0].file.sizeBytes).toBe(size);
        expect(job.stages.wf03.status).toBe("done");
        expect(store.sources.get(p.id, job.sourceId!).source.archive.sizeBytes).toBe(size);
        expect(job.scanDigest).toMatch(/^[0-9a-f]{64}$/);
      }
      // Cleanup: SaveAllResources' working data goes; the log and its ZIP stay for diagnosis.
      expect(existsSync(join(dir, "runs", job.id, "sar-data"))).toBe(false);
      expect(existsSync(join(dir, "runs", job.id, "sar.log"))).toBe(true);
    }
  }, 300_000);

  it("a large malformed ZIP fails without storing anything, and keeps its run folder for diagnosis until pruned", async () => {
    const pl = pipeline();
    const p = project();
    const junk = new Uint8Array(120 * 1024 * 1024);
    junk.set([0x50, 0x4b, 0x03, 0x04]);
    writeFileSync(join(home, "fixture.zip"), junk);
    const job = await pl.whenSettled((await pl.start(p.id, { url: "http://ok.test/", authority: "study_only" })).id);
    expect(job).toMatchObject({ status: "failed", error: { code: "invalid_zip" }, artifact: null, captureId: null });
    expect(existsSync(join(dir, "runs", job.id, "out"))).toBe(true);
    expect(store.references.list(p.id)).toHaveLength(0);
  }, 120_000);

  it("refuses to store an artifact over the artifact limit", async () => {
    const pl = pipeline({ limits: { artifactBytes: 1000 } });
    const p = project();
    const job = await pl.whenSettled((await pl.start(p.id, { url: "http://ok.test/", authority: "study_only" })).id);
    expect(job).toMatchObject({ status: "failed", error: { code: "artifact_too_large" }, artifact: null });
  });
});

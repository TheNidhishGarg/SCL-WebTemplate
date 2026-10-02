import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetManifest, MAX_ATTEMPTS } from "@/domain/production";
import { synthMp4 } from "@/server/production/media";
import { ProviderError, type PollResult, type ProviderRegistry, type VideoProvider } from "@/server/production/providers";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

// A scripted provider: each call takes the next scripted outcome. No network.
type Script = { submit: (() => string)[]; poll: (() => PollResult)[]; download: (() => Uint8Array)[] };
function fakeProvider(id: "runway" | "veo", configured = true): VideoProvider & { script: Script; submitted: number } {
  const script: Script = { submit: [], poll: [], download: [] };
  const take = <T>(q: (() => T)[], what: string) => {
    const next = q.shift();
    if (!next) throw new Error(`Unscripted ${what}`);
    return next();
  };
  const p = {
    id,
    configured,
    missingConfig: configured ? [] : [id === "runway" ? "RUNWAYML_API_SECRET" : "GEMINI_API_KEY"],
    capabilities: { aspectRatios: ["16:9"], durations: "any", inputs: "text", notes: [] },
    script,
    submitted: 0,
    build: (spec: { prompt: string; durationSeconds: number }) => ({ ok: true as const, model: `${id}-test`, endpoint: `https://${id}.invalid/generate`, body: { prompt: spec.prompt, duration: spec.durationSeconds }, notes: [] }),
    async submit() {
      p.submitted++;
      return { providerJobId: take(script.submit, "submit") };
    },
    async poll() {
      return take(script.poll, "poll");
    },
    async download() {
      return take(script.download, "download");
    },
  };
  return p;
}

let dir: string;
let store: Store;
let runway: ReturnType<typeof fakeProvider>;
let veo: ReturnType<typeof fakeProvider>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-production-"));
  runway = fakeProvider("runway");
  veo = fakeProvider("veo", false);
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), { checkUrl: async () => { throw new Error("offline"); }, providers: { runway, veo } as ProviderRegistry });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected StoreError");
}

function setup() {
  const p = store.createProject({ name: "P", clientName: "P" });
  const j = store.journeys.create(p.id, { name: "Visit", start: "sample" });
  store.journeys.approve(p.id, j.id, store.journeys.get(p.id, j.id).latest.id);
  const productionId = store.production.start(p.id, j.id);
  const { shots } = store.production.get(p.id, productionId);
  const loop = shots.find((s) => s.slot.kind === "loop")!; // 6s, seamless loop
  const opening = shots[0]; // 12s
  return { p, j, productionId, shots, loop, opening };
}

const good = (seconds: number) => synthMp4({ durationSeconds: seconds, width: 1280, height: 720 });
const confirmAll = { plays: true, noText: true, loop: true };

describe("production", () => {
  it("starts one production per approved journey version, one shot per slot with prompt v1", async () => {
    const { p, j, shots } = setup();
    expect(shots).toHaveLength(6);
    expect(shots.every((s) => s.status === "pending" && s.prompts[0].version === 1)).toBe(true);
    expect(shots[0].prompts[0].negative).toMatch(/text/i);
    await rejects(() => store.production.start(p.id, j.id), "conflict");
    const draft = store.journeys.create(p.id, { name: "Draft", start: "branching" });
    await rejects(() => store.production.start(p.id, draft.id), "not_found");
  });

  it("success: generate → running → succeeded → stored, checked take → approved", async () => {
    const { p, productionId, loop } = setup();
    runway.script.submit.push(() => "task-1");
    runway.script.poll.push(() => ({ state: "running", progress: 0.5 }), () => ({ state: "succeeded", outputUrl: "https://runway.invalid/out.mp4" }));
    runway.script.download.push(() => good(6));

    const job = await store.production.generate(p.id, productionId, loop.slotId, "runway");
    expect(job).toMatchObject({ status: "generating", providerJobId: "task-1", attempts: 1, promptVersion: 1, model: "runway-test" });
    expect(store.production.get(p.id, productionId).shots.find((s) => s.slotId === loop.slotId)!.status).toBe("generating");
    expect(await store.production.poll(p.id, productionId, job.id)).toMatchObject({ status: "generating", takeId: null });
    const done = await store.production.poll(p.id, productionId, job.id);
    expect(done).toMatchObject({ status: "completed" });
    expect(done.takeId).toBeTruthy();

    let shot = store.production.get(p.id, productionId).shots.find((s) => s.slotId === loop.slotId)!;
    expect(shot.status).toBe("review_required");
    const take = shot.takes[0];
    expect(take).toMatchObject({ source: "provider", provider: "runway", promptVersion: 1, passed: true, media: { durationSeconds: 6, width: 1280, height: 720 } });

    // Approval needs a person's confirmation of what no check can see.
    const e = await rejects(() => store.production.review(p.id, productionId, take.id, { decision: "approve", note: "", confirmations: { plays: true, noText: true } }), "invalid");
    expect(e.message).toMatch(/loop is seamless/);
    store.production.review(p.id, productionId, take.id, { decision: "approve", note: "Good", confirmations: confirmAll });
    shot = store.production.get(p.id, productionId).shots.find((s) => s.slotId === loop.slotId)!;
    expect(shot).toMatchObject({ status: "approved", approvedTakeId: take.id });

    const m = AssetManifest.parse(store.production.assetManifest(p.id, productionId));
    const slot = m.scenes.flatMap((s) => s.slots).find((s) => s.slotId === loop.slotId)!;
    expect(slot).toMatchObject({ status: "approved", asset: { takeId: take.id, provider: "runway", providerJobId: "task-1", promptVersion: 1, mimeType: "video/mp4" } });
    expect(m).toMatchObject({ complete: false, counts: { slots: 6, approved: 1, missing: 5, blocked: 0 } });
    // The original bytes are kept and served as stored.
    expect(Buffer.from(store.production.readTake(p.id, productionId, take.id).bytes)).toEqual(Buffer.from(good(6)));
    await rejects(store.production.generate(p.id, productionId, loop.slotId, "runway"), "conflict");
  });

  it("never marks a job completed on the provider's word alone", async () => {
    const { p, productionId, loop } = setup();
    runway.script.submit.push(() => "task-1");
    runway.script.poll.push(() => ({ state: "succeeded", outputUrl: "https://runway.invalid/out.mp4" }));
    runway.script.download.push(() => {
      throw new ProviderError("HTTP 403", "http_403", false);
    });
    const job = await store.production.generate(p.id, productionId, loop.slotId, "runway");
    const after = await store.production.poll(p.id, productionId, job.id);
    expect(after).toMatchObject({ status: "failed", takeId: null, error: { code: "http_403", retryable: false } });
    expect(after.error!.message).toMatch(/^Generated, but the output could not be downloaded/);
    expect(store.production.get(p.id, productionId).shots.find((s) => s.slotId === loop.slotId)!).toMatchObject({ status: "failed", takes: [] });
  });

  it("failure: a non-retryable provider failure cannot be retried as-is", async () => {
    const { p, productionId, loop } = setup();
    runway.script.submit.push(() => "task-1");
    runway.script.poll.push(() => ({ state: "failed", code: "SAFETY.INPUT", message: "Content moderation", retryable: false }));
    const job = await store.production.generate(p.id, productionId, loop.slotId, "runway");
    expect(await store.production.poll(p.id, productionId, job.id)).toMatchObject({ status: "failed", error: { code: "SAFETY.INPUT", retryable: false } });
    const e = await rejects(store.production.retry(p.id, productionId, job.id), "conflict");
    expect(e.message).toMatch(/new version/);
    // A new prompt version is a new request, so it may be generated.
    expect(store.production.addPrompt(p.id, productionId, loop.slotId, { positive: "Calmer facade", negative: "no text", note: "moderation" })).toBe(2);
    runway.script.submit.push(() => "task-2");
    expect(await store.production.generate(p.id, productionId, loop.slotId, "runway")).toMatchObject({ status: "generating", promptVersion: 2 });
  });

  it("retries: retryable failures resubmit up to the limit, then succeed or stop", async () => {
    const { p, productionId, loop } = setup();
    runway.script.submit.push(() => {
      throw new ProviderError("Runway returned HTTP 429", "http_429", true);
    });
    const job = await store.production.generate(p.id, productionId, loop.slotId, "runway");
    expect(job).toMatchObject({ status: "failed", providerJobId: null, error: { code: "http_429", retryable: true } });

    runway.script.submit.push(() => {
      throw new TypeError("fetch failed");
    });
    const r2 = await store.production.retry(p.id, productionId, job.id);
    expect(r2).toMatchObject({ id: job.id, status: "failed", attempts: 2, error: { code: "network", retryable: true } });

    runway.script.submit.push(() => "task-3");
    runway.script.poll.push(() => ({ state: "succeeded", outputUrl: "https://runway.invalid/out.mp4" }));
    runway.script.download.push(() => good(6));
    const r3 = await store.production.retry(p.id, productionId, job.id);
    expect(r3).toMatchObject({ status: "generating", attempts: 3, providerJobId: "task-3", error: null });
    expect(await store.production.poll(p.id, productionId, job.id)).toMatchObject({ status: "completed" });
    expect(runway.submitted).toBe(3);

    // At the limit, retry refuses.
    const { p: p2, productionId: prod2, opening } = setup();
    for (let i = 0; i < MAX_ATTEMPTS; i++)
      runway.script.submit.push(() => {
        throw new ProviderError("busy", "http_503", true);
      });
    const j2 = await store.production.generate(p2.id, prod2, opening.slotId, "runway");
    await store.production.retry(p2.id, prod2, j2.id);
    await store.production.retry(p2.id, prod2, j2.id);
    const e = await rejects(store.production.retry(p2.id, prod2, j2.id), "conflict");
    expect(e.message).toMatch(/Retried 3 times/);
  });

  it("a failed status check is not a failed generation", async () => {
    const { p, productionId, loop } = setup();
    runway.script.submit.push(() => "task-1");
    runway.script.poll.push(() => {
      throw new TypeError("fetch failed");
    });
    const job = await store.production.generate(p.id, productionId, loop.slotId, "runway");
    const after = await store.production.poll(p.id, productionId, job.id);
    expect(after.status).toBe("generating");
    expect(after.error?.message).toMatch(/^Last status check failed/);
  });

  it("controls duplicates: one active job per shot and provider; identical completed requests need confirmation", async () => {
    const { p, productionId, loop } = setup();
    runway.script.submit.push(() => "task-1");
    const job = await store.production.generate(p.id, productionId, loop.slotId, "runway");
    await rejects(store.production.generate(p.id, productionId, loop.slotId, "runway"), "conflict");
    expect(runway.submitted).toBe(1);

    runway.script.poll.push(() => ({ state: "succeeded", outputUrl: "https://runway.invalid/out.mp4" }));
    runway.script.download.push(() => good(6));
    await store.production.poll(p.id, productionId, job.id);
    const e = await rejects(store.production.generate(p.id, productionId, loop.slotId, "runway"), "conflict");
    expect(e.message).toMatch(/identical request/);
    runway.script.submit.push(() => "task-2");
    expect(await store.production.generate(p.id, productionId, loop.slotId, "runway", { allowRepeat: true })).toMatchObject({ status: "generating" });

    // Cancel frees the slot; the provider may still bill, and we say so.
    const active = store.production.get(p.id, productionId).shots.find((s) => s.slotId === loop.slotId)!.jobs[0];
    expect(store.production.cancel(p.id, productionId, active.id)).toMatchObject({ status: "canceled" });
  });

  it("refuses an unconfigured provider and points to manual upload", async () => {
    const { p, productionId, loop } = setup();
    const e = await rejects(store.production.generate(p.id, productionId, loop.slotId, "veo"), "conflict");
    expect(e.message).toMatch(/GEMINI_API_KEY.*manual upload/);
    await rejects(store.production.generate(p.id, productionId, loop.slotId, "flow"), "invalid");
    expect(store.production.providerStatus()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "veo", configured: false, missingConfig: ["GEMINI_API_KEY"] })]));
  });

  it("manual upload: checks the file itself; failing takes cannot be approved", async () => {
    const { p, productionId, opening } = setup();
    await rejects(() => store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "a.mp4", bytes: good(12), tool: "" }), "invalid");
    await rejects(() => store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "a.mp4", bytes: new Uint8Array(), tool: "Flow" }), "invalid");

    const short = store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "short.mp4", bytes: good(8), tool: "Flow" });
    expect(short.checks.find((c) => c.key === "duration")).toMatchObject({ passed: false, message: "8s (needs at least 12s)" });
    const tall = store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "tall.mp4", bytes: synthMp4({ durationSeconds: 12, width: 720, height: 1280 }), tool: "Flow" });
    expect(tall.checks.find((c) => c.key === "dimensions")?.passed).toBe(false);
    const html = store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "x.mp4", bytes: new TextEncoder().encode("<html>"), tool: "Flow" });
    expect(html).toMatchObject({ passed: false, checks: expect.arrayContaining([expect.objectContaining({ key: "format", passed: false })]) });
    for (const t of [short, tall, html]) await rejects(() => store.production.review(p.id, productionId, t.id, { decision: "approve", note: "", confirmations: confirmAll }), "invalid");

    const ok = store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "flow.mp4", bytes: good(12), tool: "Flow" });
    expect(ok).toMatchObject({ source: "manual_upload", provider: "manual", tool: "Flow", passed: true, review: "review_required" });
    await rejects(() => store.production.review(p.id, productionId, short.id, { decision: "reject", note: "", confirmations: {} }), "invalid");
    store.production.review(p.id, productionId, short.id, { decision: "reject", note: "Too short", confirmations: {} });
    store.production.review(p.id, productionId, ok.id, { decision: "approve", note: "", confirmations: { plays: true, noText: true } });

    // Approving a newer take supersedes the old one; both stay traceable.
    const better = store.production.uploadManual(p.id, productionId, opening.slotId, { filename: "flow-v2.mp4", bytes: good(13), tool: "Flow" });
    store.production.review(p.id, productionId, better.id, { decision: "approve", note: "Better light", confirmations: { plays: true, noText: true } });
    const shot = store.production.get(p.id, productionId).shots.find((s) => s.slotId === opening.slotId)!;
    expect(shot.approvedTakeId).toBe(better.id);
    expect(Object.fromEntries(shot.takes.map((t) => [t.file.filename, t.review]))).toEqual({ "short.mp4": "rejected", "tall.mp4": "review_required", "x.mp4": "review_required", "flow.mp4": "superseded", "flow-v2.mp4": "approved" });
  });

  it("every scene ends approved or explicitly blocked before the manifest is complete", () => {
    const { p, productionId, shots } = setup();
    const [first, ...rest] = shots;
    store.production.uploadManual(p.id, productionId, first.slotId, { filename: "a.mp4", bytes: good(12), tool: "Flow" });
    const t = store.production.get(p.id, productionId).shots[0].takes[0];
    store.production.review(p.id, productionId, t.id, { decision: "approve", note: "", confirmations: confirmAll });
    expect(() => store.production.setBlocked(p.id, productionId, first.slotId, "Nope")).toThrow(/approved take/);
    expect(() => store.production.setBlocked(p.id, productionId, rest[0].slotId, "  ")).toThrow(StoreError);
    for (const s of rest) store.production.setBlocked(p.id, productionId, s.slotId, "Client to supply footage");

    const m = store.production.assetManifest(p.id, productionId);
    expect(m.counts).toEqual({ slots: 6, approved: 1, blocked: 5, missing: 0 });
    expect(m.complete).toBe(false); // blocked required slots are explicit, but not complete
    expect(m.scenes.flatMap((s) => s.slots).every((s) => s.status === "approved" || s.blockedReason)).toBe(true);

    store.production.setBlocked(p.id, productionId, rest[0].slotId, null);
    expect(store.production.get(p.id, productionId).shots[1].status).toBe("pending");
  });

  it("keeps projects apart", async () => {
    const { productionId, opening } = setup();
    const other = store.createProject({ name: "Other", clientName: "O" });
    await rejects(() => store.production.get(other.id, productionId), "not_found");
    await rejects(() => store.production.uploadManual(other.id, productionId, opening.slotId, { filename: "a.mp4", bytes: good(12), tool: "Flow" }), "not_found");
  });
});

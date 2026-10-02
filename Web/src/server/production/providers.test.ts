import { describe, expect, it } from "vitest";
import { probeMedia, synthMp4 } from "./media";
import { ProviderError, runwayProvider, veoProvider, type ShotSpec } from "./providers";

// Adapters against the providers' documented request and response shapes,
// with a scripted fetch. Nothing here calls a real API.

const spec = (over: Partial<ShotSpec> = {}): ShotSpec => ({
  sceneTitle: "Choice",
  aspectRatio: "16:9",
  durationSeconds: 6,
  prompt: "Locked-off shot of a timber house at blue hour",
  avoid: "no on-screen text, no captions",
  startFrame: null,
  endFrame: null,
  ...over,
});

const png = { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };

type Call = { url: string; init?: RequestInit };
function scripted(responses: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request to ${url}`);
    return next(call);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Runway adapter", () => {
  it("builds text-to-video and image-to-video requests within Runway's documented limits", () => {
    const r = runwayProvider("key");
    const t = r.build(spec());
    expect(t).toMatchObject({ ok: true, endpoint: "https://api.dev.runwayml.com/v1/text_to_video", body: { model: "gen4.5", ratio: "1280:720", duration: 6 } });
    expect(t.ok && t.body.promptText).toBe("Locked-off shot of a timber house at blue hour. Avoid: no on-screen text, no captions.");
    const i = r.build(spec({ startFrame: png, aspectRatio: "21:9" }));
    expect(i).toMatchObject({ ok: true, endpoint: "https://api.dev.runwayml.com/v1/image_to_video", body: { ratio: "1584:672" } });
    expect(i.ok && String(i.body.promptImage)).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses what Runway cannot do, and says why", () => {
    const r = runwayProvider("key");
    expect(r.build(spec({ durationSeconds: 12 }))).toEqual({ ok: false, problems: ["Runway generates 2–10 seconds; this shot needs 12s. Split the shot or use another provider."] });
    expect(r.build(spec({ aspectRatio: "1:1" })).ok).toBe(false); // 1:1 only from an image
    expect(r.build(spec({ prompt: "x".repeat(990) })).ok).toBe(false); // over 1000 with the no-text rule
    expect(r.build(spec({ aspectRatio: "4:5", startFrame: png })).ok).toBe(false);
  });

  it("submits with the documented headers and maps every task state", async () => {
    const { fn, calls } = scripted([
      json({ id: "task-1" }),
      json({ id: "task-1", status: "RUNNING", progress: 0.4 }),
      json({ id: "task-1", status: "SUCCEEDED", output: { uri: "https://api.dev.runwayml.com/v1/tasks/task-1/output.mp4" } }),
      json({ id: "task-2", status: "SUCCEEDED", output: ["https://cdn.example/out.mp4"] }),
      json({ id: "task-3", status: "FAILED", failure: "Content moderation", failureCode: "SAFETY.INPUT" }),
      json({ id: "task-4", status: "FAILED", failure: "Internal error", failureCode: "INTERNAL" }),
    ]);
    const r = runwayProvider("secret-key", fn);
    const built = r.build(spec());
    if (!built.ok) throw new Error("build");
    expect(await r.submit(built)).toEqual({ providerJobId: "task-1" });
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h).toMatchObject({ Authorization: "Bearer secret-key", "X-Runway-Version": "2024-11-06" });
    expect(await r.poll("task-1")).toEqual({ state: "running", progress: 0.4 });
    expect(await r.poll("task-1")).toEqual({ state: "succeeded", outputUrl: "https://api.dev.runwayml.com/v1/tasks/task-1/output.mp4" });
    expect(await r.poll("task-2")).toEqual({ state: "succeeded", outputUrl: "https://cdn.example/out.mp4" });
    expect(await r.poll("task-3")).toMatchObject({ state: "failed", code: "SAFETY.INPUT", retryable: false });
    expect(await r.poll("task-4")).toMatchObject({ state: "failed", code: "INTERNAL", retryable: true });
  });

  it("classifies submission errors: 429 retryable, 400 not", async () => {
    const { fn } = scripted([json({ error: "Rate limited" }, 429), json({ error: "Invalid ratio" }, 400)]);
    const r = runwayProvider("k", fn);
    const built = r.build(spec());
    if (!built.ok) throw new Error("build");
    await expect(r.submit(built)).rejects.toMatchObject({ code: "http_429", retryable: true });
    await expect(r.submit(built)).rejects.toMatchObject({ code: "http_400", retryable: false, message: "Runway returned HTTP 400: Invalid ratio" });
  });

  it("reports itself unconfigured without a key", () => {
    expect(runwayProvider(undefined)).toMatchObject({ configured: false, missingConfig: ["RUNWAYML_API_SECRET"] });
  });
});

describe("Veo adapter", () => {
  it("builds a predictLongRunning request with Veo 3.1's parameters", () => {
    const v = veoProvider("key");
    const b = v.build(spec({ durationSeconds: 5, startFrame: png, endFrame: png }));
    expect(b).toMatchObject({ ok: true, endpoint: "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning" });
    if (!b.ok) throw new Error("build");
    expect(b.body.parameters).toEqual({ aspectRatio: "16:9", durationSeconds: "6", resolution: "720p", personGeneration: "allow_adult" });
    const inst = (b.body.instances as Record<string, unknown>[])[0];
    expect(inst.prompt).toMatch(/Avoid: no on-screen text/);
    expect(inst).toHaveProperty("image.inlineData.mimeType", "image/png");
    expect(inst).toHaveProperty("lastFrame.inlineData.mimeType", "image/png");
    expect(inst).not.toHaveProperty("negativePrompt");
    expect(v.build(spec({ durationSeconds: 9 })).ok).toBe(false);
    expect(v.build(spec({ aspectRatio: "1:1" })).ok).toBe(false);
  });

  it("polls the operation and downloads with the API key", async () => {
    const mp4 = synthMp4({ durationSeconds: 6, width: 1280, height: 720 });
    const { fn, calls } = scripted([
      json({ name: "models/veo-3.1-generate-preview/operations/op1" }),
      json({ name: "op1", done: false }),
      json({ name: "op1", done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/abc:download" } }] } } }),
      () => new Response(new Uint8Array(mp4), { status: 200 }),
      json({ name: "op2", done: true, response: { generateVideoResponse: {} } }),
      json({ name: "op3", done: true, error: { code: 500, message: "Internal" } }),
    ]);
    const v = veoProvider("gkey", fn);
    const b = v.build(spec());
    if (!b.ok) throw new Error("build");
    const { providerJobId } = await v.submit(b);
    expect(providerJobId).toBe("models/veo-3.1-generate-preview/operations/op1");
    expect(await v.poll(providerJobId)).toEqual({ state: "running", progress: null });
    const done = await v.poll(providerJobId);
    expect(done).toMatchObject({ state: "succeeded" });
    const bytes = await v.download((done as { outputUrl: string }).outputUrl);
    expect((calls[3].init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("gkey");
    expect(probeMedia(bytes)).toMatchObject({ container: "mp4", durationSeconds: 6, width: 1280, height: 720, hasVideo: true });
    expect(await v.poll("op2")).toMatchObject({ state: "failed", code: "no_video", retryable: false });
    expect(await v.poll("op3")).toMatchObject({ state: "failed", retryable: true });
  });

  it("treats an empty download as a failure, not a result", async () => {
    const { fn } = scripted([() => new Response(new Uint8Array(), { status: 200 })]);
    await expect(veoProvider("k", fn).download("https://x")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("media probe", () => {
  it("reads MP4 duration, video track and dimensions, and rejects non-video", () => {
    expect(probeMedia(synthMp4({ durationSeconds: 8.5, width: 720, height: 1280, audio: true }))).toMatchObject({ container: "mp4", durationSeconds: 8.5, width: 720, height: 1280, hasVideo: true, hasAudio: true, problems: [] });
    expect(probeMedia(synthMp4({ durationSeconds: 2, width: 100, height: 100, brand: "qt  " })).container).toBe("mov");
    expect(probeMedia(new TextEncoder().encode("<html>not a video</html>")).problems).toEqual(["Not an MP4/MOV file (no ftyp box)"]);
    const truncated = synthMp4({ durationSeconds: 4, width: 640, height: 360 }).slice(0, 30);
    expect(probeMedia(truncated).problems[0]).toMatch(/No movie header/);
  });
});

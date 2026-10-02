import type { ProviderId } from "@/domain/production";

// Provider adapters for WF-07. Each turns one shot specification into that
// provider's request, submits it, polls it, and downloads the result. The
// rest of WF-07 (and WF-08) only sees this interface, so a provider can be
// added or replaced without touching the journey model or runtime.
//
// Built from the providers' published documentation, checked on 2026-10-01:
//   Runway  https://docs.dev.runwayml.com/api/  (X-Runway-Version 2024-11-06)
//   Veo     https://ai.google.dev/gemini-api/docs/veo  (veo-3.1-generate-preview)
// Flow (labs.google/flow) has no public API: its footage arrives through
// manual upload. Nothing here runs without the provider's own key.

export type ShotSpec = {
  sceneTitle: string;
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:5" | "21:9";
  durationSeconds: number;
  prompt: string;
  avoid: string; // the negative prompt; folded into the prompt where unsupported
  startFrame: { mimeType: string; bytes: Uint8Array } | null;
  endFrame: { mimeType: string; bytes: Uint8Array } | null;
};

export type BuiltRequest = { ok: true; model: string; endpoint: string; body: Record<string, unknown>; notes: string[] } | { ok: false; problems: string[] };

export type PollResult =
  | { state: "running"; progress: number | null }
  | { state: "succeeded"; outputUrl: string }
  | { state: "failed"; code: string; message: string; retryable: boolean };

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type Fetch = typeof fetch;

export interface VideoProvider {
  id: ProviderId;
  configured: boolean;
  missingConfig: string[];
  capabilities: { aspectRatios: string[]; durations: string; inputs: string; notes: string[] };
  build(spec: ShotSpec): BuiltRequest;
  submit(req: Extract<BuiltRequest, { ok: true }>): Promise<{ providerJobId: string }>;
  poll(providerJobId: string): Promise<PollResult>;
  download(outputUrl: string): Promise<Uint8Array>;
}

const MAX_DOWNLOAD = 500 * 1024 * 1024;

// Neither Runway nor Veo 3.1 accepts a negative prompt, so the no-text rule
// travels inside the prompt itself. The note records that this happened.
const withAvoid = (prompt: string, avoid: string) => (avoid ? `${prompt.trim()}. Avoid: ${avoid}.` : prompt.trim());

const dataUri = (f: { mimeType: string; bytes: Uint8Array }) => `data:${f.mimeType};base64,${Buffer.from(f.bytes).toString("base64")}`;

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function failFromResponse(res: Response, provider: string): Promise<never> {
  const body = await readJson(res);
  const msg = String((body.error as { message?: string })?.message ?? body.error ?? body.message ?? res.statusText ?? "request failed").slice(0, 400);
  // 429 and 5xx are worth retrying; 4xx means the request itself must change.
  throw new ProviderError(`${provider} returned HTTP ${res.status}: ${msg}`, `http_${res.status}`, res.status === 429 || res.status >= 500);
}

async function downloadCapped(fetchFn: Fetch, url: string, headers: Record<string, string>): Promise<Uint8Array> {
  const res = await fetchFn(url, { headers, redirect: "follow" });
  if (!res.ok) await failFromResponse(res, "Download");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD) throw new ProviderError("Output is larger than 500 MB", "too_large", false);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new ProviderError("The provider returned an empty file", "empty_output", true);
  if (buf.byteLength > MAX_DOWNLOAD) throw new ProviderError("Output is larger than 500 MB", "too_large", false);
  return buf;
}

// ------------------------------------------------------------------ Runway

const RUNWAY_BASE = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";
const RUNWAY_MODEL = "gen4.5";
// Pixel ratios Runway accepts, matched to the journey's aspect ratios.
const RUNWAY_RATIO_IMAGE: Record<string, string> = { "16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960", "21:9": "1584:672" };
const RUNWAY_RATIO_TEXT: Record<string, string> = { "16:9": "1280:720", "9:16": "720:1280" };

export function runwayProvider(apiKey: string | undefined, fetchFn: Fetch = fetch): VideoProvider {
  const headers = { Authorization: `Bearer ${apiKey}`, "X-Runway-Version": RUNWAY_VERSION, "Content-Type": "application/json" };
  return {
    id: "runway",
    configured: Boolean(apiKey),
    missingConfig: apiKey ? [] : ["RUNWAYML_API_SECRET"],
    capabilities: {
      aspectRatios: ["16:9", "9:16", "1:1 (image to video)", "21:9 (image to video)"],
      durations: "2–10 seconds, whole seconds",
      inputs: "Text to video, or image to video from the start keyframe",
      notes: ["No negative prompt: the no-text rule is written into the prompt", "Prompt limited to 1000 characters"],
    },
    build(spec) {
      const problems: string[] = [];
      const image = spec.startFrame;
      const ratio = (image ? RUNWAY_RATIO_IMAGE : RUNWAY_RATIO_TEXT)[spec.aspectRatio];
      if (!ratio) problems.push(`Runway cannot produce ${spec.aspectRatio}${image ? "" : " from text alone (add a start keyframe for 1:1 or 21:9)"}`);
      const duration = Math.ceil(spec.durationSeconds);
      if (duration < 2 || duration > 10) problems.push(`Runway generates 2–10 seconds; this shot needs ${spec.durationSeconds}s. Split the shot or use another provider.`);
      const promptText = withAvoid(spec.prompt, spec.avoid);
      if (!spec.prompt.trim()) problems.push("The shot has no prompt");
      if (promptText.length > 1000) problems.push(`Runway prompts are limited to 1000 characters; this one is ${promptText.length} with the no-text rule`);
      if (image && image.bytes.byteLength > 5 * 1024 * 1024) problems.push("Runway accepts start images up to 5 MB");
      if (problems.length) return { ok: false, problems };
      const body: Record<string, unknown> = { model: RUNWAY_MODEL, promptText, ratio, duration };
      if (image) body.promptImage = dataUri(image);
      return {
        ok: true,
        model: RUNWAY_MODEL,
        endpoint: `${RUNWAY_BASE}/v1/${image ? "image_to_video" : "text_to_video"}`,
        body,
        notes: [`ratio ${ratio}`, `${duration}s`, "negative prompt folded into the prompt (not supported by Runway)"],
      };
    },
    async submit(req) {
      const res = await fetchFn(req.endpoint, { method: "POST", headers, body: JSON.stringify(req.body) });
      if (!res.ok) await failFromResponse(res, "Runway");
      const body = await readJson(res);
      if (typeof body.id !== "string") throw new ProviderError("Runway accepted the request but returned no task id", "no_task_id", true);
      return { providerJobId: body.id };
    },
    async poll(id) {
      const res = await fetchFn(`${RUNWAY_BASE}/v1/tasks/${encodeURIComponent(id)}`, { headers });
      if (!res.ok) await failFromResponse(res, "Runway");
      const t = await readJson(res);
      switch (t.status) {
        case "PENDING":
        case "THROTTLED":
        case "RUNNING":
          return { state: "running", progress: typeof t.progress === "number" ? t.progress : null };
        case "SUCCEEDED": {
          // Documented as an output object with a uri; an array of URLs is also accepted.
          const out = t.output as unknown;
          const url = Array.isArray(out) ? out.find((x) => typeof x === "string") : typeof out === "object" && out && typeof (out as { uri?: unknown }).uri === "string" ? (out as { uri: string }).uri : null;
          if (!url) return { state: "failed", code: "no_output", message: "Runway reported success but returned no output URL", retryable: true };
          return { state: "succeeded", outputUrl: url };
        }
        case "FAILED":
          return { state: "failed", code: String(t.failureCode ?? "FAILED"), message: String(t.failure ?? "Runway reported the task failed"), retryable: !/SAFETY|INPUT|INVALID/i.test(String(t.failureCode ?? "")) };
        case "CANCELLED":
          return { state: "failed", code: "CANCELLED", message: "The task was cancelled at Runway", retryable: true };
        default:
          return { state: "failed", code: "unknown_status", message: `Unrecognised Runway status ${String(t.status)}`, retryable: true };
      }
    },
    download: (url) => downloadCapped(fetchFn, url, {}),
  };
}

// --------------------------------------------------------------------- Veo

const VEO_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VEO_MODEL = "veo-3.1-generate-preview";

export function veoProvider(apiKey: string | undefined, fetchFn: Fetch = fetch): VideoProvider {
  const headers = { "x-goog-api-key": apiKey ?? "", "Content-Type": "application/json" };
  return {
    id: "veo",
    configured: Boolean(apiKey),
    missingConfig: apiKey ? [] : ["GEMINI_API_KEY"],
    capabilities: {
      aspectRatios: ["16:9", "9:16"],
      durations: "4, 6 or 8 seconds",
      inputs: "Text to video; image to video from the start keyframe; end keyframe as last frame",
      notes: ["No negative prompt in Veo 3.1: the no-text rule is written into the prompt", "Generates audio with every video", "Outputs are kept by Google for 2 days, so they are downloaded immediately"],
    },
    build(spec) {
      const problems: string[] = [];
      if (spec.aspectRatio !== "16:9" && spec.aspectRatio !== "9:16") problems.push(`Veo produces 16:9 or 9:16, not ${spec.aspectRatio}`);
      const duration = [4, 6, 8].find((d) => d >= spec.durationSeconds);
      if (!duration) problems.push(`Veo generates at most 8 seconds; this shot needs ${spec.durationSeconds}s. Split the shot or use another provider.`);
      if (!spec.prompt.trim()) problems.push("The shot has no prompt");
      if (problems.length) return { ok: false, problems };
      const instance: Record<string, unknown> = { prompt: withAvoid(spec.prompt, spec.avoid) };
      if (spec.startFrame) instance.image = { inlineData: { mimeType: spec.startFrame.mimeType, data: Buffer.from(spec.startFrame.bytes).toString("base64") } };
      if (spec.endFrame) instance.lastFrame = { inlineData: { mimeType: spec.endFrame.mimeType, data: Buffer.from(spec.endFrame.bytes).toString("base64") } };
      const image = Boolean(spec.startFrame || spec.endFrame);
      return {
        ok: true,
        model: VEO_MODEL,
        endpoint: `${VEO_BASE}/models/${VEO_MODEL}:predictLongRunning`,
        body: { instances: [instance], parameters: { aspectRatio: spec.aspectRatio, durationSeconds: String(duration), resolution: "720p", personGeneration: image ? "allow_adult" : "allow_all" } },
        notes: [`${duration}s at 720p`, "negative prompt folded into the prompt (not supported by Veo 3.1)", "audio is generated with the video"],
      };
    },
    async submit(req) {
      const res = await fetchFn(req.endpoint, { method: "POST", headers, body: JSON.stringify(req.body) });
      if (!res.ok) await failFromResponse(res, "Veo");
      const body = await readJson(res);
      if (typeof body.name !== "string") throw new ProviderError("Veo accepted the request but returned no operation name", "no_operation", true);
      return { providerJobId: body.name };
    },
    async poll(name) {
      const res = await fetchFn(`${VEO_BASE}/${name}`, { headers });
      if (!res.ok) await failFromResponse(res, "Veo");
      const op = await readJson(res);
      if (!op.done) return { state: "running", progress: null };
      if (op.error) {
        const e = op.error as { code?: number; message?: string };
        return { state: "failed", code: `veo_${e.code ?? "error"}`, message: String(e.message ?? "Veo reported an error"), retryable: (e.code ?? 0) >= 500 || e.code === 429 };
      }
      const uri = (op.response as { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] } })?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      // Done without a video: Google documents that safety-blocked
      // generations are not charged; the prompt must change before retrying.
      if (!uri) return { state: "failed", code: "no_video", message: "Veo finished without a video (possibly blocked by safety filters). Revise the prompt or keyframes.", retryable: false };
      return { state: "succeeded", outputUrl: uri };
    },
    download: (url) => downloadCapped(fetchFn, url, { "x-goog-api-key": apiKey ?? "" }),
  };
}

export type ProviderRegistry = Record<ProviderId, VideoProvider>;

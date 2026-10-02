import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SceneManifest } from "@/domain/journey-contract";
import {
  ASSET_MANIFEST_SCHEMA,
  AssetManifest,
  MAX_ATTEMPTS,
  ProviderId,
  REVIEW_CONFIRMATIONS,
  shotStatus,
  type Check,
  type JobStatus,
  type ReviewStatus,
  type ShotStatus,
} from "@/domain/production";
import type { Project } from "@/domain/project";
import { probeMedia, type MediaFacts } from "@/server/production/media";
import { ProviderError, type BuiltRequest, type ProviderRegistry, type ShotSpec } from "@/server/production/providers";
import { transaction } from "./db";
import { now, StoreError, type Row } from "./errors";
import type { FileStore } from "./files";

// WF-07 persistence and orchestration. Network calls to providers happen
// outside transactions; their outcomes are recorded only from what the
// provider actually returned. A job is "completed" only once its output has
// been downloaded, checked and stored - never on the provider's word alone.

export const MAX_TAKE_BYTES = 500 * 1024 * 1024;

type ManifestScene = SceneManifest["scenes"][number];
type ManifestSlot = ManifestScene["assetSlots"][number];

export type Job = {
  id: string;
  slotId: string;
  provider: ProviderId;
  model: string;
  promptVersion: number;
  request: Record<string, unknown>;
  idempotencyKey: string;
  status: JobStatus;
  providerJobId: string | null;
  attempts: number;
  error: { code: string; message: string; retryable: boolean } | null;
  takeId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type Take = {
  id: string;
  slotId: string;
  jobId: string | null;
  source: "provider" | "manual_upload";
  provider: string;
  model: string | null;
  promptVersion: number | null;
  tool: string;
  file: { storageKey: string; filename: string; mimeType: string; sizeBytes: number; sha256: string };
  media: { container: string; durationSeconds: number | null; width: number | null; height: number | null };
  checks: Check[];
  passed: boolean;
  review: ReviewStatus;
  reviewNote: string;
  confirmations: Record<string, boolean>;
  reviewedAt: string | null;
  createdAt: string;
};

export type PromptVersion = { version: number; positive: string; negative: string; note: string; createdAt: string };

export type Shot = {
  slotId: string;
  scene: ManifestScene;
  slot: ManifestSlot;
  status: ShotStatus;
  blockedReason: string | null;
  approvedTakeId: string | null;
  prompts: PromptVersion[];
  jobs: Job[];
  takes: Take[];
};

type Context = {
  db: DatabaseSync;
  files: FileStore;
  requireProject: (id: string) => Project;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  sceneManifest: (projectId: string, journeyId: string) => SceneManifest;
  readKeyframe: (projectId: string, ref: { kind: string; url: string }) => { mimeType: string; bytes: Uint8Array } | null;
  providers: ProviderRegistry;
};

const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;

const toJob = (r: Row): Job => ({
  id: String(r.id),
  slotId: String(r.slot_id),
  provider: r.provider as ProviderId,
  model: String(r.model),
  promptVersion: Number(r.prompt_version),
  request: json(r.request),
  idempotencyKey: String(r.idempotency_key),
  status: r.status as JobStatus,
  providerJobId: (r.provider_job_id as string | null) ?? null,
  attempts: Number(r.attempts),
  error: r.error_code ? { code: String(r.error_code), message: String(r.error_message), retryable: Boolean(r.retryable) } : null,
  takeId: (r.take_id as string | null) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  completedAt: (r.completed_at as string | null) ?? null,
});

const toTake = (r: Row): Take => {
  const checks = json<Check[]>(r.checks);
  return {
    id: String(r.id),
    slotId: String(r.slot_id),
    jobId: (r.job_id as string | null) ?? null,
    source: r.source as Take["source"],
    provider: String(r.provider),
    model: (r.model as string | null) ?? null,
    promptVersion: r.prompt_version == null ? null : Number(r.prompt_version),
    tool: String(r.tool),
    file: { storageKey: String(r.storage_key), filename: String(r.filename), mimeType: String(r.mime_type), sizeBytes: Number(r.size_bytes), sha256: String(r.sha256) },
    media: { container: String(r.container), durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds), width: r.width == null ? null : Number(r.width), height: r.height == null ? null : Number(r.height) },
    checks,
    passed: checks.every((c) => c.passed),
    review: r.review as ReviewStatus,
    reviewNote: String(r.review_note),
    confirmations: json(r.confirmations),
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
};

const ratioOf = (ar: string) => {
  const [w, h] = ar.split(":").map(Number);
  return w / h;
};

// Checks that need no person: is it the right kind of file, long enough,
// the right shape. Playback, absence of text and loop seams are confirmed by
// the reviewer at approval (REVIEW_CONFIRMATIONS).
export function checkTake(slot: ManifestSlot, f: MediaFacts, sizeBytes: number): Check[] {
  const checks: Check[] = [];
  const add = (key: string, passed: boolean, message: string) => checks.push({ key, passed, message });
  add("size", sizeBytes > 0 && sizeBytes <= MAX_TAKE_BYTES, sizeBytes > 0 ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : "Empty file");
  if (slot.kind === "still") {
    add("format", f.container === "png" || f.container === "jpeg", f.container === "png" || f.container === "jpeg" ? `${f.container.toUpperCase()} image` : "A still must be a PNG or JPEG image");
  } else if (slot.kind === "audio") {
    add("format", (f.container === "mp4" || f.container === "mov") && f.hasAudio, f.hasAudio ? "MP4/M4A with an audio track" : "Audio must be an MP4/M4A file with an audio track");
  } else {
    add("format", (f.container === "mp4" || f.container === "mov") && f.hasVideo && f.problems.length === 0, f.problems[0] ?? (f.hasVideo ? `${f.container.toUpperCase()} with a video track` : "No video track found"));
  }
  if (slot.kind !== "still") {
    const min = slot.acceptance.minDurationSeconds;
    if (f.durationSeconds === null) add("duration", false, "Duration could not be read");
    else if (min !== null) add("duration", f.durationSeconds + 0.1 >= min, `${f.durationSeconds}s (needs at least ${min}s)`);
    else add("duration", true, `${f.durationSeconds}s`);
  }
  if (slot.kind !== "audio") {
    if (f.width && f.height) {
      const want = ratioOf(slot.acceptance.aspectRatio);
      const got = f.width / f.height;
      add("dimensions", Math.abs(got - want) / want <= 0.03, `${f.width}×${f.height} (${slot.acceptance.aspectRatio} needed)`);
    } else add("dimensions", false, "Dimensions could not be read");
  }
  return checks;
}

const PROMPT_IMAGE_KEYS = new Set(["promptImage", "image", "lastFrame"]);
// The stored request: what was sent, with image payloads replaced by their
// hash and size so the database holds no copies of media.
function redact(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redact);
  if (body && typeof body === "object") {
    return Object.fromEntries(
      Object.entries(body).map(([k, v]) => {
        if (PROMPT_IMAGE_KEYS.has(k)) {
          const raw = typeof v === "string" ? v : JSON.stringify(v);
          return [k, { redacted: "image", sha256: createHash("sha256").update(raw).digest("hex"), chars: raw.length }];
        }
        return [k, redact(v)];
      }),
    );
  }
  return body;
}

export function createProductionStore(ctx: Context) {
  const { db, files } = ctx;

  const requireProduction = (projectId: string, productionId: string) => {
    ctx.requireProject(projectId);
    const r = db.prepare("select * from productions where id = ? and project_id = ?").get(productionId, projectId) as Row | undefined;
    if (!r) throw new StoreError("not_found", "Production not found.");
    return { id: String(r.id), journeyId: String(r.journey_id), journeyVersion: Number(r.journey_version), manifest: json<SceneManifest>(r.manifest), createdAt: String(r.created_at) };
  };

  const slotOf = (manifest: SceneManifest, slotId: string) => {
    for (const scene of manifest.scenes) for (const slot of scene.assetSlots) if (slot.id === slotId) return { scene, slot };
    throw new StoreError("not_found", "That shot is not part of this production.");
  };

  const shot = (productionId: string, manifest: SceneManifest, slotId: string): Shot => {
    const { scene, slot } = slotOf(manifest, slotId);
    const row = db.prepare("select * from production_shots where production_id = ? and slot_id = ?").get(productionId, slotId) as Row;
    const prompts = (db.prepare("select * from production_prompts where production_id = ? and slot_id = ? order by version desc").all(productionId, slotId) as Row[]).map((r) => ({
      version: Number(r.version),
      positive: String(r.positive),
      negative: String(r.negative),
      note: String(r.note),
      createdAt: String(r.created_at),
    }));
    const jobs = (db.prepare("select * from production_jobs where production_id = ? and slot_id = ? order by created_at desc, rowid desc").all(productionId, slotId) as Row[]).map(toJob);
    const takes = (db.prepare("select * from production_takes where production_id = ? and slot_id = ? order by created_at desc, rowid desc").all(productionId, slotId) as Row[]).map(toTake);
    const blockedReason = (row.blocked_reason as string | null) ?? null;
    const approvedTakeId = (row.approved_take_id as string | null) ?? null;
    return { slotId, scene, slot, prompts, jobs, takes, blockedReason, approvedTakeId, status: shotStatus({ blockedReason, approvedTakeId, jobs, takes }) };
  };

  const requireJob = (productionId: string, jobId: string) => {
    const r = db.prepare("select * from production_jobs where id = ? and production_id = ?").get(jobId, productionId) as Row | undefined;
    if (!r) throw new StoreError("not_found", "Job not found.");
    return toJob(r);
  };

  // The provider-specific request for a shot's current prompt version.
  const buildFor = (projectId: string, s: Shot, provider: ProviderId, promptVersion?: number) => {
    const p = ctx.providers[provider];
    const prompt = promptVersion ? s.prompts.find((x) => x.version === promptVersion) : s.prompts[0];
    if (!prompt) throw new StoreError("invalid", "This shot has no prompt.");
    const key = (pos: string) => s.scene.keyframes.find((k) => k.position === pos && k.ref);
    const frame = (pos: string) => {
      const k = key(pos);
      return k?.ref ? ctx.readKeyframe(projectId, k.ref) : null;
    };
    const spec: ShotSpec = {
      sceneTitle: s.scene.title,
      aspectRatio: s.slot.acceptance.aspectRatio,
      durationSeconds: s.slot.durationSeconds ?? s.scene.durationSeconds,
      prompt: prompt.positive,
      avoid: prompt.negative,
      startFrame: frame("start") ?? frame("middle"),
      endFrame: frame("end"),
    };
    return { provider: p, prompt, built: p.build(spec) };
  };

  const setJob = (id: string, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.prepare(`update production_jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ?`).run(...keys.map((k) => fields[k] as never), now(), id);
  };

  // Submits (or resubmits) a job to its provider and records exactly what happened.
  const submit = async (projectId: string, productionId: string, job: Job, req: Extract<BuiltRequest, { ok: true }>) => {
    try {
      const { providerJobId } = await ctx.providers[job.provider].submit(req);
      setJob(job.id, { status: "generating", provider_job_id: providerJobId, error_code: null, error_message: null, retryable: 0 });
      ctx.logActivity(projectId, "production_submitted", `Shot submitted to ${job.provider} (job ${providerJobId})`);
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(`Could not reach ${job.provider}: ${(e as Error).message}`.slice(0, 400), "network", true);
      setJob(job.id, { status: "failed", error_code: pe.code, error_message: pe.message, retryable: pe.retryable ? 1 : 0 });
      ctx.logActivity(projectId, "production_failed", `Submission to ${job.provider} failed: ${pe.code}`);
    }
    ctx.touchProject(projectId);
    return requireJob(productionId, job.id);
  };

  const storeTake = (projectId: string, productionId: string, s: Shot, input: { bytes: Uint8Array; filename: string; source: Take["source"]; provider: string; model: string | null; promptVersion: number | null; tool: string; jobId: string | null }, after?: (takeId: string) => void) => {
    const facts = probeMedia(input.bytes);
    const checks = checkTake(s.slot, facts, input.bytes.byteLength);
    const id = randomUUID();
    const key = `${projectId}/production/${productionId}/${s.slotId}/${id}`;
    return files.storeThenRecord(key, input.bytes, ({ sha256, sizeBytes }) =>
      transaction(db, () => {
        db.prepare(
          "insert into production_takes (id, production_id, slot_id, job_id, source, provider, model, prompt_version, tool, storage_key, filename, mime_type, size_bytes, sha256, container, duration_seconds, width, height, checks, review, review_note, confirmations, reviewed_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review_required', '', '{}', null, ?)",
        ).run(id, productionId, s.slotId, input.jobId, input.source, input.provider, input.model, input.promptVersion, input.tool, key, input.filename.slice(0, 255), facts.mimeType, sizeBytes, sha256, facts.container, facts.durationSeconds, facts.width, facts.height, JSON.stringify(checks), now());
        after?.(id);
        ctx.touchProject(projectId);
        return id;
      }),
    );
  };

  const self = {
    list(projectId: string) {
      ctx.requireProject(projectId);
      return (db.prepare("select id from productions where project_id = ? order by created_at desc").all(projectId) as Row[]).map((r) => self.get(projectId, String(r.id)));
    },

    get(projectId: string, productionId: string) {
      const p = requireProduction(projectId, productionId);
      const shots = p.manifest.scenes.flatMap((sc) => sc.assetSlots.map((a) => shot(p.id, p.manifest, a.id)));
      return { production: p, shots };
    },

    // One production per approved journey version, from its scene manifest.
    start(projectId: string, journeyId: string): string {
      const manifest = ctx.sceneManifest(projectId, journeyId);
      if (manifest.version.status !== "approved") throw new StoreError("conflict", "Production starts from an approved journey version.");
      return transaction(db, () => {
        ctx.requireProject(projectId);
        const existing = db.prepare("select id from productions where journey_id = ? and journey_version = ?").get(journeyId, manifest.version.number) as Row | undefined;
        if (existing) throw new StoreError("conflict", `Production for version ${manifest.version.number} already exists.`);
        const id = randomUUID();
        const at = now();
        db.prepare("insert into productions (id, project_id, journey_id, journey_version, manifest, created_at) values (?, ?, ?, ?, ?, ?)").run(id, projectId, journeyId, manifest.version.number, JSON.stringify(manifest), at);
        for (const scene of manifest.scenes) {
          for (const slot of scene.assetSlots) {
            db.prepare("insert into production_shots (production_id, slot_id, scene_id, blocked_reason, approved_take_id) values (?, ?, ?, null, null)").run(id, slot.id, scene.id);
            db.prepare("insert into production_prompts (id, production_id, slot_id, version, positive, negative, note, created_at) values (?, ?, ?, 1, ?, ?, 'From the approved scene manifest', ?)").run(randomUUID(), id, slot.id, scene.prompt.positive, scene.prompt.negative, at);
          }
        }
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "production_started", `Production started for ${manifest.journey.name} v${manifest.version.number}`);
        return id;
      });
    },

    addPrompt(projectId: string, productionId: string, slotId: string, input: { positive: unknown; negative: unknown; note: unknown }): number {
      const positive = typeof input.positive === "string" ? input.positive.trim() : "";
      const negative = typeof input.negative === "string" ? input.negative.trim() : "";
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
      if (!positive || positive.length > 4000) throw new StoreError("invalid", "Write the prompt (up to 4000 characters).", [{ path: "positive", message: "Required" }]);
      return transaction(db, () => {
        const p = requireProduction(projectId, productionId);
        const s = shot(p.id, p.manifest, slotId);
        const version = (s.prompts[0]?.version ?? 0) + 1;
        db.prepare("insert into production_prompts (id, production_id, slot_id, version, positive, negative, note, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), productionId, slotId, version, positive, negative, note, now());
        ctx.touchProject(projectId);
        return version;
      });
    },

    preview(projectId: string, productionId: string, slotId: string, provider: ProviderId) {
      const p = requireProduction(projectId, productionId);
      const { built } = buildFor(projectId, shot(p.id, p.manifest, slotId), provider);
      return built.ok ? { ok: true as const, model: built.model, endpoint: built.endpoint, body: redact(built.body), notes: built.notes } : built;
    },

    async generate(projectId: string, productionId: string, slotId: string, providerId: unknown, opts: { allowRepeat?: boolean } = {}): Promise<Job> {
      const parsed = ProviderId.safeParse(providerId);
      if (!parsed.success) throw new StoreError("invalid", "Choose Runway or Veo.");
      const provider = parsed.data;
      const p = requireProduction(projectId, productionId);
      const s = shot(p.id, p.manifest, slotId);
      if (s.approvedTakeId) throw new StoreError("conflict", "This shot already has an approved take.");
      if (s.blockedReason) throw new StoreError("conflict", "This shot is marked blocked. Unblock it first.");
      const { provider: adapter, prompt, built } = buildFor(projectId, s, provider);
      if (!adapter.configured) throw new StoreError("conflict", `${provider === "runway" ? "Runway" : "Veo"} is not configured on this server (set ${adapter.missingConfig.join(", ")}). Use manual upload instead.`);
      if (!built.ok) throw new StoreError("invalid", `This shot cannot be sent to ${provider}: ${built.problems.join(" ")}`, built.problems.map((m) => ({ path: "provider", message: m })));
      const key = createHash("sha256").update(JSON.stringify({ slotId, provider, model: built.model, prompt: prompt.version, body: redact(built.body) })).digest("hex");
      const job = transaction(db, () => {
        const active = db.prepare("select id from production_jobs where production_id = ? and slot_id = ? and provider = ? and status in ('queued', 'generating')").get(productionId, slotId, provider);
        if (active) throw new StoreError("conflict", `A ${provider} job for this shot is already running. Wait for it, or cancel it.`);
        const same = db.prepare("select id from production_jobs where production_id = ? and idempotency_key = ? and status = 'completed'").get(productionId, key) as Row | undefined;
        if (same && !opts.allowRepeat) throw new StoreError("conflict", "An identical request already produced a take for this shot. Confirm to generate another take anyway.", [{ path: "allowRepeat", message: "Duplicate request" }]);
        const id = randomUUID();
        const at = now();
        db.prepare(
          "insert into production_jobs (id, production_id, slot_id, provider, model, prompt_version, request, idempotency_key, status, provider_job_id, attempts, error_code, error_message, retryable, take_id, created_at, updated_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'queued', null, 1, null, null, 0, null, ?, ?, null)",
        ).run(id, productionId, slotId, provider, built.model, prompt.version, JSON.stringify({ endpoint: built.endpoint, body: redact(built.body), notes: built.notes }), key, at, at);
        return requireJob(productionId, id);
      });
      return submit(projectId, productionId, job, built);
    },

    // Asks the provider once. Success is recorded only after the output is
    // downloaded and stored as a take.
    async poll(projectId: string, productionId: string, jobId: string): Promise<Job> {
      const p = requireProduction(projectId, productionId);
      const job = requireJob(productionId, jobId);
      if (job.status !== "generating" || !job.providerJobId) return job;
      const adapter = ctx.providers[job.provider];
      let result;
      try {
        result = await adapter.poll(job.providerJobId);
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError(`Could not reach ${job.provider}: ${(e as Error).message}`, "network", true);
        // A failed status check is not a failed generation: keep waiting, but say why.
        setJob(job.id, { error_code: pe.code, error_message: `Last status check failed: ${pe.message}`.slice(0, 400), retryable: 1 });
        return requireJob(productionId, jobId);
      }
      if (result.state === "running") {
        setJob(job.id, { error_code: null, error_message: null });
        return requireJob(productionId, jobId);
      }
      if (result.state === "failed") {
        setJob(job.id, { status: "failed", error_code: result.code, error_message: result.message.slice(0, 400), retryable: result.retryable ? 1 : 0 });
        ctx.logActivity(projectId, "production_failed", `${job.provider} generation failed: ${result.code}`);
        return requireJob(productionId, jobId);
      }
      let bytes: Uint8Array;
      try {
        bytes = await adapter.download(result.outputUrl);
      } catch (e) {
        const pe = e instanceof ProviderError ? e : new ProviderError((e as Error).message, "download_failed", true);
        setJob(job.id, { status: "failed", error_code: pe.code, error_message: `Generated, but the output could not be downloaded: ${pe.message}`.slice(0, 400), retryable: pe.retryable ? 1 : 0 });
        return requireJob(productionId, jobId);
      }
      const s = shot(p.id, p.manifest, job.slotId);
      storeTake(projectId, productionId, s, { bytes, filename: `${job.provider}-${job.providerJobId.split("/").pop()}.mp4`, source: "provider", provider: job.provider, model: job.model, promptVersion: job.promptVersion, tool: job.provider, jobId: job.id }, (takeId) => {
        db.prepare("update production_jobs set status = 'completed', take_id = ?, completed_at = ?, error_code = null, error_message = null, updated_at = ? where id = ?").run(takeId, now(), now(), job.id);
        ctx.logActivity(projectId, "production_completed", `${job.provider} output stored for review`);
      });
      return requireJob(productionId, jobId);
    },

    async retry(projectId: string, productionId: string, jobId: string): Promise<Job> {
      const p = requireProduction(projectId, productionId);
      const job = requireJob(productionId, jobId);
      if (job.status !== "failed") throw new StoreError("conflict", "Only failed jobs can be retried.");
      if (!job.error?.retryable) throw new StoreError("conflict", "This failure will repeat as it is. Change the prompt (a new version) or keyframes and generate again.");
      if (job.attempts >= MAX_ATTEMPTS) throw new StoreError("conflict", `Retried ${MAX_ATTEMPTS} times already. Check the provider, then generate a new job.`);
      const s = shot(p.id, p.manifest, job.slotId);
      if (s.approvedTakeId) throw new StoreError("conflict", "This shot already has an approved take.");
      const { built } = buildFor(projectId, s, job.provider, job.promptVersion);
      if (!built.ok) throw new StoreError("invalid", built.problems.join(" "));
      transaction(db, () => {
        const active = db.prepare("select id from production_jobs where production_id = ? and slot_id = ? and provider = ? and status in ('queued', 'generating')").get(productionId, job.slotId, job.provider);
        if (active) throw new StoreError("conflict", `A ${job.provider} job for this shot is already running.`);
        setJob(job.id, { status: "queued", attempts: job.attempts + 1, provider_job_id: null });
      });
      return submit(projectId, productionId, requireJob(productionId, jobId), built);
    },

    cancel(projectId: string, productionId: string, jobId: string): Job {
      requireProduction(projectId, productionId);
      const job = requireJob(productionId, jobId);
      if (job.status !== "queued" && job.status !== "generating") throw new StoreError("conflict", "Only queued or generating jobs can be cancelled.");
      setJob(job.id, { status: "canceled", error_message: "Cancelled here. The provider may still finish and bill for it." });
      ctx.touchProject(projectId);
      return requireJob(productionId, jobId);
    },

    // Footage made elsewhere - in Flow, Runway's or Veo's own apps, or a shoot.
    uploadManual(projectId: string, productionId: string, slotId: string, input: { filename: string; bytes: Uint8Array; tool: unknown }): Take {
      const tool = typeof input.tool === "string" && input.tool.trim() ? input.tool.trim().slice(0, 80) : "";
      if (!tool) throw new StoreError("invalid", "Say which tool made this file (e.g. Flow).", [{ path: "tool", message: "Required" }]);
      if (input.bytes.byteLength === 0) throw new StoreError("invalid", "The file is empty.", [{ path: "file", message: "Empty file" }]);
      if (input.bytes.byteLength > MAX_TAKE_BYTES) throw new StoreError("invalid", "Files are limited to 500 MB.", [{ path: "file", message: "Too large" }]);
      const p = requireProduction(projectId, productionId);
      const s = shot(p.id, p.manifest, slotId);
      const id = storeTake(projectId, productionId, s, { bytes: input.bytes, filename: input.filename, source: "manual_upload", provider: "manual", model: null, promptVersion: s.prompts[0]?.version ?? null, tool, jobId: null });
      ctx.logActivity(projectId, "production_upload", `Take uploaded (${tool}) for ${s.scene.title}`);
      return shot(p.id, p.manifest, slotId).takes.find((t) => t.id === id)!;
    },

    review(projectId: string, productionId: string, takeId: string, input: { decision: unknown; note: unknown; confirmations: unknown }): void {
      const decision = input.decision === "approve" || input.decision === "reject" ? input.decision : null;
      if (!decision) throw new StoreError("invalid", "Approve or reject.");
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
      const conf = (input.confirmations ?? {}) as Record<string, unknown>;
      transaction(db, () => {
        const p = requireProduction(projectId, productionId);
        const r = db.prepare("select * from production_takes where id = ? and production_id = ?").get(takeId, productionId) as Row | undefined;
        if (!r) throw new StoreError("not_found", "Take not found.");
        const take = toTake(r);
        const s = shot(p.id, p.manifest, take.slotId);
        if (decision === "reject") {
          if (!note) throw new StoreError("invalid", "Say why it was rejected, so the next take can fix it.", [{ path: "note", message: "Required" }]);
          if (s.approvedTakeId === takeId) db.prepare("update production_shots set approved_take_id = null where production_id = ? and slot_id = ?").run(productionId, take.slotId);
          db.prepare("update production_takes set review = 'rejected', review_note = ?, reviewed_at = ? where id = ?").run(note, now(), takeId);
        } else {
          if (!take.passed) throw new StoreError("invalid", `This take fails its checks: ${take.checks.filter((c) => !c.passed).map((c) => c.message).join("; ")}.`);
          const needed = ["plays", "noText", ...(s.slot.kind === "loop" ? ["loop"] : [])] as (keyof typeof REVIEW_CONFIRMATIONS)[];
          const missing = needed.filter((k) => conf[k] !== true);
          if (missing.length) throw new StoreError("invalid", `Confirm before approving: ${missing.map((k) => REVIEW_CONFIRMATIONS[k]).join("; ")}.`, missing.map((k) => ({ path: `confirmations.${k}`, message: "Required" })));
          if (s.blockedReason) throw new StoreError("conflict", "This shot is marked blocked. Unblock it first.");
          db.prepare("update production_takes set review = 'superseded' where production_id = ? and slot_id = ? and review = 'approved'").run(productionId, take.slotId);
          db.prepare("update production_takes set review = 'approved', review_note = ?, confirmations = ?, reviewed_at = ? where id = ?").run(note, JSON.stringify(Object.fromEntries(needed.map((k) => [k, true]))), now(), takeId);
          db.prepare("update production_shots set approved_take_id = ? where production_id = ? and slot_id = ?").run(takeId, productionId, take.slotId);
        }
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, `production_take_${decision}`, `Take ${decision === "approve" ? "approved" : "rejected"} for ${s.scene.title}`);
      });
    },

    setBlocked(projectId: string, productionId: string, slotId: string, reason: string | null): void {
      const r = reason?.trim() ?? null;
      if (reason !== null && !r) throw new StoreError("invalid", "Say why the shot is blocked.", [{ path: "reason", message: "Required" }]);
      transaction(db, () => {
        const p = requireProduction(projectId, productionId);
        const s = shot(p.id, p.manifest, slotId);
        if (r && s.approvedTakeId) throw new StoreError("conflict", "This shot has an approved take; reject it first if it should be blocked.");
        db.prepare("update production_shots set blocked_reason = ? where production_id = ? and slot_id = ?").run(r ? r.slice(0, 1000) : null, productionId, slotId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "production_blocked", r ? `Shot blocked: ${s.scene.title}` : `Shot unblocked: ${s.scene.title}`);
      });
    },

    readTake(projectId: string, productionId: string, takeId: string) {
      requireProduction(projectId, productionId);
      const r = db.prepare("select * from production_takes where id = ? and production_id = ?").get(takeId, productionId) as Row | undefined;
      if (!r) throw new StoreError("not_found", "Take not found.");
      const take = toTake(r);
      return { take, bytes: files.read(take.file.storageKey) };
    },

    // The WF-07 → WF-08 handoff.
    assetManifest(projectId: string, productionId: string): AssetManifest {
      const project = ctx.requireProject(projectId);
      const { production: p, shots } = self.get(projectId, productionId);
      const scenes = p.manifest.scenes.map((sc) => ({
        sceneId: sc.id,
        title: sc.title,
        slots: sc.assetSlots.map((slot) => {
          const s = shots.find((x) => x.slotId === slot.id)!;
          const take = s.takes.find((t) => t.id === s.approvedTakeId) ?? null;
          const job = take?.jobId ? s.jobs.find((j) => j.id === take.jobId) : undefined;
          return {
            slotId: slot.id,
            kind: slot.kind,
            label: slot.label,
            required: slot.required,
            status: take ? ("approved" as const) : s.blockedReason ? ("blocked" as const) : ("missing" as const),
            blockedReason: s.blockedReason,
            asset: take
              ? {
                  takeId: take.id,
                  url: `/api/projects/${projectId}/production/${productionId}/takes/${take.id}/file`,
                  mimeType: take.file.mimeType,
                  sizeBytes: take.file.sizeBytes,
                  sha256: take.file.sha256,
                  durationSeconds: take.media.durationSeconds,
                  width: take.media.width,
                  height: take.media.height,
                  source: take.source,
                  provider: take.provider,
                  model: take.model,
                  providerJobId: job?.providerJobId ?? null,
                  promptVersion: take.promptVersion,
                  approvedAt: take.reviewedAt!,
                }
              : null,
          };
        }),
      }));
      const all = scenes.flatMap((s) => s.slots);
      return AssetManifest.parse({
        schema: ASSET_MANIFEST_SCHEMA,
        generatedAt: now(),
        project: { id: project.id, slug: project.slug },
        journey: { id: p.manifest.journey.id, key: p.manifest.journey.key, version: p.journeyVersion },
        productionId,
        complete: all.filter((s) => s.required).every((s) => s.status === "approved"),
        preparation: "All media is produced, checked and approved before publication. Nothing is generated per visitor.",
        scenes,
        counts: { slots: all.length, approved: all.filter((s) => s.status === "approved").length, blocked: all.filter((s) => s.status === "blocked").length, missing: all.filter((s) => s.status === "missing").length },
      });
    },

    providerStatus: () =>
      (Object.keys(ctx.providers) as ProviderId[]).map((id) => ({ id, configured: ctx.providers[id].configured, missingConfig: ctx.providers[id].missingConfig, capabilities: ctx.providers[id].capabilities })),
  };
  return self;
}

export type ProductionStore = ReturnType<typeof createProductionStore>;

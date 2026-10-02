import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now, StoreError, type Row } from "./errors";
import type { FileStore } from "./files";

// Persistence for website-template generation jobs (migration 10). Rows and
// the stored ZIP artifact only: the pipeline that moves a job through its
// stages lives in src/server/pipeline/template-pipeline.ts.

export const STAGE_KEYS = ["sar", "artifact", "wf02", "wf03", "wf04", "wf05"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageStatus = "pending" | "running" | "done" | "waiting" | "blocked" | "failed" | "cancelled";
export type Stage = { status: StageStatus; startedAt: string | null; completedAt: string | null; detail: string | null; error: string | null };
export type JobStatus = "queued" | "running" | "waiting" | "completed" | "blocked" | "failed" | "cancelled";
export const ACTIVE_STATUSES: JobStatus[] = ["queued", "running"];

export type TemplateJob = {
  id: string;
  projectId: string;
  sourceUrl: string;
  authority: "study_only" | "client_owned";
  authorizedBy: string;
  options: { maxPages: number; maxDepth: number; maxMinutes: number };
  status: JobStatus;
  stage: string;
  stages: Record<StageKey, Stage>;
  progress: { discovered: number; captured: number; failed: number; pending: number } | null;
  locked: boolean;
  sarJobId: string | null;
  pid: number | null;
  cancelRequested: boolean;
  sarOutputSha256: string | null;
  artifact: { key: string; filename: string; bytes: number; sha256: string } | null;
  referenceId: string | null;
  captureId: string | null;
  sourceId: string | null;
  scanId: string | null;
  scanDigest: string | null;
  brandId: string | null;
  pagesGenerated: boolean;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
};

const emptyStage = (): Stage => ({ status: "pending", startedAt: null, completedAt: null, detail: null, error: null });
export const freshStages = () => Object.fromEntries(STAGE_KEYS.map((k) => [k, emptyStage()])) as Record<StageKey, Stage>;

const toJob = (r: Row): TemplateJob => ({
  id: String(r.id),
  projectId: String(r.project_id),
  sourceUrl: String(r.source_url),
  authority: r.authority as TemplateJob["authority"],
  authorizedBy: String(r.authorized_by),
  options: JSON.parse(String(r.options)),
  status: r.status as JobStatus,
  stage: String(r.stage),
  stages: { ...freshStages(), ...JSON.parse(String(r.stages)) },
  progress: r.progress ? JSON.parse(String(r.progress)) : null,
  locked: r.run_lock != null,
  sarJobId: (r.sar_job_id as string | null) ?? null,
  pid: r.pid == null ? null : Number(r.pid),
  cancelRequested: Boolean(Number(r.cancel_requested)),
  sarOutputSha256: (r.sar_output_sha256 as string | null) ?? null,
  artifact: r.artifact_key ? { key: String(r.artifact_key), filename: String(r.artifact_filename), bytes: Number(r.artifact_bytes), sha256: String(r.artifact_sha256) } : null,
  referenceId: (r.reference_id as string | null) ?? null,
  captureId: (r.capture_id as string | null) ?? null,
  sourceId: (r.source_id as string | null) ?? null,
  scanId: (r.scan_id as string | null) ?? null,
  scanDigest: (r.scan_digest as string | null) ?? null,
  brandId: (r.brand_id as string | null) ?? null,
  pagesGenerated: Boolean(Number(r.pages_generated)),
  error: r.error_code ? { code: String(r.error_code), message: String(r.error_message ?? "") } : null,
  createdAt: String(r.created_at),
  startedAt: (r.started_at as string | null) ?? null,
  completedAt: (r.completed_at as string | null) ?? null,
  cancelledAt: (r.cancelled_at as string | null) ?? null,
  updatedAt: String(r.updated_at),
});

export function createTemplateJobStore(ctx: { db: DatabaseSync; files: FileStore; requireProject: (id: string) => unknown }) {
  const { db, files } = ctx;
  const row = (id: string) => db.prepare("select * from template_jobs where id = ?").get(id) as Row | undefined;

  const self = {
    // Inserts a job that holds the run lock. Fails with "busy" if another run holds it.
    createLocked(projectId: string, input: { sourceUrl: string; authority: TemplateJob["authority"]; authorizedBy: string; options: TemplateJob["options"] }): TemplateJob {
      ctx.requireProject(projectId);
      const id = `tpl_${randomBytes(15).toString("base64url")}`;
      const at = now();
      try {
        db.prepare(
          "insert into template_jobs (id, project_id, source_url, authority, authorized_by, options, status, stage, stages, run_lock, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'queued', 'starting', ?, 'sar', ?, ?)",
        ).run(id, projectId, input.sourceUrl, input.authority, input.authorizedBy, JSON.stringify(input.options), JSON.stringify(freshStages()), at, at);
      } catch (e) {
        if (/UNIQUE constraint failed: template_jobs\.run_lock/.test((e as Error).message)) {
          throw new StoreError("conflict", "SaveAllResources is busy generating another website template. Try again when it has finished.");
        }
        throw e;
      }
      return toJob(row(id)!);
    },

    // For the pipeline (no project check: it already holds the job id).
    byId: (id: string): TemplateJob | null => {
      const r = row(id);
      return r ? toJob(r) : null;
    },

    get(projectId: string, id: string): TemplateJob {
      ctx.requireProject(projectId);
      const r = row(id);
      // Another project's job is reported exactly like a missing one.
      if (!r || r.project_id !== projectId) throw new StoreError("not_found", "Template job not found.");
      return toJob(r);
    },

    list(projectId: string, limit = 10): TemplateJob[] {
      ctx.requireProject(projectId);
      return (db.prepare("select * from template_jobs where project_id = ? order by created_at desc, rowid desc limit ?").all(projectId, limit) as Row[]).map(toJob);
    },

    lockHolders: (): TemplateJob[] => (db.prepare("select * from template_jobs where run_lock is not null").all() as Row[]).map(toJob),
    unfinished: (): TemplateJob[] => (db.prepare("select * from template_jobs where status in ('queued', 'running')").all() as Row[]).map(toJob),
    waitingIn: (projectId: string): TemplateJob[] => (db.prepare("select * from template_jobs where project_id = ? and status = 'waiting'").all(projectId) as Row[]).map(toJob),

    update(id: string, fields: Record<string, unknown>) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const values = keys.map((k) => {
        const v = fields[k];
        return (v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v) as never;
      });
      db.prepare(`update template_jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ?`).run(...values, now(), id);
    },

    // The SaveAllResources ZIP, stored byte for byte. Idempotent.
    storeArtifact(job: TemplateJob, filename: string, bytes: Uint8Array): TemplateJob {
      if (job.artifact) return job;
      const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "website-template.zip";
      const key = `${job.projectId}/template-jobs/${job.id}/${safe}`;
      files.storeThenRecord(key, bytes, ({ sha256, sizeBytes }) => self.update(job.id, { artifact_key: key, artifact_filename: safe, artifact_bytes: sizeBytes, artifact_sha256: sha256 }));
      return self.byId(job.id)!;
    },

    readArtifact(job: TemplateJob): Uint8Array {
      if (!job.artifact) throw new StoreError("not_found", "This job has no stored artifact.");
      return new Uint8Array(files.read(job.artifact.key));
    },
  };
  return self;
}

export type TemplateJobStore = ReturnType<typeof createTemplateJobStore>;

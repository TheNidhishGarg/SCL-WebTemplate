import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MAX_CAPTURE_BYTES, normaliseReferenceUrl } from "@/domain/reference";
import { readSaveAllResourcesExport, registerSarExport } from "@/server/integrations/save-all-resources";
import { packageSarCapture, type CaptureResult } from "@/server/integrations/sar-package";
import { transaction } from "./db";
import { now, StoreError, type Row } from "./errors";
import type { FileStore } from "./files";

// WF-02 captures made by the SaveAllResources extension in the user's own
// Chrome and sent straight to Web.
//
// Web's side of the extension's documented protocol, written for Web: a job
// per capture, tied to one project and one reference; an upload token that
// is random, shown once, stored only as a hash, valid for this job alone and
// for a limited time, and revoked when the job ends. The extension uploads
// one ZIP per page, reports progress, then reports completion; Web then
// packages the pages, and only a complete, consistent capture becomes a
// WF-02 capture and a study-only WF-03 source. A failed, cancelled or
// incompletely uploaded capture creates neither.

export const SAR_JOB_ID = /^sar_[A-Za-z0-9_-]{16,40}$/;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const ACTIVE = ["awaiting_extension", "capturing"] as const;
export const CAPTURE_STATUSES = ["awaiting_extension", "capturing", "completed", "completed_with_warnings", "failed", "cancelled"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

// Extension options Web sets (names and ranges from the extension's protocol).
// The byte budget keeps the packaged capture under the WF-02 limit
// (MAX_CAPTURE_BYTES): the package holds each page ZIP as uploaded plus its
// extracted files, so the capture itself gets 40% of the limit.
export const CAPTURE_DEFAULTS = { maxPages: 10, maxDurationMs: 15 * 60_000, maxTotalBytes: Math.floor(MAX_CAPTURE_BYTES * 0.4) };
export const MAX_PAGES_LIMIT = 25;
const TOKEN_GRACE_MS = 10 * 60_000;

// Authentication failures for the extension's upload routes (401/403), kept
// apart from StoreError so a wrong token never says which part was wrong.
export class CaptureAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "CaptureAuthError";
  }
}

export type CaptureJob = {
  id: string;
  projectId: string;
  referenceId: string;
  url: string;
  options: typeof CAPTURE_DEFAULTS;
  status: CaptureStatus;
  progress: { discovered: number; captured: number; failed: number; pending: number; uploaded: number } | null;
  error: string | null;
  warnings: string[];
  pagesReceived: number;
  captureId: string | null;
  sourceId: string | null;
  tokenExpiresAt: number;
  createdAt: string;
  updatedAt: string;
};

const ProgressBody = z.object({
  progress: z
    .object({ discovered: z.number(), captured: z.number(), failed: z.number(), pending: z.number(), uploaded: z.number() })
    .partial()
    .passthrough()
    .optional(),
});
const CompleteBody = z
  .object({
    status: z.string().max(40).optional(),
    cancelled: z.boolean().optional(),
    startedAt: z.number().nullish(),
    finishedAt: z.number().nullish(),
    discoveryComplete: z.boolean().nullish(),
    errors: z.array(z.string()).optional(),
    pages: z.array(z.object({ id: z.string().max(100), status: z.string().max(40).optional() }).passthrough()).max(1000).optional(),
  })
  .passthrough();

type Deps = {
  db: DatabaseSync;
  files: FileStore;
  requireProject: (id: string) => unknown;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  references: Parameters<typeof registerSarExport>[0]["references"];
  sources: Parameters<typeof registerSarExport>[0]["sources"];
};

const hashToken = (t: string) => createHash("sha256").update(t).digest();

export function createSarCaptureStore(ctx: Deps) {
  const { db, files } = ctx;

  const toJob = (r: Row): CaptureJob => ({
    id: String(r.id),
    projectId: String(r.project_id),
    referenceId: String(r.reference_id),
    url: String(r.url),
    options: JSON.parse(String(r.options)),
    status: r.status as CaptureStatus,
    progress: r.progress ? JSON.parse(String(r.progress)) : null,
    error: (r.error as string | null) ?? null,
    warnings: JSON.parse(String(r.warnings)),
    pagesReceived: Number((db.prepare("select count(*) as n from sar_capture_pages where job_id = ?").get(r.id as string) as Row).n),
    captureId: (r.capture_id as string | null) ?? null,
    sourceId: (r.source_id as string | null) ?? null,
    tokenExpiresAt: Number(r.token_expires_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  });

  const row = (projectId: string, jobId: string) => db.prepare("select * from sar_capture_jobs where id = ? and project_id = ?").get(jobId, projectId) as Row | undefined;

  const set = (jobId: string, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.prepare(`update sar_capture_jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ?`).run(...keys.map((k) => fields[k] as never), now(), jobId);
  };

  // Ends a job: revokes its token and drops the uploaded page files (a
  // completed capture keeps them inside its stored package).
  const finish = (jobId: string, fields: Record<string, unknown>) => {
    const keys = (db.prepare("select storage_key from sar_capture_pages where job_id = ?").all(jobId) as Row[]).map((r) => String(r.storage_key));
    transaction(db, () => {
      set(jobId, { ...fields, token_hash: null });
      db.prepare("delete from sar_capture_pages where job_id = ?").run(jobId);
    });
    for (const k of keys) files.remove(k);
  };

  // A job whose token has run out while still active can never finish.
  const expireIfStale = (r: Row) => {
    if ((ACTIVE as readonly string[]).includes(String(r.status)) && Number(r.token_expires_at) < Date.now()) {
      finish(String(r.id), { status: "failed", error: "The capture did not finish before its upload permission expired. Nothing was registered." });
      return row(String(r.project_id), String(r.id))!;
    }
    return r;
  };

  const self = {
    // Creates the job and its one-time upload permission. The token is
    // returned here once, for the dashboard page to hand to the extension.
    start(projectId: string, input: { url: unknown; maxPages?: unknown }, uploadOrigin: string) {
      ctx.requireProject(projectId);
      const url = typeof input.url === "string" ? normaliseReferenceUrl(input.url) : null;
      if (!url) throw new StoreError("invalid", "Enter a full http(s) URL without a username or password.", [{ path: "url", message: "Enter a full http(s) URL" }]);
      const maxPages = input.maxPages === undefined ? CAPTURE_DEFAULTS.maxPages : Number(input.maxPages);
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) throw new StoreError("invalid", `Capture between 1 and ${MAX_PAGES_LIMIT} pages.`, [{ path: "maxPages", message: "Out of range" }]);
      for (const r of db.prepare("select * from sar_capture_jobs where project_id = ? and status in ('awaiting_extension', 'capturing')").all(projectId) as Row[]) {
        if ((ACTIVE as readonly string[]).includes(String(expireIfStale(r).status))) throw new StoreError("conflict", "A capture is already running for this project. Wait for it, or cancel it.");
      }
      const options = { ...CAPTURE_DEFAULTS, maxPages };
      const token = randomBytes(32).toString("base64url");
      const jobId = `sar_${randomBytes(18).toString("base64url")}`;
      const expiresAt = Date.now() + options.maxDurationMs + TOKEN_GRACE_MS;
      // The reference for this URL, created if the library does not have it yet.
      const refId = ctx.references.list(projectId).find((v) => v.reference.url === url)?.reference.id ?? ctx.references.add(projectId, { url, label: "", pageType: "" }).id;
      const at = now();
      db.prepare(
        "insert into sar_capture_jobs (id, project_id, reference_id, url, options, status, token_hash, token_expires_at, cancel_requested, progress, error, warnings, capture_id, source_id, created_at, updated_at) values (?, ?, ?, ?, ?, 'awaiting_extension', ?, ?, 0, null, null, '[]', null, null, ?, ?)",
      ).run(jobId, projectId, refId, url, JSON.stringify(options), hashToken(token).toString("hex"), expiresAt, at, at);
      ctx.logActivity(projectId, "sar_capture_started", `SaveAllResources capture started: ${url}`);
      return {
        job: toJob(row(projectId, jobId)!),
        // The startCapture message for the extension.
        message: { v: 1, type: "startCapture", jobId, url, options, upload: { endpoint: `${uploadOrigin}/api/projects/${projectId}/capture-jobs/${jobId}`, token, expiresAt } },
      };
    },

    get(projectId: string, jobId: string): CaptureJob {
      ctx.requireProject(projectId);
      const r = row(projectId, jobId);
      if (!r) throw new StoreError("not_found", "Capture job not found.");
      return toJob(expireIfStale(r));
    },

    list(projectId: string): CaptureJob[] {
      ctx.requireProject(projectId);
      return (db.prepare("select * from sar_capture_jobs where project_id = ? order by created_at desc limit 20").all(projectId) as Row[]).map((r) => toJob(expireIfStale(r)));
    },

    // The extension never started (not installed, refused, busy): end the job.
    abandon(projectId: string, jobId: string, reason: unknown) {
      const j = self.get(projectId, jobId);
      if (j.status !== "awaiting_extension") return j;
      finish(jobId, { status: "failed", error: `The extension did not start the capture: ${String(reason ?? "no reason given").slice(0, 400)}` });
      return self.get(projectId, jobId);
    },

    cancel(projectId: string, jobId: string) {
      const j = self.get(projectId, jobId);
      if (!(ACTIVE as readonly string[]).includes(j.status)) throw new StoreError("conflict", "This capture has already ended.");
      // The token stays valid so the extension can still report completion; uploads are refused.
      set(jobId, { status: "cancelled", cancel_requested: 1, error: "Cancelled in Web. Nothing was registered." });
      return self.get(projectId, jobId);
    },

    // ---- extension side: every call is authorised by the job's own token ----

    authorize(projectId: string, jobId: string, authorization: string | null, origin: string | null, extensionId: string): Row {
      // Only the configured extension (or a client sending no Origin, like curl) may call.
      if (origin && origin !== `chrome-extension://${extensionId}`) throw new CaptureAuthError("This origin may not upload captures.", 403);
      const token = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(authorization ?? "")?.[1];
      const r = SAR_JOB_ID.test(jobId) ? row(projectId, jobId) : undefined;
      // One message for every failure: unknown job, other project, revoked, expired or wrong token.
      const denied = new CaptureAuthError("Invalid or expired upload token.", 401);
      if (!token || !r || !r.token_hash || Number(r.token_expires_at) < Date.now()) throw denied;
      const expected = Buffer.from(String(r.token_hash), "hex");
      const given = hashToken(token);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw denied;
      return r;
    },

    receivePage(r: Row, pageId: string, bytes: Uint8Array): { pageId: string; bytes: number } {
      const jobId = String(r.id);
      const projectId = String(r.project_id);
      if (r.status === "cancelled" || Number(r.cancel_requested)) throw new StoreError("conflict", "This capture was cancelled.");
      if (!(ACTIVE as readonly string[]).includes(String(r.status))) throw new StoreError("conflict", "This capture has already ended.");
      if (!PAGE_ID.test(pageId)) throw new StoreError("invalid", "Invalid page id.");
      if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new StoreError("invalid", "The page package is not a ZIP archive.");
      const others = Number((db.prepare("select coalesce(sum(size_bytes), 0) as n from sar_capture_pages where job_id = ? and page_id != ?").get(jobId, pageId) as Row).n);
      if (others + bytes.byteLength > MAX_CAPTURE_BYTES) throw new StoreError("invalid", `The capture exceeds the ${MAX_CAPTURE_BYTES / 1024 / 1024} MB limit for WF-02 captures.`, [{ path: "file", message: "Too large" }]);
      const key = `${projectId}/sar-jobs/${jobId}/${pageId}.zip`;
      files.storeThenRecord(key, bytes, ({ sha256, sizeBytes }) =>
        transaction(db, () => {
          db.prepare("insert into sar_capture_pages (job_id, page_id, storage_key, size_bytes, sha256, received_at) values (?, ?, ?, ?, ?, ?) on conflict (job_id, page_id) do update set size_bytes = excluded.size_bytes, sha256 = excluded.sha256, received_at = excluded.received_at").run(
            jobId,
            pageId,
            key,
            sizeBytes,
            sha256,
            now(),
          );
          set(jobId, { status: "capturing" });
        }),
      );
      return { pageId, bytes: bytes.byteLength };
    },

    progress(r: Row, body: unknown): { cancelled: boolean } {
      const p = ProgressBody.safeParse(body);
      if (p.success && p.data.progress && (ACTIVE as readonly string[]).includes(String(r.status))) {
        const g = p.data.progress;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
        set(String(r.id), { status: "capturing", progress: JSON.stringify({ discovered: n(g.discovered), captured: n(g.captured), failed: n(g.failed), pending: n(g.pending), uploaded: n(g.uploaded) }) });
      }
      return { cancelled: r.status === "cancelled" || Boolean(Number(r.cancel_requested)) };
    },

    // The extension's final report. Packages what arrived and registers it
    // only if the capture is complete and consistent.
    complete(r: Row, body: unknown): { status: CaptureStatus } {
      const jobId = String(r.id);
      const projectId = String(r.project_id);
      if (!(ACTIVE as readonly string[]).includes(String(r.status))) {
        // Cancelled (or otherwise ended): just close it.
        finish(jobId, {});
        return { status: r.status as CaptureStatus };
      }
      const parsed = CompleteBody.safeParse(body);
      if (!parsed.success) {
        finish(jobId, { status: "failed", error: "The extension's completion report could not be read. Nothing was registered." });
        return { status: "failed" };
      }
      const result = parsed.data as CaptureResult & z.infer<typeof CompleteBody>;
      const fail = (error: string) => {
        finish(jobId, { status: "failed", error });
        ctx.logActivity(projectId, "sar_capture_failed", `SaveAllResources capture failed: ${String(r.url)}`);
        return { status: "failed" as const };
      };
      if (result.cancelled || result.status === "cancelled") {
        finish(jobId, { status: "cancelled", error: "Cancelled in the extension. Nothing was registered." });
        return { status: "cancelled" };
      }
      const uploaded = new Map(
        (db.prepare("select page_id, storage_key from sar_capture_pages where job_id = ?").all(jobId) as Row[]).map((p) => [String(p.page_id), new Uint8Array(files.read(String(p.storage_key)))]),
      );
      if (result.status === "failed" && uploaded.size === 0) return fail(`The capture failed in the browser: ${(result.errors ?? []).slice(0, 3).join("; ") || "no reason given"}. Nothing was registered.`);

      const pkg = packageSarCapture({ jobId, entryUrl: String(r.url), createdAt: String(r.created_at), result, uploads: uploaded });
      if (pkg.pages.missing.length) return fail(`${pkg.pages.missing.length} captured page(s) never reached Web (${pkg.pages.missing.slice(0, 5).join(", ")}). Nothing was registered; capture again.`);
      if (pkg.pages.corrupt.length) return fail(`${pkg.pages.corrupt.length} page package(s) could not be read (${pkg.pages.corrupt.slice(0, 3).map((c) => `${c.id}: ${c.reason}`).join("; ")}). Nothing was registered.`);
      if (pkg.pages.packaged.length === 0) return fail("No page was captured. Nothing was registered.");
      if (pkg.zip.byteLength > MAX_CAPTURE_BYTES) return fail(`The packaged capture is ${(pkg.zip.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${MAX_CAPTURE_BYTES / 1024 / 1024} MB WF-02 limit. Nothing was registered; capture fewer pages.`);

      const warnings: string[] = [];
      if (pkg.pages.notCaptured) warnings.push(`${pkg.pages.notCaptured} discovered page(s) were not captured (limits, access or aliases); see the manifest.`);
      if (result.discoveryComplete === false) warnings.push("Discovery stopped at a limit; the site has more pages than were captured.");
      if (result.status === "failed") warnings.push("The extension reported the capture as failed after some pages were captured.");

      try {
        const x = readSaveAllResourcesExport(pkg.zip);
        const reg = registerSarExport(ctx, projectId, String(r.reference_id), x, { filename: `${jobId}-capture.zip`, bytes: pkg.zip });
        const status: CaptureStatus = warnings.length ? "completed_with_warnings" : "completed";
        finish(jobId, { status, warnings: JSON.stringify(warnings), capture_id: reg.captureId, source_id: reg.sourceId, error: null });
        ctx.logActivity(projectId, "sar_capture_completed", `SaveAllResources capture registered: ${pkg.pages.packaged.length} page(s) of ${String(r.url)}`);
        return { status };
      } catch (e) {
        if ((e as Error).name !== "StoreError") throw e;
        return fail(`The capture could not be registered: ${(e as Error).message}`);
      }
    },
  };
  return self;
}

export type SarCaptureStore = ReturnType<typeof createSarCaptureStore>;

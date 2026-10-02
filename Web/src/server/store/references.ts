import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ClientBrief } from "@/domain/client-brief";
import type { Project } from "@/domain/project";
import {
  ALLOWED_CAPTURE_EXTENSIONS,
  Attempt,
  Capture,
  CaptureMeta,
  isSuccessfulOutcome,
  MAX_CAPTURE_BYTES,
  ManualReasonInput,
  Observation,
  ObservationInput,
  OUTCOME_LABELS,
  REFERENCE_USAGE_NOTICE,
  ReferenceInput,
  ReferenceSource,
  referenceStatus,
  ReferenceUpdate,
  UserAttemptInput,
  normaliseReferenceUrl,
  type ReferenceStatus,
} from "@/domain/reference";
import { REFERENCE_LIBRARY_SCHEMA, ReferenceLibrary } from "@/domain/reference-library";
import { fileExtension } from "@/domain/asset";
import type { CheckResult } from "@/server/reference-check";
import { transaction } from "./db";
import { issuesFrom, now, StoreError, type Row } from "./errors";
import type { FileStore } from "./files";

// WF-02 persistence. Same rules as the WF-01 store: every write is one
// transaction with its activity entry, files are stored before their row and
// removed if the row fails, and rows are parsed back through the domain
// schemas on the way out.

export type ReferenceView = {
  reference: ReferenceSource;
  status: ReferenceStatus;
  attempts: Attempt[]; // newest first
  captures: Capture[];
  observations: Observation[];
};

type Context = {
  db: DatabaseSync;
  files: FileStore;
  requireProject: (id: string) => Project;
  approvedBrief: (projectId: string) => ClientBrief | null;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  checkUrl: (url: string) => Promise<CheckResult>;
};

const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;

const toReference = (r: Row): ReferenceSource =>
  ReferenceSource.parse({
    id: r.id,
    projectId: r.project_id,
    url: r.url,
    host: r.host,
    label: r.label,
    pageType: r.page_type,
    targetPages: json(r.target_pages),
    attribution: r.attribution,
    origin: r.origin,
    briefVersion: r.brief_version ?? null,
    manualReason: r.manual_reason ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const toAttempt = (r: Row): Attempt =>
  Attempt.parse({
    id: r.id,
    method: r.method,
    recordedBy: r.recorded_by,
    outcome: r.outcome,
    httpStatus: r.http_status ?? null,
    finalUrl: r.final_url ?? null,
    redirectChain: json(r.redirect_chain),
    pageTitle: r.page_title ?? null,
    contentType: r.content_type ?? null,
    detail: r.detail,
    inferences: json(r.inferences),
    createdAt: r.created_at,
  });

const toCapture = (r: Row): Capture =>
  Capture.parse({
    id: r.id,
    kind: r.kind,
    tool: r.tool,
    sourceUrl: r.source_url,
    capturedOn: r.captured_on,
    notes: r.notes,
    file: { storageKey: r.storage_key, filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, sha256: r.sha256 },
    createdAt: r.created_at,
  });

const toObservation = (r: Row): Observation =>
  Observation.parse({
    id: r.id,
    aspect: r.aspect,
    basis: r.basis,
    text: r.text,
    captureId: r.capture_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const referenceDir = (projectId: string, referenceId: string) => `${projectId}/references/${referenceId}`;

export function createReferenceStore(ctx: Context) {
  const { db, files } = ctx;

  const requireReference = (projectId: string, referenceId: string): ReferenceSource => {
    ctx.requireProject(projectId);
    const row = db.prepare("select * from reference_sources where id = ? and project_id = ?").get(referenceId, projectId) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Reference not found.");
    return toReference(row);
  };

  const view = (reference: ReferenceSource): ReferenceView => {
    const attempts = (db.prepare("select * from reference_attempts where reference_id = ? order by created_at desc, rowid desc").all(reference.id) as Row[]).map(toAttempt);
    const captures = (db.prepare("select * from reference_captures where reference_id = ? order by created_at").all(reference.id) as Row[]).map(toCapture);
    const observations = (db.prepare("select * from reference_observations where reference_id = ? order by created_at").all(reference.id) as Row[]).map(toObservation);
    return { reference, attempts, captures, observations, status: referenceStatus(reference, attempts, captures) };
  };

  const touch = (projectId: string, referenceId: string) => {
    db.prepare("update reference_sources set updated_at = ? where id = ?").run(now(), referenceId);
    ctx.touchProject(projectId);
  };

  const insertAttempt = (referenceId: string, a: Omit<Attempt, "id" | "createdAt">) => {
    db.prepare(
      "insert into reference_attempts (id, reference_id, method, recorded_by, outcome, http_status, final_url, redirect_chain, page_title, content_type, detail, inferences, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      referenceId,
      a.method,
      a.recordedBy,
      a.outcome,
      a.httpStatus,
      a.finalUrl,
      JSON.stringify(a.redirectChain),
      a.pageTitle,
      a.contentType,
      a.detail,
      JSON.stringify(a.inferences),
      now(),
    );
  };

  const insertReference = (projectId: string, url: string, label: string, pageType: string, origin: "brief" | "user", briefVersion: number | null) => {
    const id = randomUUID();
    const at = now();
    db.prepare(
      "insert into reference_sources (id, project_id, url, host, label, page_type, target_pages, attribution, origin, brief_version, manual_reason, created_at, updated_at) values (?, ?, ?, ?, ?, ?, '[]', '', ?, ?, null, ?, ?)",
    ).run(id, projectId, url, new URL(url).hostname, label, pageType, origin, briefVersion, at, at);
    return id;
  };

  const exists = (projectId: string, url: string) =>
    Boolean(db.prepare("select 1 from reference_sources where project_id = ? and url = ?").get(projectId, url));

  const requireCapture = (referenceId: string, captureId: string): Capture => {
    const row = db.prepare("select * from reference_captures where id = ? and reference_id = ?").get(captureId, referenceId) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Capture not found.");
    return toCapture(row);
  };

  const parseOrThrow = <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T => {
    const r = schema.safeParse(input);
    if (!r.success) throw new StoreError("invalid", "Check the highlighted fields.", issuesFrom(r.error));
    return r.data;
  };

  const list = (projectId: string): ReferenceView[] => {
    ctx.requireProject(projectId);
    const rows = db.prepare("select * from reference_sources where project_id = ? order by host, created_at").all(projectId) as Row[];
    return rows.map((r) => view(toReference(r)));
  };

  return {
    list,

    get(projectId: string, referenceId: string): ReferenceView {
      return view(requireReference(projectId, referenceId));
    },

    add(projectId: string, input: unknown): ReferenceSource {
      const data = parseOrThrow(ReferenceInput, input);
      return transaction(db, () => {
        ctx.requireProject(projectId);
        if (exists(projectId, data.url)) {
          throw new StoreError("conflict", "That URL is already in the library.", [{ path: "url", message: "Already in the library" }]);
        }
        const id = insertReference(projectId, data.url, data.label, data.pageType, "user", null);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "reference_added", `Reference added: ${data.label || new URL(data.url).hostname}`);
        return requireReference(projectId, id);
      });
    },

    // Adds the approved brief's reference URLs that are not in the library
    // yet. Safe to run again after a brief revision: existing ones are skipped.
    importFromBrief(projectId: string): { added: number; skipped: number; briefVersion: number } {
      return transaction(db, () => {
        ctx.requireProject(projectId);
        const brief = ctx.approvedBrief(projectId);
        if (!brief?.content) {
          throw new StoreError("conflict", "Approve the client brief first; its reference websites are imported from the approved version.");
        }
        let added = 0;
        let skipped = 0;
        for (const ref of brief.content.referenceUrls) {
          const url = normaliseReferenceUrl(ref.url);
          if (!url || exists(projectId, url)) {
            skipped++;
            continue;
          }
          insertReference(projectId, url, ref.note?.slice(0, 160) ?? "", "", "brief", brief.version);
          added++;
        }
        if (added) {
          ctx.touchProject(projectId);
          ctx.logActivity(projectId, "references_imported", `${added} reference${added === 1 ? "" : "s"} imported from brief version ${brief.version}`);
        }
        return { added, skipped, briefVersion: brief.version };
      });
    },

    update(projectId: string, referenceId: string, input: unknown): ReferenceSource {
      const data = parseOrThrow(ReferenceUpdate, input);
      return transaction(db, () => {
        requireReference(projectId, referenceId);
        // Target pages must be pages the approved brief actually lists.
        const known = new Set(ctx.approvedBrief(projectId)?.content?.requiredPages.map((p) => p.slug) ?? []);
        const unknown = data.targetPages.filter((s) => !known.has(s));
        if (unknown.length) {
          throw new StoreError("invalid", `Not a required page in the approved brief: ${unknown.join(", ")}.`, [{ path: "targetPages", message: "Unknown page" }]);
        }
        db.prepare("update reference_sources set label = ?, page_type = ?, target_pages = ?, attribution = ? where id = ?").run(
          data.label,
          data.pageType,
          JSON.stringify([...new Set(data.targetPages)]),
          data.attribution,
          referenceId,
        );
        touch(projectId, referenceId);
        ctx.logActivity(projectId, "reference_updated", `Reference updated: ${data.label || "untitled"}`);
        return requireReference(projectId, referenceId);
      });
    },

    remove(projectId: string, referenceId: string): void {
      const ref = transaction(db, () => {
        const r = requireReference(projectId, referenceId);
        db.prepare("delete from reference_sources where id = ?").run(referenceId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "reference_removed", `Reference removed: ${r.label || r.url}`);
        return r;
      });
      files.remove(referenceDir(projectId, ref.id));
    },

    // The network call happens outside any transaction (it can take seconds);
    // the result is recorded only if the reference still exists afterwards.
    async runCheck(projectId: string, referenceId: string): Promise<Attempt> {
      const ref = requireReference(projectId, referenceId);
      const result = await ctx.checkUrl(ref.url);
      return transaction(db, () => {
        requireReference(projectId, referenceId);
        insertAttempt(referenceId, { method: "url_check", recordedBy: "system", ...result });
        touch(projectId, referenceId);
        ctx.logActivity(projectId, "reference_checked", `URL check: ${OUTCOME_LABELS[result.outcome]} · ${ref.host}`);
        return view(requireReference(projectId, referenceId)).attempts[0];
      });
    },

    // A person tried to capture the page (with SaveMyResources or otherwise)
    // and could not. Recorded as theirs, not the system's.
    recordFailedAttempt(projectId: string, referenceId: string, input: unknown): void {
      const data = parseOrThrow(UserAttemptInput, input);
      transaction(db, () => {
        const ref = requireReference(projectId, referenceId);
        insertAttempt(referenceId, {
          method: "manual_capture",
          recordedBy: "user",
          outcome: data.outcome,
          httpStatus: null,
          finalUrl: null,
          redirectChain: [],
          pageTitle: null,
          contentType: null,
          detail: data.detail,
          inferences: [],
        });
        touch(projectId, referenceId);
        ctx.logActivity(projectId, "reference_capture_failed", `Capture attempt failed: ${OUTCOME_LABELS[data.outcome]} · ${ref.host}`);
      });
    },

    setManual(projectId: string, referenceId: string, input: unknown | null): void {
      const reason = input === null ? null : parseOrThrow(ManualReasonInput, input).reason;
      transaction(db, () => {
        const ref = requireReference(projectId, referenceId);
        db.prepare("update reference_sources set manual_reason = ? where id = ?").run(reason, referenceId);
        touch(projectId, referenceId);
        ctx.logActivity(
          projectId,
          "reference_manual",
          reason ? `Marked for manual observation: ${ref.host}` : `Manual-only marking cleared: ${ref.host}`,
        );
      });
    },

    addCapture(projectId: string, referenceId: string, meta: unknown, file: { filename: string; mimeType: string; bytes: Uint8Array }): Capture {
      const data = parseOrThrow(CaptureMeta, meta);
      const allowed: readonly string[] = ALLOWED_CAPTURE_EXTENSIONS[data.kind];
      if (!allowed.includes(fileExtension(file.filename))) {
        throw new StoreError("invalid", `This kind of capture must be one of: ${allowed.join(", ")}.`, [{ path: "file", message: "File type not accepted" }]);
      }
      if (file.bytes.byteLength === 0) throw new StoreError("invalid", "The file is empty.", [{ path: "file", message: "Empty file" }]);
      if (file.bytes.byteLength > MAX_CAPTURE_BYTES) {
        throw new StoreError("invalid", `Captures are limited to ${MAX_CAPTURE_BYTES / 1024 / 1024} MB.`, [{ path: "file", message: "File too large" }]);
      }
      if (data.capturedOn > now().slice(0, 10)) {
        throw new StoreError("invalid", "The capture date cannot be in the future.", [{ path: "capturedOn", message: "Date is in the future" }]);
      }
      const ref = requireReference(projectId, referenceId);
      const id = randomUUID();
      const storageKey = `${referenceDir(projectId, referenceId)}/${id}`;
      return files.storeThenRecord(storageKey, file.bytes, ({ sha256, sizeBytes }) =>
        transaction(db, () => {
          requireReference(projectId, referenceId);
          db.prepare(
            "insert into reference_captures (id, reference_id, kind, tool, source_url, captured_on, notes, storage_key, filename, mime_type, size_bytes, sha256, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(id, referenceId, data.kind, data.tool, ref.url, data.capturedOn, data.notes, storageKey, file.filename.slice(0, 255), (file.mimeType || "application/octet-stream").slice(0, 255), sizeBytes, sha256, now());
          insertAttempt(referenceId, {
            method: "manual_capture",
            recordedBy: "user",
            outcome: "captured",
            httpStatus: null,
            finalUrl: null,
            redirectChain: [],
            pageTitle: null,
            contentType: null,
            detail: `${file.filename.slice(0, 120)} uploaded (${data.tool}, captured ${data.capturedOn}).`,
            inferences: [],
          });
          touch(projectId, referenceId);
          ctx.logActivity(projectId, "reference_captured", `Capture added (${data.tool}) · ${ref.host}`);
          return requireCapture(referenceId, id);
        }),
      );
    },

    removeCapture(projectId: string, referenceId: string, captureId: string): void {
      const capture = transaction(db, () => {
        const ref = requireReference(projectId, referenceId);
        const c = requireCapture(referenceId, captureId);
        db.prepare("delete from reference_captures where id = ?").run(captureId);
        touch(projectId, referenceId);
        ctx.logActivity(projectId, "reference_capture_removed", `Capture removed: ${c.file.filename} · ${ref.host}`);
        return c;
      });
      files.remove(capture.file.storageKey);
    },

    readCapture(projectId: string, referenceId: string, captureId: string): { capture: Capture; bytes: Buffer } {
      requireReference(projectId, referenceId);
      const capture = requireCapture(referenceId, captureId);
      return { capture, bytes: files.read(capture.file.storageKey) };
    },

    addObservation(projectId: string, referenceId: string, input: unknown): Observation {
      const data = parseOrThrow(ObservationInput, input);
      return transaction(db, () => {
        const ref = requireReference(projectId, referenceId);
        if (data.captureId) requireCapture(referenceId, data.captureId);
        const id = randomUUID();
        const at = now();
        db.prepare(
          "insert into reference_observations (id, reference_id, aspect, basis, text, capture_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, referenceId, data.aspect, data.basis, data.text, data.captureId, at, at);
        touch(projectId, referenceId);
        ctx.logActivity(projectId, "reference_observation", `${data.basis === "observed" ? "Observation" : "Inference"} added · ${ref.host}`);
        return toObservation(db.prepare("select * from reference_observations where id = ?").get(id) as Row);
      });
    },

    updateObservation(projectId: string, referenceId: string, observationId: string, input: unknown): Observation {
      const data = parseOrThrow(ObservationInput, input);
      return transaction(db, () => {
        requireReference(projectId, referenceId);
        if (data.captureId) requireCapture(referenceId, data.captureId);
        const res = db
          .prepare("update reference_observations set aspect = ?, basis = ?, text = ?, capture_id = ?, updated_at = ? where id = ? and reference_id = ?")
          .run(data.aspect, data.basis, data.text, data.captureId, now(), observationId, referenceId);
        if (res.changes === 0) throw new StoreError("not_found", "Observation not found.");
        touch(projectId, referenceId);
        return toObservation(db.prepare("select * from reference_observations where id = ?").get(observationId) as Row);
      });
    },

    removeObservation(projectId: string, referenceId: string, observationId: string): void {
      transaction(db, () => {
        requireReference(projectId, referenceId);
        const res = db.prepare("delete from reference_observations where id = ? and reference_id = ?").run(observationId, referenceId);
        if (res.changes === 0) throw new StoreError("not_found", "Observation not found.");
        touch(projectId, referenceId);
      });
    },

    // The WF-02 -> WF-03 contract. See src/domain/reference-library.ts.
    library(projectId: string): ReferenceLibrary {
      const project = ctx.requireProject(projectId);
      const brief = ctx.approvedBrief(projectId);
      const views = list(projectId);
      const byStatus: Record<ReferenceStatus, number> = { pending: 0, checked: 0, captured: 0, failed: 0, manual: 0 };
      for (const v of views) byStatus[v.status]++;
      return ReferenceLibrary.parse({
        schema: REFERENCE_LIBRARY_SCHEMA,
        generatedAt: now(),
        usage: REFERENCE_USAGE_NOTICE,
        project: { id: project.id, slug: project.slug, name: project.name },
        brief: brief?.content
          ? { id: brief.id, version: brief.version, requiredPageSlugs: brief.content.requiredPages.map((p) => p.slug) }
          : null,
        summary: { references: views.length, sites: new Set(views.map((v) => v.reference.host)).size, byStatus },
        references: views.map(({ reference: r, status, attempts, captures, observations }) => ({
          id: r.id,
          url: r.url,
          host: r.host,
          label: r.label,
          pageType: r.pageType,
          targetPages: r.targetPages,
          attribution: r.attribution,
          origin: r.origin,
          briefVersion: r.briefVersion,
          status,
          manualReason: r.manualReason,
          evidence: {
            attempts: attempts.map((a) => ({
              id: a.id,
              method: a.method,
              recordedBy: a.recordedBy,
              outcome: a.outcome,
              succeeded: isSuccessfulOutcome(a.outcome),
              httpStatus: a.httpStatus,
              finalUrl: a.finalUrl,
              redirectChain: a.redirectChain,
              pageTitle: a.pageTitle,
              contentType: a.contentType,
              detail: a.detail,
              at: a.createdAt,
            })),
            captures: captures.map((c) => ({
              id: c.id,
              kind: c.kind,
              tool: c.tool,
              sourceUrl: c.sourceUrl,
              capturedOn: c.capturedOn,
              notes: c.notes,
              filename: c.file.filename,
              mimeType: c.file.mimeType,
              sizeBytes: c.file.sizeBytes,
              sha256: c.file.sha256,
              downloadPath: `/api/projects/${projectId}/references/${r.id}/captures/${c.id}/file`,
            })),
          },
          observed: observations
            .filter((o) => o.basis === "observed")
            .map((o) => ({ id: o.id, aspect: o.aspect, text: o.text, captureId: o.captureId, updatedAt: o.updatedAt })),
          inferred: [
            ...observations
              .filter((o) => o.basis === "inferred")
              .map((o) => ({ source: "person" as const, aspect: o.aspect, text: o.text, observationId: o.id, attemptId: null, at: o.updatedAt })),
            ...attempts.flatMap((a) =>
              a.inferences.map((text) => ({ source: "url_check" as const, aspect: null, text, observationId: null, attemptId: a.id, at: a.createdAt })),
            ),
          ],
        })),
      });
    },
  };
}

export type ReferenceStore = ReturnType<typeof createReferenceStore>;

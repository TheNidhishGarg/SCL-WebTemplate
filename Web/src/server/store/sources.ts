import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { strToU8, zipSync } from "fflate";
import { parse, serializeOuter } from "parse5";
import type { ClientBrief } from "@/domain/client-brief";
import type { Project } from "@/domain/project";
import { SourceAnalysis, type Evidence } from "@/domain/source-analysis";
import {
  ANALYST_FINDINGS_SCHEMA,
  AnalystFindings,
  Authorization,
  EXTRACTION_NOTICE,
  extractionAllowed,
  Finding,
  FindingTopic,
  needsBuild,
  QuestionRecord,
  ScanRecord,
  Source,
  SourceRegistration,
  SOURCE_TOKEN_NOTICE,
  Template,
  TEMPLATE_MANIFEST_SCHEMA,
  TemplateManifest,
  type BuildStatus,
} from "@/domain/wf03";
import { slugify } from "@/lib/slug";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { ArchiveError, readArchive, type SourceFile } from "@/server/wf03/archive";
import { buildKit } from "@/server/wf03/kit";
import { analyzeArchive } from "@/server/wf03/scan";
import { transaction } from "./db";
import { issuesFrom, now, StoreError, type Row } from "./errors";
import type { FileStore } from "./files";

// WF-03 persistence and workflow. The scanner is pure; this module decides
// what may happen to a source: it records authority and provenance, keeps
// every scan, refuses to extract from study-only sources, and checks every
// path an analyst cites against the source before accepting it.

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const ANALYSIS_REPORT_SCHEMA = "scl.wf-03.analysis-report/v1";

type Context = {
  db: DatabaseSync;
  files: FileStore;
  workspaceDir: string;
  requireProject: (id: string) => Project;
  approvedBrief: (projectId: string) => ClientBrief | null;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  readCapture: (projectId: string, referenceId: string, captureId: string) => { capture: { kind: string; file: { filename: string } }; bytes: Buffer };
  referenceUrl: (projectId: string, referenceId: string) => string;
};

const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;

const toSource = (r: Row): Source =>
  Source.parse({
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    origin: r.origin,
    originUrl: r.origin_url,
    originRef: r.origin_ref,
    referenceId: r.reference_id ?? null,
    captureId: r.capture_id ?? null,
    authorization: { basis: r.auth_basis, note: r.auth_note, license: r.auth_license },
    archive: { storageKey: r.storage_key, filename: r.filename, sizeBytes: r.size_bytes, sha256: r.sha256 },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const toScan = (r: Row): ScanRecord =>
  ScanRecord.parse({ id: r.id, sourceId: r.source_id, analyzerVersion: r.analyzer_version, digest: r.digest, createdAt: r.created_at });

const toTemplate = (r: Row): Template =>
  Template.parse({
    id: r.id,
    projectId: r.project_id,
    sourceId: r.source_id,
    scanId: r.scan_id,
    candidateKey: r.candidate_key ?? null,
    kind: r.kind,
    name: r.name,
    slug: r.slug,
    description: r.description,
    basis: r.basis,
    rationale: r.rationale,
    origin: r.origin,
    files: json(r.files),
    pages: json(r.pages),
    evidence: json(r.evidence),
    extraction: { status: r.extraction_status, workspacePath: r.workspace_path ?? null, extractedAt: r.extracted_at ?? null },
    build: { status: r.build_status, note: r.build_note, recordedAt: r.build_recorded_at ?? null },
    createdAt: r.created_at,
  });

const toFinding = (r: Row): Finding =>
  Finding.parse({ id: r.id, sourceId: r.source_id, basis: r.basis, topic: r.topic, statement: r.statement, evidence: json(r.evidence), origin: r.origin, createdAt: r.created_at });

const toQuestion = (r: Row): QuestionRecord =>
  QuestionRecord.parse({
    id: r.id,
    sourceId: r.source_id,
    key: r.key ?? null,
    topic: r.topic,
    text: r.text,
    origin: r.origin,
    status: r.status,
    answer: r.answer,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
  });

export type SourceSummary = {
  source: Source;
  latestScan: ScanRecord | null;
  templates: number;
  extracted: number;
  openQuestions: number;
  highRisks: number;
};

export type SourceDetail = {
  source: Source;
  scans: ScanRecord[]; // newest first
  latest: { scan: ScanRecord; analysis: SourceAnalysis } | null;
  templates: Template[];
  findings: Finding[];
  questions: QuestionRecord[];
};

export function createSourceStore(ctx: Context) {
  const { db, files } = ctx;

  const parseOrThrow = <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown, message = "Check the highlighted fields."): T => {
    const r = schema.safeParse(input);
    if (!r.success) throw new StoreError("invalid", message, issuesFrom(r.error));
    return r.data;
  };

  const requireSource = (projectId: string, sourceId: string): Source => {
    ctx.requireProject(projectId);
    const row = db.prepare("select * from wf03_sources where id = ? and project_id = ?").get(sourceId, projectId) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Source not found.");
    return toSource(row);
  };

  const scansOf = (sourceId: string) =>
    (db.prepare("select id, source_id, analyzer_version, digest, created_at from wf03_scans where source_id = ? order by created_at desc, rowid desc").all(sourceId) as Row[]).map(toScan);

  const scanResult = (scanId: string): SourceAnalysis => {
    const row = db.prepare("select result from wf03_scans where id = ?").get(scanId) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Scan not found.");
    return SourceAnalysis.parse(json(row.result));
  };

  const latestOf = (sourceId: string) => {
    const scan = scansOf(sourceId)[0];
    return scan ? { scan, analysis: scanResult(scan.id) } : null;
  };

  const templatesOf = (where: string, arg: string) =>
    (db.prepare(`select * from wf03_templates where ${where} order by kind, name`).all(arg) as Row[]).map(toTemplate);

  const archiveFiles = (source: Source): SourceFile[] => readArchive(new Uint8Array(files.read(source.archive.storageKey))).files;

  const uniqueSlug = (projectId: string, name: string) => {
    const base = slugify(name, 48) || "template";
    let slug = base;
    for (let n = 2; db.prepare("select 1 from wf03_templates where project_id = ? and slug = ?").get(projectId, slug); n++) slug = `${base}-${n}`;
    return slug;
  };

  const insertTemplate = (
    projectId: string,
    sourceId: string,
    scanId: string,
    t: { candidateKey: string | null; kind: string; name: string; description: string; basis: string; rationale: string; origin: string; files: string[]; pages: string[]; evidence: Evidence[] },
  ) => {
    const id = randomUUID();
    const at = now();
    db.prepare(
      "insert into wf03_templates (id, project_id, source_id, scan_id, candidate_key, kind, name, slug, description, basis, rationale, origin, files, pages, evidence, extraction_status, workspace_path, extracted_at, build_status, build_note, build_recorded_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_extracted', null, null, ?, '', null, ?, ?)",
    ).run(
      id,
      projectId,
      sourceId,
      scanId,
      t.candidateKey,
      t.kind,
      t.name.slice(0, 120),
      uniqueSlug(projectId, t.name),
      t.description,
      t.basis,
      t.rationale,
      t.origin,
      JSON.stringify([...new Set(t.files)].sort()),
      JSON.stringify(t.pages),
      JSON.stringify(t.evidence),
      needsBuild(t.files) ? "not_verified" : "not_applicable",
      at,
      at,
    );
    return id;
  };

  // Adds the analyzer's questions that are new for this source. Existing ones
  // keep their answers; ones the latest scan no longer raises stay as they are.
  const syncQuestions = (sourceId: string, analysis: SourceAnalysis) => {
    for (const q of analysis.questions) {
      const exists = db.prepare("select 1 from wf03_questions where source_id = ? and key = ?").get(sourceId, q.key);
      if (!exists) {
        db.prepare("insert into wf03_questions (id, source_id, key, topic, text, origin, status, answer, created_at, resolved_at) values (?, ?, ?, ?, ?, 'analyzer', 'open', '', ?, null)").run(
          randomUUID(),
          sourceId,
          q.key,
          q.topic,
          q.text,
          now(),
        );
      }
    }
  };

  const register = (
    projectId: string,
    meta: { label: string; originUrl: string; originRef: string; authorization: Authorization },
    origin: "upload" | "reference_capture",
    file: { filename: string; bytes: Uint8Array },
    capture: { referenceId: string; captureId: string } | null,
  ): Source => {
    // A WF-02 capture may be as large as WF-02 accepts; a direct upload has its own limit.
    const limit = origin === "reference_capture" ? MAX_CAPTURE_BYTES : MAX_SOURCE_BYTES;
    if (file.bytes.byteLength > limit) {
      throw new StoreError("invalid", `Source archives are limited to ${limit / 1024 / 1024} MB.`, [{ path: "file", message: "File too large" }]);
    }
    // Refuse what cannot be analysed now, not at scan time.
    try {
      readArchive(file.bytes);
    } catch (e) {
      if (e instanceof ArchiveError) throw new StoreError("invalid", e.message, [{ path: "file", message: e.message }]);
      throw e;
    }
    ctx.requireProject(projectId);
    // The same digest the scanner records as its input.
    const sha = createHash("sha256").update(file.bytes).digest("hex");
    if (db.prepare("select 1 from wf03_sources where project_id = ? and sha256 = ?").get(projectId, sha)) {
      throw new StoreError("conflict", "This exact archive is already a source in this project.", [{ path: "file", message: "Already registered" }]);
    }
    const id = randomUUID();
    const key = `${projectId}/sources/${id}.zip`;
    return files.storeThenRecord(key, file.bytes, ({ sizeBytes, sha256 }) =>
      transaction(db, () => {
        const at = now();
        db.prepare(
          "insert into wf03_sources (id, project_id, label, origin, origin_url, origin_ref, reference_id, capture_id, auth_basis, auth_note, auth_license, storage_key, filename, size_bytes, sha256, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          projectId,
          meta.label,
          origin,
          meta.originUrl,
          meta.originRef,
          capture?.referenceId ?? null,
          capture?.captureId ?? null,
          meta.authorization.basis,
          meta.authorization.note,
          meta.authorization.license,
          key,
          file.filename.slice(0, 255),
          sizeBytes,
          sha256,
          at,
          at,
        );
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "source_registered", `Source registered for analysis: ${meta.label}`);
        return requireSource(projectId, id);
      }),
    );
  };

  const workspaceRoot = (projectId: string) => join(ctx.workspaceDir, projectId);

  const self = {
    list(projectId: string): SourceSummary[] {
      ctx.requireProject(projectId);
      const rows = db.prepare("select * from wf03_sources where project_id = ? order by created_at").all(projectId) as Row[];
      return rows.map((r) => {
        const source = toSource(r);
        const latest = latestOf(source.id);
        const templates = templatesOf("source_id = ?", source.id);
        const open = (db.prepare("select count(*) as n from wf03_questions where source_id = ? and status = 'open'").get(source.id) as { n: number }).n;
        return {
          source,
          latestScan: latest?.scan ?? null,
          templates: templates.length,
          extracted: templates.filter((t) => t.extraction.status === "extracted").length,
          openQuestions: open,
          highRisks: latest ? latest.analysis.risks.filter((x) => x.severity === "high").length : 0,
        };
      });
    },

    get(projectId: string, sourceId: string): SourceDetail {
      const source = requireSource(projectId, sourceId);
      return {
        source,
        scans: scansOf(sourceId),
        latest: latestOf(sourceId),
        templates: templatesOf("source_id = ?", sourceId),
        findings: (db.prepare("select * from wf03_findings where source_id = ? order by basis desc, created_at").all(sourceId) as Row[]).map(toFinding),
        questions: (db.prepare("select * from wf03_questions where source_id = ? order by status desc, created_at").all(sourceId) as Row[]).map(toQuestion),
      };
    },

    registerUpload(projectId: string, meta: unknown, file: { filename: string; bytes: Uint8Array }): Source {
      const m = parseOrThrow(SourceRegistration, meta);
      if (!/\.zip$/i.test(file.filename)) throw new StoreError("invalid", "Upload the source as a .zip archive.", [{ path: "file", message: "Not a .zip" }]);
      return register(projectId, m, "upload", file, null);
    },

    // A WF-02 capture of a reference becomes a source. It keeps a copy of the
    // capture (so deleting the capture later cannot change past analyses) and
    // its link back to the reference.
    registerFromCapture(projectId: string, referenceId: string, captureId: string, meta: unknown): Source {
      const m = parseOrThrow(SourceRegistration, meta);
      const { capture, bytes } = ctx.readCapture(projectId, referenceId, captureId);
      if (capture.kind !== "archive") throw new StoreError("invalid", "Only resource archives (.zip) can be analysed; screenshots are not source.");
      if (db.prepare("select 1 from wf03_sources where project_id = ? and capture_id = ?").get(projectId, captureId)) {
        throw new StoreError("conflict", "This capture is already a source.");
      }
      return register(projectId, { ...m, originUrl: m.originUrl || ctx.referenceUrl(projectId, referenceId) }, "reference_capture", { filename: capture.file.filename, bytes: new Uint8Array(bytes) }, { referenceId, captureId });
    },

    updateAuthorization(projectId: string, sourceId: string, input: unknown): Source {
      const auth = parseOrThrow(Authorization, input);
      return transaction(db, () => {
        const source = requireSource(projectId, sourceId);
        if (!extractionAllowed(auth.basis) && templatesOf("source_id = ?", sourceId).some((t) => t.extraction.status === "extracted")) {
          throw new StoreError("conflict", "Templates have been extracted from this source. Remove their extracted files before marking it study only.");
        }
        db.prepare("update wf03_sources set auth_basis = ?, auth_note = ?, auth_license = ?, updated_at = ? where id = ?").run(auth.basis, auth.note, auth.license, now(), sourceId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "source_authorization", `Authorisation changed to ${auth.basis}: ${source.label}`);
        return requireSource(projectId, sourceId);
      });
    },

    remove(projectId: string, sourceId: string): void {
      const { source, slugs } = transaction(db, () => {
        const s = requireSource(projectId, sourceId);
        const t = templatesOf("source_id = ?", sourceId).filter((x) => x.extraction.workspacePath).map((x) => x.slug);
        db.prepare("delete from wf03_sources where id = ?").run(sourceId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "source_removed", `Source removed: ${s.label}`);
        return { source: s, slugs: t };
      });
      files.remove(source.archive.storageKey);
      for (const slug of slugs) rmSync(join(workspaceRoot(projectId), slug), { recursive: true, force: true });
    },

    readArchiveFile(projectId: string, sourceId: string) {
      const source = requireSource(projectId, sourceId);
      return { source, bytes: files.read(source.archive.storageKey) };
    },

    runScan(projectId: string, sourceId: string): ScanRecord {
      const source = requireSource(projectId, sourceId);
      let output;
      try {
        output = analyzeArchive(new Uint8Array(files.read(source.archive.storageKey)));
      } catch (e) {
        if (e instanceof ArchiveError) throw new StoreError("invalid", e.message);
        throw e;
      }
      return transaction(db, () => {
        requireSource(projectId, sourceId);
        const id = randomUUID();
        db.prepare("insert into wf03_scans (id, source_id, analyzer_version, input_sha256, digest, result, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(
          id,
          sourceId,
          output.analysis.analyzerVersion,
          output.analysis.input.sha256,
          output.digest,
          JSON.stringify(output.analysis),
          now(),
        );
        syncQuestions(sourceId, output.analysis);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "source_scanned", `Source analysed: ${source.label} (${output.analysis.summary.files} files, digest ${output.digest.slice(0, 8)})`);
        return scansOf(sourceId)[0];
      });
    },

    scanResult(projectId: string, sourceId: string, scanId: string): SourceAnalysis {
      requireSource(projectId, sourceId);
      const row = db.prepare("select 1 from wf03_scans where id = ? and source_id = ?").get(scanId, sourceId);
      if (!row) throw new StoreError("not_found", "Scan not found.");
      return scanResult(scanId);
    },

    acceptCandidate(projectId: string, sourceId: string, candidateKey: string): Template {
      return transaction(db, () => {
        requireSource(projectId, sourceId);
        const latest = latestOf(sourceId);
        if (!latest) throw new StoreError("conflict", "Analyse the source first.");
        const c = latest.analysis.templateCandidates.find((x) => x.key === candidateKey);
        if (!c) throw new StoreError("not_found", "That candidate is not in the latest analysis.");
        if (db.prepare("select 1 from wf03_templates where source_id = ? and candidate_key = ?").get(sourceId, candidateKey)) {
          throw new StoreError("conflict", "That candidate is already in the manifest.");
        }
        const id = insertTemplate(projectId, sourceId, latest.scan.id, { candidateKey: c.key, kind: c.kind, name: c.name, description: "", basis: c.basis, rationale: c.rationale, origin: "scanner", files: c.files, pages: c.pages, evidence: c.evidence });
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "template_added", `Template added to manifest: ${c.name}`);
        return toTemplate(db.prepare("select * from wf03_templates where id = ?").get(id) as Row);
      });
    },

    removeTemplate(projectId: string, templateId: string): void {
      const t = transaction(db, () => {
        ctx.requireProject(projectId);
        const row = db.prepare("select * from wf03_templates where id = ? and project_id = ?").get(templateId, projectId) as Row | undefined;
        if (!row) throw new StoreError("not_found", "Template not found.");
        const tpl = toTemplate(row);
        db.prepare("delete from wf03_templates where id = ?").run(templateId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "template_removed", `Template removed: ${tpl.name}`);
        return tpl;
      });
      if (t.extraction.workspacePath) rmSync(join(workspaceRoot(projectId), t.slug), { recursive: true, force: true });
    },

    // Copies a template's files, unmodified, out of its source into the
    // project workspace, with a PROVENANCE.json naming the exact source,
    // archive digest, scan and authority. Refused for study-only sources.
    extractTemplate(projectId: string, templateId: string): Template {
      ctx.requireProject(projectId);
      const row = db.prepare("select * from wf03_templates where id = ? and project_id = ?").get(templateId, projectId) as Row | undefined;
      if (!row) throw new StoreError("not_found", "Template not found.");
      const t = toTemplate(row);
      const source = requireSource(projectId, t.sourceId);
      if (!extractionAllowed(source.authorization.basis)) {
        throw new StoreError("conflict", "This source is study only. Its templates can be analysed and described, but nothing is copied out of it.");
      }
      const scan = scansOf(source.id).find((s) => s.id === t.scanId);
      const analysis = scanResult(t.scanId);
      if (analysis.input.sha256 !== source.archive.sha256) throw new Error("Scan does not match the stored archive.");
      const byPath = new Map(archiveFiles(source).map((f) => [f.path, f]));
      const missing = t.files.filter((p) => !byPath.has(p));
      if (missing.length) throw new StoreError("invalid", `Not in the source: ${missing.slice(0, 5).join(", ")}.`);

      const root = workspaceRoot(projectId);
      const finalDir = join(root, t.slug);
      const tmpDir = join(root, `.${t.slug}.${randomUUID()}.tmp`);
      const provenanceFiles: { workspacePath: string; sourcePath: string; archivePath: string; sha256: string }[] = [];
      mkdirSync(tmpDir, { recursive: true });
      try {
        for (const p of t.files) {
          const f = byPath.get(p)!;
          const target = join(tmpDir, "files", p);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, f.bytes);
          provenanceFiles.push({ workspacePath: `files/${p}`, sourcePath: p, archivePath: `${analysis.rootPrefix}${p}`, sha256: f.sha256 });
        }
        // HTML blocks: also write the block's exact markup, cut from the page
        // it was found in, so the template is usable without the whole page.
        const ev = t.evidence.find((e) => e.line !== null && e.path.endsWith(".html"));
        if (t.candidateKey && /^(block|section):/.test(t.candidateKey) && ev) {
          const page = byPath.get(ev.path);
          if (page) {
            const doc = parse(new TextDecoder().decode(page.bytes), { sourceCodeLocationInfo: true });
            let snippet: string | null = null;
            const visit = (n: { childNodes?: unknown[]; sourceCodeLocation?: { startLine: number } | null; tagName?: string }) => {
              if (snippet) return;
              if (n.tagName && n.sourceCodeLocation?.startLine === ev.line) snippet = serializeOuter(n as never);
              for (const c of (n.childNodes ?? []) as (typeof n)[]) visit(c);
            };
            visit(doc as never);
            if (snippet) {
              writeFileSync(join(tmpDir, "snippet.html"), `<!-- Extracted verbatim from ${ev.path}, line ${ev.line}. See PROVENANCE.json. -->\n${snippet}\n`);
            }
          }
        }
        const provenance = {
          schema: "scl.wf-03.provenance/v1",
          notice: EXTRACTION_NOTICE,
          template: { id: t.id, slug: t.slug, kind: t.kind, name: t.name, basis: t.basis, rationale: t.rationale },
          source: {
            id: source.id,
            label: source.label,
            origin: source.origin,
            originUrl: source.originUrl,
            originRef: source.originRef,
            referenceId: source.referenceId,
            captureId: source.captureId,
            archiveFilename: source.archive.filename,
            archiveSha256: source.archive.sha256,
            authorization: source.authorization,
          },
          analysis: { scanId: t.scanId, analyzerVersion: scan?.analyzerVersion ?? analysis.analyzerVersion, digest: scan?.digest ?? null },
          extractedAt: now(),
          files: provenanceFiles,
        };
        writeFileSync(join(tmpDir, "PROVENANCE.json"), JSON.stringify(provenance, null, 2));
        rmSync(finalDir, { recursive: true, force: true });
        renameSync(tmpDir, finalDir);
      } catch (e) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw e;
      }
      try {
        return transaction(db, () => {
          const at = now();
          db.prepare(
            "update wf03_templates set extraction_status = 'extracted', workspace_path = ?, extracted_at = ?, build_status = ?, build_note = '', build_recorded_at = null, updated_at = ? where id = ?",
          ).run(`${t.slug}/`, at, needsBuild(t.files) ? "not_verified" : "not_applicable", at, t.id);
          ctx.touchProject(projectId);
          ctx.logActivity(projectId, "template_extracted", `Template extracted to workspace: ${t.name}`);
          return toTemplate(db.prepare("select * from wf03_templates where id = ?").get(t.id) as Row);
        });
      } catch (e) {
        rmSync(finalDir, { recursive: true, force: true });
        throw e;
      }
    },

    // Builds happen in VS Code. This records what a person saw, with the
    // command and result in their words; the app never claims a build passed.
    recordBuild(projectId: string, templateId: string, input: { status: unknown; note: unknown }): Template {
      const status = parseOrThrow(BuildStatusInput, input.status, "Choose passed or failed.");
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 2000) : "";
      if (!note) throw new StoreError("invalid", "Record the command you ran and what it printed.", [{ path: "note", message: "Required" }]);
      return transaction(db, () => {
        ctx.requireProject(projectId);
        const row = db.prepare("select * from wf03_templates where id = ? and project_id = ?").get(templateId, projectId) as Row | undefined;
        if (!row) throw new StoreError("not_found", "Template not found.");
        const t = toTemplate(row);
        if (t.extraction.status !== "extracted") throw new StoreError("conflict", "Extract the template before recording a build.");
        if (t.build.status === "not_applicable") throw new StoreError("conflict", "This template has no build step.");
        const at = now();
        db.prepare("update wf03_templates set build_status = ?, build_note = ?, build_recorded_at = ?, updated_at = ? where id = ?").run(status, note, at, at, templateId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "template_build", `Build ${status} recorded: ${t.name}`);
        return toTemplate(db.prepare("select * from wf03_templates where id = ?").get(templateId) as Row);
      });
    },

    addFinding(projectId: string, sourceId: string, input: { basis: unknown; topic: unknown; statement: unknown; evidencePath: unknown; evidenceLine: unknown }): void {
      const basis = parseOrThrow(FindingBasisInput, input.basis);
      const topic = parseOrThrow(FindingTopic, input.topic);
      const statement = typeof input.statement === "string" ? input.statement.trim() : "";
      if (!statement) throw new StoreError("invalid", "Write the finding.", [{ path: "statement", message: "Required" }]);
      const path = typeof input.evidencePath === "string" ? input.evidencePath.trim() : "";
      const line = input.evidenceLine === "" || input.evidenceLine == null ? null : Number(input.evidenceLine);
      if (basis === "fact" && !path) throw new StoreError("invalid", "A fact must cite a file in the source.", [{ path: "evidencePath", message: "Required for a fact" }]);
      transaction(db, () => {
        const source = requireSource(projectId, sourceId);
        if (path) {
          const latest = latestOf(sourceId);
          const problems = latest ? checkEvidence(source, latest.analysis, [{ path, line }]) : ["Analyse the source before citing files."];
          if (problems.length) throw new StoreError("invalid", problems[0], [{ path: "evidencePath", message: problems[0] }]);
        }
        db.prepare("insert into wf03_findings (id, source_id, basis, topic, statement, evidence, origin, created_at) values (?, ?, ?, ?, ?, ?, 'person', ?)").run(
          randomUUID(),
          sourceId,
          basis,
          topic,
          statement.slice(0, 2000),
          JSON.stringify(path ? [{ path, line }] : []),
          now(),
        );
        ctx.touchProject(projectId);
      });
    },

    addQuestion(projectId: string, sourceId: string, text: unknown): void {
      const t = typeof text === "string" ? text.trim() : "";
      if (!t) throw new StoreError("invalid", "Write the question.", [{ path: "text", message: "Required" }]);
      transaction(db, () => {
        requireSource(projectId, sourceId);
        db.prepare("insert into wf03_questions (id, source_id, key, topic, text, origin, status, answer, created_at, resolved_at) values (?, ?, null, 'other', ?, 'person', 'open', '', ?, null)").run(randomUUID(), sourceId, t.slice(0, 1000), now());
        ctx.touchProject(projectId);
      });
    },

    resolveQuestion(projectId: string, sourceId: string, questionId: string, answer: unknown): void {
      const a = typeof answer === "string" ? answer.trim() : "";
      transaction(db, () => {
        requireSource(projectId, sourceId);
        const res = a
          ? db.prepare("update wf03_questions set status = 'resolved', answer = ?, resolved_at = ? where id = ? and source_id = ?").run(a.slice(0, 2000), now(), questionId, sourceId)
          : db.prepare("update wf03_questions set status = 'open', answer = '', resolved_at = null where id = ? and source_id = ?").run(questionId, sourceId);
        if (res.changes === 0) throw new StoreError("not_found", "Question not found.");
        ctx.touchProject(projectId);
      });
    },

    // Imports an analyst's findings.json. All or nothing: it must be pinned
    // to a scan of this source, and every cited path (and line) must exist in
    // that source, or nothing is imported and every problem is listed.
    importFindings(projectId: string, sourceId: string, raw: unknown): { findings: number; questions: number; templates: number } {
      const data = parseOrThrow(AnalystFindings, raw, `Not a valid ${ANALYST_FINDINGS_SCHEMA} file.`);
      const source = requireSource(projectId, sourceId);
      const scan = scansOf(sourceId).find((s) => s.digest === data.scanDigest);
      if (!scan) {
        throw new StoreError("invalid", "scanDigest does not match any analysis of this source. Export a fresh kit and redo the findings against it.", [{ path: "scanDigest", message: "Unknown digest" }]);
      }
      const analysis = scanResult(scan.id);
      const problems = [
        ...data.findings.flatMap((f, i) => checkEvidence(source, analysis, f.evidence).map((p) => `findings[${i}]: ${p}`)),
        ...data.templates.flatMap((t, i) => checkEvidence(source, analysis, t.files.map((path) => ({ path, line: null }))).map((p) => `templates[${i}]: ${p}`)),
      ];
      if (problems.length) {
        throw new StoreError("invalid", `Nothing imported: ${problems.length === 1 ? "1 citation does" : `${problems.length} citations do`} not match the source.`, problems.slice(0, 20).map((p) => ({ path: "file", message: p })));
      }
      return transaction(db, () => {
        requireSource(projectId, sourceId);
        const at = now();
        for (const f of data.findings) {
          db.prepare("insert into wf03_findings (id, source_id, basis, topic, statement, evidence, origin, created_at) values (?, ?, ?, ?, ?, ?, 'analysis_kit', ?)").run(randomUUID(), sourceId, f.basis, f.topic, f.statement, JSON.stringify(f.evidence), at);
        }
        for (const q of data.questions) {
          db.prepare("insert into wf03_questions (id, source_id, key, topic, text, origin, status, answer, created_at, resolved_at) values (?, ?, null, ?, ?, 'analysis_kit', 'open', '', ?, null)").run(randomUUID(), sourceId, q.topic, q.text, at);
        }
        for (const t of data.templates) {
          insertTemplate(projectId, sourceId, scan.id, { candidateKey: null, kind: t.kind, name: t.name, description: t.description, basis: t.basis, rationale: t.rationale, origin: "analysis_kit", files: t.files, pages: [], evidence: t.files.slice(0, 10).map((p) => ({ path: p, line: null, excerpt: null })) });
        }
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "findings_imported", `Analyst findings imported for ${source.label}: ${data.findings.length} findings, ${data.questions.length} questions, ${data.templates.length} templates`);
        return { findings: data.findings.length, questions: data.questions.length, templates: data.templates.length };
      });
    },

    analysisKit(projectId: string, sourceId: string): { filename: string; bytes: Uint8Array } {
      const source = requireSource(projectId, sourceId);
      const latest = latestOf(sourceId);
      if (!latest) throw new StoreError("conflict", "Analyse the source first; the kit is built around the analysis.");
      return { filename: `${slugify(source.label) || "source"}-analysis-kit.zip`, bytes: buildKit(source, latest.analysis, latest.scan.digest, archiveFiles(source)) };
    },

    analysisReport(projectId: string, sourceId: string) {
      const d = self.get(projectId, sourceId);
      return {
        schema: ANALYSIS_REPORT_SCHEMA,
        generatedAt: now(),
        source: { ...d.source, archive: { ...d.source.archive, storageKey: undefined } },
        scan: d.latest ? { ...d.latest.scan } : null,
        analysis: d.latest?.analysis ?? null,
        findings: { facts: d.findings.filter((f) => f.basis === "fact"), assumptions: d.findings.filter((f) => f.basis === "assumption") },
        questions: { open: d.questions.filter((q) => q.status === "open"), resolved: d.questions.filter((q) => q.status === "resolved") },
        templates: d.templates,
      };
    },

    manifest(projectId: string): TemplateManifest {
      const project = ctx.requireProject(projectId);
      const brief = ctx.approvedBrief(projectId);
      const summaries = self.list(projectId);
      const latest = new Map<string, ReturnType<typeof latestOf>>(summaries.map((s) => [s.source.id, latestOf(s.source.id)]));
      const templates = templatesOf("project_id = ?", projectId);
      const fileSha = (sourceId: string, scanId: string, path: string) => {
        const a = scanId === latest.get(sourceId)?.scan.id ? latest.get(sourceId)!.analysis : scanResult(scanId);
        return a.files.find((f) => f.path === path)?.sha256 ?? null;
      };
      const open = (db.prepare("select q.* from wf03_questions q join wf03_sources s on s.id = q.source_id where s.project_id = ? and q.status = 'open' order by q.created_at").all(projectId) as Row[]).map(toQuestion);
      return TemplateManifest.parse({
        schema: TEMPLATE_MANIFEST_SCHEMA,
        generatedAt: now(),
        notices: { sourceTokens: SOURCE_TOKEN_NOTICE, extraction: EXTRACTION_NOTICE },
        project: { id: project.id, slug: project.slug, name: project.name },
        brief: brief ? { id: brief.id, version: brief.version } : null,
        sources: summaries.map(({ source: s }) => {
          const l = latest.get(s.id);
          return {
            id: s.id,
            label: s.label,
            origin: { kind: s.origin, url: s.originUrl, ref: s.originRef, referenceId: s.referenceId, captureId: s.captureId },
            archive: { filename: s.archive.filename, sizeBytes: s.archive.sizeBytes, sha256: s.archive.sha256, downloadPath: `/api/projects/${projectId}/sources/${s.id}/archive` },
            authorization: { ...s.authorization, extractionAllowed: extractionAllowed(s.authorization.basis) },
            analysis: l ? { scanId: l.scan.id, analyzerVersion: l.scan.analyzerVersion, digest: l.scan.digest, scannedAt: l.scan.createdAt, reportPath: `/api/projects/${projectId}/sources/${s.id}/report` } : null,
          };
        }),
        templates: templates.map((t) => ({
          id: t.id,
          slug: t.slug,
          kind: t.kind,
          name: t.name,
          description: t.description,
          basis: t.basis,
          rationale: t.rationale,
          origin: t.origin,
          sourceId: t.sourceId,
          scanId: t.scanId,
          files: t.files.map((p) => ({ path: p, sha256: fileSha(t.sourceId, t.scanId, p) })),
          pages: t.pages,
          evidence: t.evidence,
          extraction: t.extraction,
          build: { status: t.build.status, note: t.build.note },
        })),
        sourceTokens: summaries.flatMap(({ source: s }) => {
          const a = latest.get(s.id)?.analysis;
          if (!a) return [];
          return [
            {
              sourceId: s.id,
              customProperties: a.styles.customProperties.slice(0, 150),
              colors: a.styles.colors,
              fontFamilies: a.styles.fontFamilies,
              fontFaces: a.styles.fontFaces.map((f) => ({ family: f.family, weight: f.weight, style: f.style, path: f.path })),
              breakpoints: a.styles.breakpoints.map((b) => ({ px: b.px, feature: b.feature, count: b.count })),
            },
          ];
        }),
        assets: summaries.flatMap(({ source: s }) =>
          (latest.get(s.id)?.analysis.assets ?? []).map((x) => ({ sourceId: s.id, path: x.path, kind: x.kind, sizeBytes: x.sizeBytes, sha256: x.sha256, referenced: x.referencedBy.length > 0 })),
        ),
        risks: summaries.flatMap(({ source: s }) =>
          (latest.get(s.id)?.analysis.risks ?? []).map((r) => ({ sourceId: s.id, key: r.key, kind: r.kind, severity: r.severity, title: r.title, occurrences: r.occurrences })),
        ),
        openQuestions: open.map((q) => ({ sourceId: q.sourceId, topic: q.topic, text: q.text, origin: q.origin })),
      });
    },

    // The project workspace as a zip for VS Code: every extracted template
    // with its PROVENANCE.json, plus the manifest.
    workspaceZip(projectId: string): { filename: string; bytes: Uint8Array } {
      const project = ctx.requireProject(projectId);
      const root = workspaceRoot(projectId);
      const entries: Record<string, Uint8Array> = {
        "MANIFEST.json": strToU8(JSON.stringify(self.manifest(projectId), null, 2)),
        "WORKSPACE.md": strToU8(
          `# ${project.name}: WF-03 workspace\n\nEach folder is one extracted template: \`files/\` holds the files exactly as they were in the source (check the hashes in \`PROVENANCE.json\`), and \`snippet.html\`, where present, is the block cut verbatim from its page.\n\n${EXTRACTION_NOTICE}\n\nBuild results are recorded on the dashboard (WF-03 → template → Record build), with the command you ran and what it printed.\n`,
        ),
      };
      if (existsSync(root)) {
        const walk = (dir: string) => {
          for (const name of readdirSync(dir).sort()) {
            if (name.startsWith(".")) continue; // in-progress extractions
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else entries[relative(root, full).split("\\").join("/")] = new Uint8Array(readFileSync(full));
          }
        };
        walk(root);
      }
      return { filename: `${project.slug}-wf03-workspace.zip`, bytes: zipSync(entries, { level: 6 }) };
    },
  };

  // Checks citations against the source: the path must be in the scanned
  // inventory, and a line must exist in that file.
  const lineCounts = new Map<string, Map<string, number>>();
  function checkEvidence(source: Source, analysis: SourceAnalysis, evidence: { path: string; line: number | null }[]): string[] {
    const known = new Set(analysis.files.map((f) => f.path));
    const problems: string[] = [];
    let counts = lineCounts.get(source.archive.sha256);
    for (const e of evidence) {
      if (!known.has(e.path)) {
        problems.push(`${e.path} is not a file in the source`);
        continue;
      }
      if (e.line !== null) {
        if (!counts) {
          counts = new Map(archiveFiles(source).map((f) => [f.path, new TextDecoder().decode(f.bytes).split("\n").length]));
          lineCounts.set(source.archive.sha256, counts);
        }
        if (e.line > (counts.get(e.path) ?? 0)) problems.push(`${e.path} has no line ${e.line}`);
      }
    }
    return problems;
  }

  return self;
}

const BuildStatusInput = { safeParse: (v: unknown) => (v === "passed" || v === "failed" ? { success: true as const, data: v as BuildStatus } : { success: false as const, error: { issues: [{ path: ["status"], message: "Choose passed or failed" }] } }) };
const FindingBasisInput = { safeParse: (v: unknown) => (v === "fact" || v === "assumption" ? { success: true as const, data: v } : { success: false as const, error: { issues: [{ path: ["basis"], message: "Choose fact or assumption" }] } }) };

export type SourceStore = ReturnType<typeof createSourceStore>;

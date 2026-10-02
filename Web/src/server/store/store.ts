import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  Asset,
  AssetUploadMeta,
  AssetUrlInput,
  fileExtension,
  MAX_UPLOAD_BYTES,
} from "@/domain/asset";
import { BRIEF_HANDOFF_SCHEMA, BriefHandoff } from "@/domain/brief-handoff";
import { ClientBrief, ClientBriefDraft, emptyDraft, evaluateDraft } from "@/domain/client-brief";
import { Project, ProjectInput } from "@/domain/project";
import { slugify } from "@/lib/slug";
import { summariseProject, type ProjectSummary } from "@/domain/project-status";
import { transaction } from "./db";
import { issuesFrom, now, StoreError, type Row } from "./errors";
import { createFileStore } from "./files";
import { createReferenceStore } from "./references";
import { createSourceStore } from "./sources";
import { createBrandStore } from "./brands";
import { createContentStore } from "./content";
import { createExperienceStore } from "./experience";
import { createJourneyStore } from "./journeys";
import { createProductionStore } from "./production";
import { createSarCaptureStore } from "./sar-captures";
import { createTemplateJobStore } from "./template-jobs";
import { createTemplatePreviewStore } from "./template-previews";
import { runwayProvider, veoProvider, type ProviderRegistry } from "@/server/production/providers";
import { dirname, join } from "node:path";
import { checkReferenceUrl, type CheckResult } from "@/server/reference-check";

// Every WF-01 read and write goes through here. Nothing else touches SQL or
// the upload directory, so moving to a hosted database replaces this module
// and nothing above it.
//
// Rows are parsed back through the domain schemas on the way out: a row that
// no longer matches its schema is an error to surface, not data to render.

export { StoreError };

export type ActivityItem = {
  id: string;
  projectId: string;
  projectName: string;
  kind: string;
  summary: string;
  createdAt: string;
};

export type ProjectDetail = {
  project: Project;
  latest: ClientBrief;
  approved: ClientBrief | null;
  assets: Asset[];
  referenceCounts: { total: number; failed: number };
  summary: ProjectSummary;
};


const toProject = (r: Row): Project =>
  Project.parse({
    id: r.id,
    slug: r.slug,
    name: r.name,
    clientName: r.client_name,
    dashboardClientId: r.dashboard_client_id ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const toBrief = (r: Row): ClientBrief =>
  ClientBrief.parse({
    id: r.id,
    projectId: r.project_id,
    version: r.version,
    status: r.status,
    draft: JSON.parse(String(r.draft)),
    content: r.content == null ? null : JSON.parse(String(r.content)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at ?? null,
  });

const toAsset = (r: Row): Asset =>
  Asset.parse({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    label: r.label,
    notes: r.notes,
    source:
      r.source_type === "url"
        ? { type: "url", url: r.url }
        : {
            type: "upload",
            file: {
              storageKey: r.storage_key,
              filename: r.filename,
              mimeType: r.mime_type,
              sizeBytes: r.size_bytes,
              sha256: r.sha256,
            },
          },
    createdAt: r.created_at,
  });

export type StoreDeps = {
  // The WF-02 URL check; tests pass a stand-in so they make no network calls.
  checkUrl?: (url: string) => Promise<CheckResult>;
  // Where WF-03 extracts templates; defaults to a workspaces/ folder beside the uploads.
  workspaceDir?: string;
  // WF-07 provider adapters. Defaults to adapters with no key, which report
  // themselves unconfigured; the server passes keyed ones (src/server/store/index.ts).
  providers?: ProviderRegistry;
};

export function createStore(db: DatabaseSync, filesDir: string, deps: StoreDeps = {}) {
  const logActivity = (projectId: string, kind: string, summary: string) => {
    db.prepare("insert into activity (id, project_id, kind, summary, created_at) values (?, ?, ?, ?, ?)").run(
      randomUUID(),
      projectId,
      kind,
      summary,
      now(),
    );
  };

  const touchProject = (projectId: string) => {
    db.prepare("update projects set updated_at = ? where id = ?").run(now(), projectId);
  };

  const requireProject = (id: string): Project => {
    const row = db.prepare("select * from projects where id = ?").get(id) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Project not found.");
    return toProject(row);
  };

  const latestBrief = (projectId: string): ClientBrief => {
    const row = db
      .prepare("select * from client_briefs where project_id = ? order by version desc limit 1")
      .get(projectId) as Row | undefined;
    // Every project is created with a draft in the same transaction.
    if (!row) throw new Error(`Project ${projectId} has no brief; the store is inconsistent.`);
    return toBrief(row);
  };

  const approvedBrief = (projectId: string): ClientBrief | null => {
    const row = db
      .prepare("select * from client_briefs where project_id = ? and status = 'approved'")
      .get(projectId) as Row | undefined;
    return row ? toBrief(row) : null;
  };

  const listAssets = (projectId: string): Asset[] =>
    (db.prepare("select * from assets where project_id = ? order by created_at desc").all(projectId) as Row[]).map(
      toAsset,
    );

  const detail = (project: Project): ProjectDetail => {
    const latest = latestBrief(project.id);
    const approved = approvedBrief(project.id);
    const assets = listAssets(project.id);
    const refs = references.list(project.id);
    const referenceCounts = { total: refs.length, failed: refs.filter((v) => v.status === "failed").length };
    return {
      project,
      latest,
      approved,
      assets,
      referenceCounts,
      summary: summariseProject(project, latest, approved?.version ?? null, assets, referenceCounts),
    };
  };

  const files = createFileStore(filesDir);

  const references = createReferenceStore({
    db,
    files,
    requireProject,
    approvedBrief,
    logActivity,
    touchProject,
    checkUrl: deps.checkUrl ?? ((url) => checkReferenceUrl(url)),
  });

  const sources = createSourceStore({
    db,
    files,
    workspaceDir: deps.workspaceDir ?? join(dirname(filesDir), "workspaces"),
    requireProject,
    approvedBrief,
    logActivity,
    touchProject,
    readCapture: (projectId, referenceId, captureId) => references.readCapture(projectId, referenceId, captureId),
    referenceUrl: (projectId, referenceId) => references.get(projectId, referenceId).reference.url,
  });

  // WF-02 captures sent straight to Web by the SaveAllResources extension.
  const sarCaptures = createSarCaptureStore({ db, files, requireProject, logActivity, touchProject, references, sources });
  // Website-template generation jobs (persistence only; see src/server/pipeline).
  const templateJobs = createTemplateJobStore({ db, files, requireProject });
  const templatePreviews = createTemplatePreviewStore(db);

  const brands = createBrandStore({
    db,
    requireProject,
    logActivity,
    touchProject,
    assetIds: (projectId) => new Set(listAssets(projectId).map((a) => a.id)),
    // Only the client's own material: logos from their register, tokens from
    // sources they own. Study-only references never feed a brand.
    suggestionInput: (projectId) => ({
      logos: listAssets(projectId)
        .filter((a) => a.kind === "logo")
        .reverse()
        .map((a) => ({ assetId: a.id, label: a.label })),
      ownedSources: sources
        .list(projectId)
        .filter((s) => s.source.authorization.basis === "client_owned" && s.latestScan)
        .map((s) => {
          const a = sources.get(projectId, s.source.id).latest!.analysis;
          return { label: s.source.label, customProperties: a.styles.customProperties, fontFamilies: a.styles.fontFamilies, breakpoints: a.styles.breakpoints };
        }),
    }),
  });

  const brandVars = (projectId: string, brandId: string, which: "approved" | "latest") => {
    try {
      const ex = brands.exportJson(projectId, brandId, which);
      return { vars: ex.cssVariables, reduced: ex.reducedMotionVariables, version: ex.version.number, key: ex.brand.key };
    } catch (e) {
      if ((e as Error).name === "StoreError") return null;
      throw e;
    }
  };
  const content = createContentStore({
    db,
    requireProject,
    approvedBrief,
    logActivity,
    touchProject,
    assetIds: (projectId) => new Set(listAssets(projectId).map((a) => a.id)),
    brands: {
      approvedVariables: (p, b) => brandVars(p, b, "approved"),
      latestVariables: (p, b) => brandVars(p, b, "latest"),
      exists: (p, b) => brands.list(p).some((x) => x.brand.id === b),
      first: (p) => brands.list(p)[0]?.brand.id ?? null,
    },
  });

  const journeys = createJourneyStore({
    db,
    requireProject,
    approvedBrief,
    logActivity,
    touchProject,
    pages: (projectId) =>
      content.pages(projectId).map((p) => ({ id: p.id, title: p.content.title, path: p.content.slug ? `/${p.content.slug}` : "/", sections: p.content.sections.map((s) => ({ id: s.id })) })),
    assetIds: (projectId) => new Set(listAssets(projectId).map((a) => a.id)),
    captures: (projectId) => new Set(references.list(projectId).flatMap((v) => v.captures.map((c) => `${v.reference.id}:${c.id}`))),
    // The brand to keep footage consistent with: the site's brand (WF-05) if
    // approved, otherwise the project's first approved brand.
    brand: (projectId) => {
      const siteBrand = content.site(projectId).brandId;
      const approved = brands.list(projectId).filter((b) => b.approved);
      const pick = approved.find((b) => b.brand.id === siteBrand) ?? approved[0];
      return pick ? { id: pick.brand.id, version: pick.approved!.version } : null;
    },
  });

  const production = createProductionStore({
    db,
    files,
    requireProject,
    logActivity,
    touchProject,
    sceneManifest: (projectId, journeyId) => journeys.sceneManifest(projectId, journeyId, "approved"),
    // Keyframes are read from this project's own register and WF-02 captures;
    // external keyframe URLs are never fetched by the server.
    readKeyframe: (projectId, ref) => {
      const asset = new RegExp(`^/api/projects/${projectId}/assets/([0-9a-f-]{36})/file$`).exec(ref.url);
      const capture = new RegExp(`^/api/projects/${projectId}/references/([0-9a-f-]{36})/captures/([0-9a-f-]{36})/file$`).exec(ref.url);
      const mime = (name: string) => (/\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg");
      try {
        if (asset) {
          const a = listAssets(projectId).find((x) => x.id === asset[1]);
          return a?.source.type === "upload" ? { mimeType: mime(a.source.file.filename), bytes: new Uint8Array(files.read(a.source.file.storageKey)) } : null;
        }
        if (capture) {
          const { capture: c, bytes } = references.readCapture(projectId, capture[1], capture[2]);
          return { mimeType: mime(c.file.filename), bytes: new Uint8Array(bytes) };
        }
      } catch (e) {
        if ((e as Error).name !== "StoreError") throw e;
      }
      return null;
    },
    providers: deps.providers ?? { runway: runwayProvider(undefined), veo: veoProvider(undefined) },
  });

  const experience = createExperienceStore({
    db,
    requireProject,
    logActivity,
    touchProject,
    journeys: () => journeys,
    journeySpec: (projectId, journeyId) => journeys.journeySpec(projectId, journeyId, "approved"),
    aspectRatio: (projectId, journeyId) => journeys.sceneManifest(projectId, journeyId, "approved").format.aspectRatio,
    production: (projectId, journeyId, version) => {
      const found = production.list(projectId).find((p) => p.production.journeyId === journeyId && p.production.journeyVersion === version);
      if (!found) return null;
      const approvedTakes = new Map(found.shots.flatMap((s) => s.takes.filter((t) => t.review === "approved").map((t) => [t.id, t.file.sha256] as const)));
      return { id: found.production.id, manifest: production.assetManifest(projectId, found.production.id), approvedTakes };
    },
    pages: (projectId, mode) => content.pages(projectId).flatMap((p) => (mode === "preview" ? [{ id: p.id, content: p.content }] : p.published ? [{ id: p.id, content: p.published.content }] : [])),
  });

  return {
    references,
    sources,
    brands,
    content,
    journeys,
    production,
    experience,
    sarCaptures,
    templateJobs,
    templatePreviews,
    logActivity,
    streamFile: (storageKey: string) => files.stream(storageKey),

    listProjects(): ProjectDetail[] {
      const rows = db.prepare("select * from projects order by updated_at desc").all() as Row[];
      return rows.map((r) => detail(toProject(r)));
    },

    getProject(id: string): ProjectDetail | null {
      const row = db.prepare("select * from projects where id = ?").get(id) as Row | undefined;
      return row ? detail(toProject(row)) : null;
    },

    createProject(input: unknown): Project {
      const parsed = ProjectInput.safeParse(input);
      if (!parsed.success) throw new StoreError("invalid", "Check the highlighted fields.", issuesFrom(parsed.error));
      const { name, clientName } = parsed.data;
      return transaction(db, () => {
        const base = slugify(name) || "project";
        let slug = base;
        for (let n = 2; db.prepare("select 1 from projects where slug = ?").get(slug); n++) slug = `${base}-${n}`;
        const id = randomUUID();
        const at = now();
        db.prepare(
          "insert into projects (id, slug, name, client_name, dashboard_client_id, status, created_at, updated_at) values (?, ?, ?, ?, null, 'active', ?, ?)",
        ).run(id, slug, name, clientName, at, at);
        db.prepare(
          "insert into client_briefs (id, project_id, version, status, draft, content, created_at, updated_at, approved_at) values (?, ?, 1, 'draft', ?, null, ?, ?, null)",
        ).run(randomUUID(), id, JSON.stringify(emptyDraft()), at, at);
        logActivity(id, "project_created", `Project created for ${clientName}`);
        return requireProject(id);
      });
    },

    updateProject(id: string, input: unknown): Project {
      const parsed = ProjectInput.safeParse(input);
      if (!parsed.success) throw new StoreError("invalid", "Check the highlighted fields.", issuesFrom(parsed.error));
      return transaction(db, () => {
        requireProject(id);
        db.prepare("update projects set name = ?, client_name = ?, updated_at = ? where id = ?").run(
          parsed.data.name,
          parsed.data.clientName,
          now(),
          id,
        );
        logActivity(id, "project_updated", "Project details updated");
        return requireProject(id);
      });
    },

    // Saves the current draft. briefId is the version the editor loaded; if
    // that is no longer the editable draft (approved meanwhile, or edited in
    // another tab and approved), the save is refused rather than applied to
    // the wrong version.
    saveDraft(projectId: string, briefId: string, draft: unknown): ClientBrief {
      const parsed = ClientBriefDraft.safeParse(draft);
      if (!parsed.success) throw new StoreError("invalid", "The brief could not be saved.", issuesFrom(parsed.error));
      return transaction(db, () => {
        requireProject(projectId);
        const latest = latestBrief(projectId);
        if (latest.id !== briefId || latest.status !== "draft") {
          throw new StoreError("conflict", "This brief changed since you opened it. Reload to see the current version.");
        }
        db.prepare("update client_briefs set draft = ?, updated_at = ? where id = ?").run(
          JSON.stringify(parsed.data),
          now(),
          briefId,
        );
        touchProject(projectId);
        logActivity(projectId, "brief_saved", `Brief version ${latest.version} draft saved`);
        return latestBrief(projectId);
      });
    },

    approveBrief(projectId: string, briefId: string): ClientBrief {
      return transaction(db, () => {
        requireProject(projectId);
        const latest = latestBrief(projectId);
        if (latest.id !== briefId || latest.status !== "draft") {
          throw new StoreError("conflict", "This brief changed since you opened it. Reload to see the current version.");
        }
        const { completeness, content } = evaluateDraft(latest.draft);
        if (!content) {
          throw new StoreError("invalid", "The brief is incomplete. Fix the listed items, then approve.", completeness.issues);
        }
        const at = now();
        db.prepare("update client_briefs set status = 'superseded', updated_at = ? where project_id = ? and status = 'approved'").run(
          at,
          projectId,
        );
        db.prepare(
          "update client_briefs set status = 'approved', content = ?, approved_at = ?, updated_at = ? where id = ?",
        ).run(JSON.stringify(content), at, at, briefId);
        touchProject(projectId);
        logActivity(projectId, "brief_approved", `Brief version ${latest.version} approved`);
        return latestBrief(projectId);
      });
    },

    // Opens version n+1 as a draft, copied from the approved version. The
    // approved version stays in force until the new one is approved.
    reviseBrief(projectId: string): ClientBrief {
      return transaction(db, () => {
        requireProject(projectId);
        const latest = latestBrief(projectId);
        if (latest.status === "draft") return latest;
        const at = now();
        db.prepare(
          "insert into client_briefs (id, project_id, version, status, draft, content, created_at, updated_at, approved_at) values (?, ?, ?, 'draft', ?, null, ?, ?, null)",
        ).run(randomUUID(), projectId, latest.version + 1, JSON.stringify(latest.draft), at, at);
        touchProject(projectId);
        logActivity(projectId, "brief_revision_started", `Brief version ${latest.version + 1} opened for editing`);
        return latestBrief(projectId);
      });
    },

    addAssetUrl(projectId: string, input: unknown): Asset {
      const parsed = AssetUrlInput.safeParse(input);
      if (!parsed.success) throw new StoreError("invalid", "Check the highlighted fields.", issuesFrom(parsed.error));
      return transaction(db, () => {
        requireProject(projectId);
        const id = randomUUID();
        db.prepare(
          "insert into assets (id, project_id, kind, label, notes, source_type, url, created_at) values (?, ?, ?, ?, ?, 'url', ?, ?)",
        ).run(id, projectId, parsed.data.kind, parsed.data.label, parsed.data.notes, parsed.data.url, now());
        touchProject(projectId);
        logActivity(projectId, "asset_added", `Asset reference added: ${parsed.data.label}`);
        return toAsset(db.prepare("select * from assets where id = ?").get(id) as Row);
      });
    },

    addAssetUpload(
      projectId: string,
      meta: unknown,
      file: { filename: string; mimeType: string; bytes: Uint8Array },
    ): Asset {
      const parsed = AssetUploadMeta.safeParse(meta);
      if (!parsed.success) throw new StoreError("invalid", "Check the highlighted fields.", issuesFrom(parsed.error));
      const { kind } = parsed.data;
      const ext = fileExtension(file.filename);
      const allowed: readonly string[] = ALLOWED_UPLOAD_EXTENSIONS[kind];
      if (!allowed.includes(ext)) {
        throw new StoreError("invalid", `A ${kind.replace("_", " ")} upload must be one of: ${allowed.join(", ")}.`, [
          { path: "file", message: "File type not accepted for this asset kind" },
        ]);
      }
      if (file.bytes.byteLength === 0) {
        throw new StoreError("invalid", "The file is empty.", [{ path: "file", message: "Empty file" }]);
      }
      if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new StoreError("invalid", `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; add a link instead.`, [
          { path: "file", message: "File too large" },
        ]);
      }
      requireProject(projectId);

      const id = randomUUID();
      const storageKey = `${projectId}/${id}`; // never the client's filename
      return files.storeThenRecord(storageKey, file.bytes, ({ sha256, sizeBytes }) =>
        transaction(db, () => {
          db.prepare(
            "insert into assets (id, project_id, kind, label, notes, source_type, storage_key, filename, mime_type, size_bytes, sha256, created_at) values (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?)",
          ).run(
            id,
            projectId,
            kind,
            parsed.data.label,
            parsed.data.notes,
            storageKey,
            file.filename.slice(0, 255),
            (file.mimeType || "application/octet-stream").slice(0, 255),
            sizeBytes,
            sha256,
            now(),
          );
          touchProject(projectId);
          logActivity(projectId, "asset_added", `Asset uploaded: ${parsed.data.label}`);
          return toAsset(db.prepare("select * from assets where id = ?").get(id) as Row);
        }),
      );
    },

    removeAsset(projectId: string, assetId: string): void {
      const removed = transaction(db, () => {
        const row = db.prepare("select * from assets where id = ? and project_id = ?").get(assetId, projectId) as
          | Row
          | undefined;
        if (!row) throw new StoreError("not_found", "Asset not found.");
        const asset = toAsset(row);
        db.prepare("delete from assets where id = ?").run(assetId);
        touchProject(projectId);
        logActivity(projectId, "asset_removed", `Asset removed: ${asset.label}`);
        return asset;
      });
      if (removed.source.type === "upload") files.remove(removed.source.file.storageKey);
    },

    readAssetFile(projectId: string, assetId: string): { asset: Asset; bytes: Buffer } {
      const row = db.prepare("select * from assets where id = ? and project_id = ?").get(assetId, projectId) as
        | Row
        | undefined;
      if (!row) throw new StoreError("not_found", "Asset not found.");
      const asset = toAsset(row);
      if (asset.source.type !== "upload") throw new StoreError("not_found", "This asset is a link, not an uploaded file.");
      return { asset, bytes: files.read(asset.source.file.storageKey) };
    },

    listActivity(limit: number, projectId?: string): ActivityItem[] {
      const rows = (
        projectId
          ? db
              .prepare(
                "select a.*, p.name as project_name from activity a join projects p on p.id = a.project_id where a.project_id = ? order by a.created_at desc limit ?",
              )
              .all(projectId, limit)
          : db
              .prepare(
                "select a.*, p.name as project_name from activity a join projects p on p.id = a.project_id order by a.created_at desc limit ?",
              )
              .all(limit)
      ) as Row[];
      return rows.map((r) => ({
        id: String(r.id),
        projectId: String(r.project_id),
        projectName: String(r.project_name),
        kind: String(r.kind),
        summary: String(r.summary),
        createdAt: String(r.created_at),
      }));
    },

    // The WF-01 -> WF-02..10 contract. Null when nothing is approved yet:
    // downstream modules never receive a draft.
    getBriefHandoff(projectId: string): BriefHandoff | null {
      const project = requireProject(projectId);
      const approved = approvedBrief(projectId);
      if (!approved || !approved.content || !approved.approvedAt) return null;
      return BriefHandoff.parse({
        schema: BRIEF_HANDOFF_SCHEMA,
        generatedAt: now(),
        project: {
          id: project.id,
          slug: project.slug,
          name: project.name,
          clientName: project.clientName,
          dashboardClientId: project.dashboardClientId,
        },
        brief: { id: approved.id, version: approved.version, approvedAt: approved.approvedAt, content: approved.content },
        assets: listAssets(projectId).map((a) => ({
          id: a.id,
          kind: a.kind,
          label: a.label,
          notes: a.notes,
          source:
            a.source.type === "url"
              ? a.source
              : {
                  type: "upload",
                  file: {
                    filename: a.source.file.filename,
                    mimeType: a.source.file.mimeType,
                    sizeBytes: a.source.file.sizeBytes,
                    sha256: a.source.file.sha256,
                    downloadPath: `/api/projects/${projectId}/assets/${a.id}/file`,
                  },
                },
        })),
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;

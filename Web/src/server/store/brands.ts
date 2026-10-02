import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BrandContent, defaultBrand, listTokens, type AssetRef } from "@/domain/brand";
import { BRAND_CONFIG_SCHEMA, BrandExport } from "@/domain/brand-contract";
import { blocking, brandCss, brandIssues, brandVariables, contrastChecks, missingTokens, reducedMotionVariables } from "@/domain/brand-css";
import { applySuggestions, type SuggestionInput } from "@/domain/brand-suggest";
import type { Project } from "@/domain/project";
import { slugify } from "@/lib/slug";
import { transaction } from "./db";
import { issuesFrom, now, StoreError, type Row } from "./errors";

// WF-04 persistence. Every read and write is scoped by project: a brand id
// from another project is "not found", and a logo may only point at an asset
// in the same project's register.

export type BrandVersion = { id: string; version: number; status: "draft" | "approved" | "superseded"; content: BrandContent; createdAt: string; updatedAt: string; approvedAt: string | null };
export type Brand = { id: string; projectId: string; key: string; name: string; createdAt: string; updatedAt: string };

type Context = {
  db: DatabaseSync;
  requireProject: (id: string) => Project;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  assetIds: (projectId: string) => Set<string>;
  suggestionInput: (projectId: string) => SuggestionInput;
};

const toBrand = (r: Row): Brand => ({ id: String(r.id), projectId: String(r.project_id), key: String(r.key), name: String(r.name), createdAt: String(r.created_at), updatedAt: String(r.updated_at) });
const toVersion = (r: Row): BrandVersion => ({
  id: String(r.id),
  version: Number(r.version),
  status: r.status as BrandVersion["status"],
  content: BrandContent.parse(JSON.parse(String(r.content))),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  approvedAt: (r.approved_at as string | null) ?? null,
});

export function createBrandStore(ctx: Context) {
  const { db } = ctx;

  const requireBrand = (projectId: string, brandId: string): Brand => {
    ctx.requireProject(projectId);
    const row = db.prepare("select * from brands where id = ? and project_id = ?").get(brandId, projectId) as Row | undefined;
    if (!row) throw new StoreError("not_found", "Brand not found.");
    return toBrand(row);
  };
  const versions = (brandId: string) => (db.prepare("select * from brand_versions where brand_id = ? order by version desc").all(brandId) as Row[]).map(toVersion);
  const latest = (brandId: string) => versions(brandId)[0];
  const approved = (brandId: string) => versions(brandId).find((v) => v.status === "approved") ?? null;

  const parseContent = (input: unknown): BrandContent => {
    const r = BrandContent.safeParse(input);
    if (!r.success) throw new StoreError("invalid", "Some values are not valid. Fix the highlighted fields.", issuesFrom(r.error));
    return r.data;
  };
  // Asset references must be this project's own register entries.
  const checkAssets = (projectId: string, b: BrandContent) => {
    const ids = ctx.assetIds(projectId);
    const refs: [string, AssetRef | null][] = [
      ...b.assets.logos.map((l, i) => [`assets.logos.${i}.ref`, l.ref] as [string, AssetRef]),
      ...b.assets.images.map((l, i) => [`assets.images.${i}.ref`, l.ref] as [string, AssetRef]),
      ["assets.icons.customRef", b.assets.icons.customRef],
    ];
    const bad = refs.filter(([, r]) => r?.kind === "asset" && !ids.has(r.assetId));
    if (bad.length) throw new StoreError("invalid", "An asset reference is not in this project's asset register.", bad.map(([path]) => ({ path, message: "Not in this project's asset register" })));
  };

  const self = {
    list(projectId: string) {
      ctx.requireProject(projectId);
      return (db.prepare("select * from brands where project_id = ? order by created_at").all(projectId) as Row[]).map((r) => {
        const brand = toBrand(r);
        const l = latest(brand.id);
        return { brand, latest: l, approved: approved(brand.id), errors: blocking(brandIssues(l.content)).length };
      });
    },

    get(projectId: string, brandId: string) {
      const brand = requireBrand(projectId, brandId);
      const all = versions(brandId);
      return { brand, versions: all, latest: all[0], approved: all.find((v) => v.status === "approved") ?? null };
    },

    create(projectId: string, input: { name: unknown }): Brand {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 80) throw new StoreError("invalid", "Name the brand (up to 80 characters).", [{ path: "name", message: "Required" }]);
      return transaction(db, () => {
        ctx.requireProject(projectId);
        const base = slugify(name, 40) || "brand";
        let key = base;
        for (let n = 2; db.prepare("select 1 from brands where project_id = ? and key = ?").get(projectId, key); n++) key = `${base}-${n}`;
        const id = randomUUID();
        const at = now();
        db.prepare("insert into brands (id, project_id, key, name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(id, projectId, key, name, at, at);
        db.prepare("insert into brand_versions (id, brand_id, version, status, content, created_at, updated_at, approved_at) values (?, ?, 1, 'draft', ?, ?, ?, null)").run(randomUUID(), id, JSON.stringify(defaultBrand()), at, at);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "brand_created", `Brand created: ${name}`);
        return requireBrand(projectId, id);
      });
    },

    saveDraft(projectId: string, brandId: string, versionId: string, input: unknown): BrandVersion {
      const content = parseContent(input);
      checkAssets(projectId, content);
      return transaction(db, () => {
        requireBrand(projectId, brandId);
        const l = latest(brandId);
        if (l.id !== versionId || l.status !== "draft") throw new StoreError("conflict", "This brand changed since you opened it. Reload to see the current version.");
        db.prepare("update brand_versions set content = ?, updated_at = ? where id = ?").run(JSON.stringify(content), now(), versionId);
        db.prepare("update brands set updated_at = ? where id = ?").run(now(), brandId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "brand_saved", `Brand draft saved (v${l.version})`);
        return latest(brandId);
      });
    },

    suggest(projectId: string, brandId: string, versionId: string): { applied: string[] } {
      const { content, applied } = applySuggestions(self.get(projectId, brandId).latest.content, ctx.suggestionInput(projectId));
      if (applied.length) self.saveDraft(projectId, brandId, versionId, content);
      return { applied };
    },

    approve(projectId: string, brandId: string, versionId: string): BrandVersion {
      return transaction(db, () => {
        requireBrand(projectId, brandId);
        const l = latest(brandId);
        if (l.id !== versionId || l.status !== "draft") throw new StoreError("conflict", "This brand changed since you opened it. Reload to see the current version.");
        checkAssets(projectId, l.content);
        const errors = blocking(brandIssues(l.content));
        if (errors.length) throw new StoreError("invalid", "Not approved: fix these first.", errors.map((e) => ({ path: e.path, message: e.message })));
        const at = now();
        db.prepare("update brand_versions set status = 'superseded', updated_at = ? where brand_id = ? and status = 'approved'").run(at, brandId);
        db.prepare("update brand_versions set status = 'approved', approved_at = ?, updated_at = ? where id = ?").run(at, at, versionId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "brand_approved", `Brand version ${l.version} approved`);
        return latest(brandId);
      });
    },

    revise(projectId: string, brandId: string): BrandVersion {
      return transaction(db, () => {
        requireBrand(projectId, brandId);
        const l = latest(brandId);
        if (l.status === "draft") return l;
        const at = now();
        db.prepare("insert into brand_versions (id, brand_id, version, status, content, created_at, updated_at, approved_at) values (?, ?, ?, 'draft', ?, ?, ?, null)").run(randomUUID(), brandId, l.version + 1, JSON.stringify(l.content), at, at);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "brand_revision", `Brand version ${l.version + 1} opened`);
        return latest(brandId);
      });
    },

    // The version requested, or the approved one, or (for previews) the latest.
    resolve(projectId: string, brandId: string, which: "approved" | "latest" | number) {
      const { brand, versions: all } = self.get(projectId, brandId);
      const v = which === "approved" ? all.find((x) => x.status === "approved") : which === "latest" ? all[0] : all.find((x) => x.version === which);
      if (!v) throw new StoreError("not_found", which === "approved" ? "No approved version yet." : "Version not found.");
      return { brand, version: v };
    },

    scopeSelector: (brand: Brand) => `[data-scl-brand="${brand.key}"]`,

    exportJson(projectId: string, brandId: string, which: "approved" | "latest" | number): BrandExport {
      const project = ctx.requireProject(projectId);
      const { brand, version } = self.resolve(projectId, brandId, which);
      const b = version.content;
      const tokens = listTokens(b);
      const by = (s: string) => tokens.filter((t) => t.status === s).map((t) => t.path);
      const loc = (r: AssetRef) => (r.kind === "asset" ? { kind: "asset" as const, assetId: r.assetId, url: `/api/projects/${projectId}/assets/${r.assetId}/file` } : { kind: "url" as const, assetId: null, url: r.url });
      return BrandExport.parse({
        schema: BRAND_CONFIG_SCHEMA,
        generatedAt: now(),
        project: { id: project.id, slug: project.slug },
        brand: { id: brand.id, key: brand.key, name: brand.name },
        version: { number: version.version, status: version.status, approvedAt: version.approvedAt },
        config: b,
        cssVariables: brandVariables(b),
        reducedMotionVariables: reducedMotionVariables(b),
        breakpointsPx: { sm: b.layout.breakpoints.sm.value, md: b.layout.breakpoints.md.value, lg: b.layout.breakpoints.lg.value, xl: b.layout.breakpoints.xl.value },
        scopeSelector: self.scopeSelector(brand),
        provenance: { confirmed: by("confirmed"), inferred: by("inferred"), default: by("default"), missing: missingTokens(b) },
        issues: brandIssues(b),
        contrast: contrastChecks(b).map((c) => ({ fg: c.fg, bg: c.bg, ratio: c.ratio, min: c.min, passes: c.passes })),
        assets: [
          ...b.assets.logos.map((l) => ({ use: `logo:${l.variant}:${l.background}`, status: l.status, note: l.note, location: loc(l.ref) })),
          ...b.assets.images.map((i) => ({ use: `image:${i.role}`, status: i.status, note: i.note, location: loc(i.ref) })),
          ...(b.assets.icons.customRef ? [{ use: "icons:custom", status: b.assets.icons.library.status, note: "", location: loc(b.assets.icons.customRef) }] : []),
        ],
      });
    },

    exportCss(projectId: string, brandId: string, which: "approved" | "latest" | number, scoped: boolean): string {
      const { brand, version } = self.resolve(projectId, brandId, which);
      return brandCss(version.content, {
        selector: scoped ? self.scopeSelector(brand) : ":root",
        header: `${BRAND_CONFIG_SCHEMA} · ${brand.name} (${brand.key}) · version ${version.version} (${version.status})`,
      });
    },
  };
  return self;
}

export type BrandStore = ReturnType<typeof createBrandStore>;

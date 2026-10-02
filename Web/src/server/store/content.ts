import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ClientBrief } from "@/domain/client-brief";
import { BlockContent, pagePath, PageContent, sectionAnchor, SiteSettings, type MediaRef, type PageStatus, type Section } from "@/domain/content";
import { generateSitemap } from "@/domain/content-generate";
import { CONTENT_MANIFEST_SCHEMA, ContentManifest } from "@/domain/content-manifest";
import { validatePage, type ContentIssue, type ValidationContext } from "@/domain/content-validate";
import type { Project } from "@/domain/project";
import { transaction } from "./db";
import { issuesFrom, now, StoreError, type Row } from "./errors";

// WF-05 persistence: this app's own content store. There is no SCL CMS API
// to call (none exists in this repository), so this module is the boundary a
// CMS adapter would replace; nothing above it knows how content is stored.
//
// Pages move draft → in_review → approved → published. Publishing freezes a
// snapshot: later edits send the page back to draft but the published
// snapshot stays live until the next publish.

export type PageRecord = {
  id: string;
  position: number;
  status: PageStatus;
  origin: "generated" | "person";
  revision: number;
  content: PageContent;
  published: { content: PageContent; revision: number; at: string } | null;
  updatedAt: string;
};

type Brands = {
  approvedVariables: (projectId: string, brandId: string) => { vars: Record<string, string>; reduced: Record<string, string>; version: number; key: string } | null;
  latestVariables: (projectId: string, brandId: string) => { vars: Record<string, string>; reduced: Record<string, string>; version: number; key: string } | null;
  exists: (projectId: string, brandId: string) => boolean;
  first: (projectId: string) => string | null;
};

type Context = {
  db: DatabaseSync;
  requireProject: (id: string) => Project;
  approvedBrief: (projectId: string) => ClientBrief | null;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  assetIds: (projectId: string) => Set<string>;
  brands: Brands;
};

const toPage = (r: Row): PageRecord => ({
  id: String(r.id),
  position: Number(r.position),
  status: r.status as PageStatus,
  origin: r.origin as PageRecord["origin"],
  revision: Number(r.revision),
  content: PageContent.parse(JSON.parse(String(r.content))),
  published: r.published_content ? { content: PageContent.parse(JSON.parse(String(r.published_content))), revision: Number(r.published_revision), at: String(r.published_at) } : null,
  updatedAt: String(r.updated_at),
});

export function createContentStore(ctx: Context) {
  const { db } = ctx;

  const parse = <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T => {
    const r = schema.safeParse(input);
    if (!r.success) throw new StoreError("invalid", "Some content is not valid. Fix the highlighted fields.", issuesFrom(r.error));
    return r.data;
  };

  const site = (projectId: string): SiteSettings => {
    const project = ctx.requireProject(projectId);
    const r = db.prepare("select * from sites where project_id = ?").get(projectId) as Row | undefined;
    if (r) return { siteName: String(r.site_name), baseUrl: String(r.base_url), brandId: (r.brand_id as string | null) ?? null, locale: String(r.locale) };
    return { siteName: project.clientName, baseUrl: "", brandId: ctx.brands.first(projectId), locale: ctx.approvedBrief(projectId)?.content?.constraints.locales[0] ?? "en" };
  };

  const pages = (projectId: string) => (db.prepare("select * from pages where project_id = ? order by position, created_at").all(projectId) as Row[]).map(toPage);
  const requirePage = (projectId: string, pageId: string) => {
    ctx.requireProject(projectId);
    const r = db.prepare("select * from pages where id = ? and project_id = ?").get(pageId, projectId) as Row | undefined;
    if (!r) throw new StoreError("not_found", "Page not found.");
    return toPage(r);
  };
  const blocks = (projectId: string) =>
    (db.prepare("select * from content_blocks where project_id = ? order by name").all(projectId) as Row[]).map((r) => ({ id: String(r.id), name: String(r.name), section: JSON.parse(String(r.section)) as Section, updatedAt: String(r.updated_at) }));

  const validationContext = (projectId: string): ValidationContext => {
    const s = site(projectId);
    return {
      pages: pages(projectId).map((p) => ({ id: p.id, status: p.status, published: p.published !== null, content: p.content })),
      blocks: new Map(blocks(projectId).map((b) => [b.id, b.section])),
      assetIds: ctx.assetIds(projectId),
      baseUrl: s.baseUrl,
      brand: { selected: s.brandId !== null && ctx.brands.exists(projectId, s.brandId), approved: s.brandId !== null && ctx.brands.approvedVariables(projectId, s.brandId) !== null },
    };
  };

  const insertPage = (projectId: string, id: string, content: PageContent, origin: "generated" | "person") => {
    const pos = (db.prepare("select coalesce(max(position), -1) + 1 as p from pages where project_id = ?").get(projectId) as { p: number }).p;
    const at = now();
    db.prepare("insert into pages (id, project_id, slug, position, content, status, origin, revision, published_content, published_revision, published_at, created_at, updated_at) values (?, ?, ?, ?, ?, 'draft', ?, 1, null, null, null, ?, ?)").run(
      id,
      projectId,
      content.slug,
      pos,
      JSON.stringify(content),
      origin,
      at,
      at,
    );
  };

  const self = {
    site,
    pages,
    blocks,

    updateSite(projectId: string, input: unknown): SiteSettings {
      const s = parse(SiteSettings, input);
      if (s.brandId && !ctx.brands.exists(projectId, s.brandId)) throw new StoreError("invalid", "That brand is not in this project.", [{ path: "brandId", message: "Not in this project" }]);
      return transaction(db, () => {
        ctx.requireProject(projectId);
        db.prepare("insert into sites (project_id, site_name, base_url, brand_id, locale, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(project_id) do update set site_name = excluded.site_name, base_url = excluded.base_url, brand_id = excluded.brand_id, locale = excluded.locale, updated_at = excluded.updated_at").run(
          projectId,
          s.siteName,
          s.baseUrl.replace(/\/$/, ""),
          s.brandId,
          s.locale,
          now(),
        );
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "site_updated", "Site settings updated");
        return site(projectId);
      });
    },

    getPage: requirePage,

    createPage(projectId: string, input: { title: unknown; slug: unknown }): PageRecord {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const slug = typeof input.slug === "string" ? input.slug.trim() : "";
      const content = parse(PageContent, {
        slug,
        title,
        navLabel: title.slice(0, 40),
        inNav: true,
        inFooter: false,
        layout: "standard",
        templateRef: null,
        seo: { title: title.slice(0, 70), description: "", canonicalPath: "", noindex: false, ogImage: null },
        sections: [{ id: randomUUID(), type: "hero", eyebrow: "", heading: title, body: "", media: null, ctas: [] }],
      });
      return transaction(db, () => {
        ctx.requireProject(projectId);
        if (db.prepare("select 1 from pages where project_id = ? and slug = ?").get(projectId, content.slug)) throw new StoreError("conflict", `A page already uses the path ${pagePath(content.slug)}.`, [{ path: "slug", message: "Path in use" }]);
        const id = randomUUID();
        insertPage(projectId, id, content, "person");
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "page_created", `Page created: ${content.title}`);
        return requirePage(projectId, id);
      });
    },

    // Drafts the sitemap and pages from the approved brief. Re-runnable: pages
    // whose path already exists are left alone.
    generateFromBrief(projectId: string): { created: number; skipped: number } {
      return transaction(db, () => {
        const project = ctx.requireProject(projectId);
        const brief = ctx.approvedBrief(projectId);
        if (!brief?.content) throw new StoreError("conflict", "Approve the client brief first; pages are drafted from its approved version.");
        const existing = new Set(pages(projectId).map((p) => p.content.slug));
        const generated = generateSitemap(brief.content, existing, project.clientName);
        for (const g of generated) insertPage(projectId, g.id, PageContent.parse(g.content), "generated");
        if (generated.length) {
          ctx.touchProject(projectId);
          ctx.logActivity(projectId, "pages_generated", `${generated.length} page draft(s) generated from brief v${brief.version}`);
        }
        return { created: generated.length, skipped: brief.content.requiredPages.length - generated.length };
      });
    },

    // Saves an edit. Editing reviewed, approved or published content sends it
    // back to draft; a published snapshot stays live until republished.
    savePage(projectId: string, pageId: string, revision: number, input: unknown): PageRecord {
      const content = parse(PageContent, input);
      for (const s of content.sections) if (s.type === "block" && !blocks(projectId).some((b) => b.id === s.blockId)) throw new StoreError("invalid", "A reusable block on this page does not exist.");
      return transaction(db, () => {
        const p = requirePage(projectId, pageId);
        if (p.revision !== revision) throw new StoreError("conflict", "This page changed since you opened it. Reload to see the current version.");
        if (db.prepare("select 1 from pages where project_id = ? and slug = ? and id <> ?").get(projectId, content.slug, pageId)) throw new StoreError("conflict", `Another page already uses the path ${pagePath(content.slug)}.`, [{ path: "slug", message: "Path in use" }]);
        db.prepare("update pages set content = ?, slug = ?, status = 'draft', revision = revision + 1, updated_at = ? where id = ?").run(JSON.stringify(content), content.slug, now(), pageId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "page_saved", `Page saved: ${content.title}`);
        return requirePage(projectId, pageId);
      });
    },

    issues(projectId: string, pageId: string, publishing = false): ContentIssue[] {
      requirePage(projectId, pageId);
      return validatePage(pageId, validationContext(projectId), publishing);
    },

    transition(projectId: string, pageId: string, action: "submit" | "approve" | "return" | "publish" | "unpublish"): PageRecord {
      return transaction(db, () => {
        const p = requirePage(projectId, pageId);
        const block = (publishing: boolean) => {
          const errors = validatePage(pageId, validationContext(projectId), publishing).filter((i) => i.level === "error");
          if (errors.length) throw new StoreError("invalid", `Not ${action === "publish" ? "published" : "submitted"}: fix these first.`, errors.map((e) => ({ path: e.path, message: e.message })));
        };
        const set = (status: PageStatus, extra = "") => db.prepare(`update pages set status = ?, updated_at = ?${extra} where id = ?`).run(status, now(), pageId);
        switch (action) {
          case "submit":
            if (p.status !== "draft") throw new StoreError("conflict", "Only drafts can be submitted for review.");
            block(false);
            set("in_review");
            break;
          case "approve":
            if (p.status !== "in_review") throw new StoreError("conflict", "Only pages in review can be approved.");
            block(false);
            set("approved");
            break;
          case "return":
            if (p.status !== "in_review" && p.status !== "approved") throw new StoreError("conflict", "Only pages in review or approved can be returned to draft.");
            set("draft");
            break;
          case "publish":
            if (p.status !== "approved") throw new StoreError("conflict", "Only approved pages can be published. Submit it for review first.");
            block(true);
            db.prepare("update pages set status = 'published', published_content = content, published_revision = revision, published_at = ?, updated_at = ? where id = ?").run(now(), now(), pageId);
            break;
          case "unpublish":
            if (!p.published) throw new StoreError("conflict", "This page is not published.");
            db.prepare("update pages set status = case when status = 'published' then 'approved' else status end, published_content = null, published_revision = null, published_at = null, updated_at = ? where id = ?").run(now(), pageId);
            break;
        }
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, `page_${action}`, `Page ${action === "return" ? "returned to draft" : `${action}${action.endsWith("e") ? "d" : "ed"}`}: ${p.content.title}`);
        return requirePage(projectId, pageId);
      });
    },

    movePage(projectId: string, pageId: string, direction: -1 | 1): void {
      transaction(db, () => {
        const all = pages(projectId);
        const i = all.findIndex((p) => p.id === pageId);
        if (i < 0) throw new StoreError("not_found", "Page not found.");
        const j = i + direction;
        if (j < 0 || j >= all.length) return;
        [all[i], all[j]] = [all[j], all[i]];
        all.forEach((p, k) => db.prepare("update pages set position = ? where id = ?").run(k, p.id));
        ctx.touchProject(projectId);
      });
    },

    deletePage(projectId: string, pageId: string): void {
      transaction(db, () => {
        const p = requirePage(projectId, pageId);
        db.prepare("delete from pages where id = ?").run(pageId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "page_deleted", `Page deleted: ${p.content.title}`);
      });
    },

    saveBlock(projectId: string, blockId: string | null, input: unknown): string {
      const b = parse(BlockContent, input);
      if (b.section.type === "block") throw new StoreError("invalid", "A reusable block cannot contain another block.");
      return transaction(db, () => {
        ctx.requireProject(projectId);
        const at = now();
        if (blockId) {
          const r = db.prepare("update content_blocks set name = ?, section = ?, updated_at = ? where id = ? and project_id = ?").run(b.name, JSON.stringify(b.section), at, blockId, projectId);
          if (r.changes === 0) throw new StoreError("not_found", "Block not found.");
        } else {
          blockId = randomUUID();
          db.prepare("insert into content_blocks (id, project_id, name, section, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(blockId, projectId, b.name, JSON.stringify({ ...b.section, id: randomUUID() }), at, at);
        }
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "block_saved", `Reusable block saved: ${b.name}`);
        return blockId;
      });
    },

    deleteBlock(projectId: string, blockId: string): void {
      transaction(db, () => {
        ctx.requireProject(projectId);
        const users = pages(projectId).filter((p) => p.content.sections.some((s) => s.type === "block" && s.blockId === blockId));
        if (users.length) throw new StoreError("conflict", `In use on: ${users.map((u) => u.content.title).join(", ")}. Remove it from those pages first.`);
        const r = db.prepare("delete from content_blocks where id = ? and project_id = ?").run(blockId, projectId);
        if (r.changes === 0) throw new StoreError("not_found", "Block not found.");
        ctx.touchProject(projectId);
      });
    },

    // What a page route renders: the published snapshot, or in preview the
    // latest content, with navigation, blocks and brand variables.
    resolve(projectId: string, path: string, mode: "preview" | "published") {
      const all = pages(projectId);
      const visible = (p: PageRecord) => (mode === "preview" ? p.content : p.published?.content ?? null);
      const page = all.find((p) => visible(p) && pagePath(visible(p)!.slug) === path);
      if (!page) return null;
      return {
        ...self.shell(projectId, mode),
        page: { id: page.id, revision: mode === "preview" ? page.revision : page.published!.revision, status: page.status, content: visible(page)! },
        blocks: new Map(blocks(projectId).map((b) => [b.id, b.section])),
      };
    },

    // What every site route shares, pages and journeys alike: settings,
    // navigation, page paths and the brand's variables.
    shell(projectId: string, mode: "preview" | "published") {
      const s = site(projectId);
      const all = pages(projectId);
      const visible = (p: PageRecord) => (mode === "preview" ? p.content : p.published?.content ?? null);
      const brand = s.brandId ? (mode === "published" ? ctx.brands.approvedVariables(projectId, s.brandId) : ctx.brands.approvedVariables(projectId, s.brandId) ?? ctx.brands.latestVariables(projectId, s.brandId)) : null;
      const nav = (key: "inNav" | "inFooter") =>
        all.flatMap((p) => {
          const c = visible(p);
          return c && c[key] ? [{ pageId: p.id, label: c.navLabel || c.title, path: pagePath(c.slug) }] : [];
        });
      return {
        site: s,
        pagePaths: new Map(all.flatMap((p) => (visible(p) ? [[p.id, pagePath(visible(p)!.slug)] as const] : []))),
        navigation: { primary: nav("inNav"), footer: nav("inFooter") },
        brand,
      };
    },

    manifest(projectId: string): ContentManifest {
      const project = ctx.requireProject(projectId);
      const s = site(projectId);
      const vctx = validationContext(projectId);
      const all = pages(projectId);
      const bl = blocks(projectId);
      const brandV = s.brandId ? ctx.brands.approvedVariables(projectId, s.brandId) : null;
      const collect = (p: PageRecord) => {
        const media: { id: string; sectionId: string | null; source: unknown; alt: string; decorative: boolean }[] = [];
        const ctas: { id: string; sectionId: string; label: string; actionKind: string | null; target: unknown }[] = [];
        const addMedia = (m: MediaRef, sectionId: string | null) => m && media.push({ id: m.id, sectionId, source: m.source, alt: m.alt, decorative: m.decorative });
        addMedia(p.content.seo.ogImage, null);
        for (const raw of p.content.sections) {
          const sec = raw.type === "block" ? bl.find((b) => b.id === raw.blockId)?.section : raw;
          if (!sec) continue;
          if (sec.type === "hero") addMedia(sec.media, raw.id);
          if (sec.type === "features") sec.items.forEach((it) => addMedia(it.media, raw.id));
          if (sec.type === "gallery") sec.images.forEach((m) => addMedia(m, raw.id));
          if (sec.type === "hero" || sec.type === "cta") for (const c of sec.ctas) ctas.push({ id: c.id, sectionId: raw.id, label: c.label, actionKind: c.actionKind, target: c.target });
        }
        return { media, ctas };
      };
      const canonical = (c: PageContent) => (s.baseUrl ? `${s.baseUrl}${c.seo.canonicalPath || pagePath(c.slug)}` : null);
      const navOf = (key: "inNav" | "inFooter") => all.filter((p) => p.content[key]).map((p) => ({ pageId: p.id, label: p.content.navLabel || p.content.title, path: pagePath(p.content.slug) }));
      return ContentManifest.parse({
        schema: CONTENT_MANIFEST_SCHEMA,
        generatedAt: now(),
        project: { id: project.id, slug: project.slug },
        site: {
          siteName: s.siteName,
          baseUrl: s.baseUrl,
          locale: s.locale,
          brand: s.brandId ? { id: s.brandId, version: brandV?.version ?? null, configPath: `/api/projects/${projectId}/brands/${s.brandId}/config`, cssPath: `/api/projects/${projectId}/brands/${s.brandId}/css` } : null,
          publishedRoot: `/site/${projectId}`,
          previewRoot: `/preview/${projectId}`,
        },
        navigation: { primary: navOf("inNav"), footer: navOf("inFooter") },
        pages: all.map((p) => ({
          id: p.id,
          path: pagePath(p.content.slug),
          canonicalUrl: canonical(p.content),
          title: p.content.title,
          layout: p.content.layout,
          templateRef: p.content.templateRef,
          status: p.status,
          revision: p.revision,
          published: p.published ? { revision: p.published.revision, at: p.published.at } : null,
          sections: p.content.sections.map((sec) => ({ id: sec.id, type: sec.type === "block" ? bl.find((b) => b.id === sec.blockId)?.section.type ?? "block" : sec.type, anchor: sectionAnchor(sec.id), blockId: sec.type === "block" ? sec.blockId : null })),
          ...collect(p),
          content: p.content,
          issues: validatePage(p.id, vctx, false),
        })),
        blocks: bl.map((b) => ({ id: b.id, name: b.name, section: b.section, usedBy: all.filter((p) => p.content.sections.some((x) => x.type === "block" && x.blockId === b.id)).map((p) => p.id) })),
      });
    },
  };
  return self;
}

export type ContentStore = ReturnType<typeof createContentStore>;

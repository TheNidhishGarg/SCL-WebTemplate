import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PageContent } from "@/domain/content";
import { sectionAnchor } from "@/domain/content";
import type { JourneySpec } from "@/domain/journey-contract";
import type { AssetManifest } from "@/domain/production";
import { checkBundle, JOURNEY_BUNDLE_SCHEMA, type BundleIssue, type BundleScene, type JourneyBundle } from "@/runtime/journey/bundle";
import { transaction } from "./db";
import { now, StoreError, type Row } from "./errors";

// WF-08 assembly: the approved journey spec (WF-06), the approved media
// (WF-07) and the conventional pages (WF-05) become one journey bundle for the
// runtime. Nothing is guessed: every scene, branch and CTA comes from the
// spec by id, every media URL is an approved take of this journey version's
// production, and every page link resolves to a page visitors can open.

type Mode = "published" | "preview";
type PageInfo = { id: string; path: string; title: string; sectionIds: Set<string> };

type Context = {
  db: DatabaseSync;
  requireProject: (id: string) => unknown;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  journeys: () => { list: (projectId: string) => { journey: { id: string; key: string; name: string }; approved: { version: number } | null }[] };
  journeySpec: (projectId: string, journeyId: string) => JourneySpec;
  aspectRatio: (projectId: string, journeyId: string) => JourneyBundle["aspectRatio"];
  // The production for a journey version, with its approved takes.
  production: (projectId: string, journeyId: string, version: number) => { id: string; manifest: AssetManifest; approvedTakes: Map<string, string> } | null;
  // Pages visitors can open in this mode: published snapshots, or in preview the latest content.
  pages: (projectId: string, mode: Mode) => { id: string; content: PageContent }[];
};

export type AssemblyIssue = BundleIssue;
export type Release = { id: string; number: number; journeyVersion: number; productionId: string | null; createdAt: string; withdrawnAt: string | null; bundle: JourneyBundle };

const toRelease = (r: Row): Release => ({
  id: String(r.id),
  number: Number(r.number),
  journeyVersion: Number(r.journey_version),
  productionId: (r.production_id as string | null) ?? null,
  createdAt: String(r.created_at),
  withdrawnAt: (r.withdrawn_at as string | null) ?? null,
  bundle: JSON.parse(String(r.bundle)) as JourneyBundle,
});

export function createExperienceStore(ctx: Context) {
  const { db } = ctx;

  const pageIndex = (projectId: string, mode: Mode): Map<string, PageInfo> =>
    new Map(
      ctx.pages(projectId, mode).map((p) => [p.id, { id: p.id, path: p.content.slug ? `/${p.content.slug}` : "/", title: p.content.navLabel || p.content.title, sectionIds: new Set(p.content.sections.map((s) => s.id)) }]),
    );

  const requireJourney = (projectId: string, journeyId: string) => {
    const j = ctx.journeys().list(projectId).find((x) => x.journey.id === journeyId);
    if (!j) throw new StoreError("not_found", "Journey not found.");
    return j;
  };

  function assemble(projectId: string, journeyId: string, mode: Mode): { bundle: JourneyBundle | null; issues: AssemblyIssue[]; productionId: string | null; version: number } {
    ctx.requireProject(projectId);
    const spec = ctx.journeySpec(projectId, journeyId); // approved only; not_found otherwise
    const issues: AssemblyIssue[] = [];
    // Readiness problems block publishing; in preview they are shown, not fatal.
    const gap = (sceneId: string | null, message: string) => issues.push({ level: mode === "published" ? "error" : "warning", sceneId, message });
    const pages = pageIndex(projectId, mode);
    const prod = ctx.production(projectId, journeyId, spec.version.number);
    if (!prod) gap(null, `No production for version ${spec.version.number}. Start one in Production (WF-07) and approve its takes.`);
    else if (prod.manifest.journey.id !== spec.journey.id || prod.manifest.journey.version !== spec.version.number) issues.push({ level: "error", sceneId: null, message: "The asset manifest is for a different journey version." });

    const takeUrl = prod ? new RegExp(`^/api/projects/${projectId}/production/${prod.id}/takes/([0-9a-f-]{36})/file$`) : null;
    const validAsset = (sceneId: string, a: NonNullable<AssetManifest["scenes"][number]["slots"][number]["asset"]>) => {
      const m = takeUrl?.exec(a.url);
      if (!m || prod!.approvedTakes.get(m[1]) !== a.sha256) {
        issues.push({ level: "error", sceneId, message: `Asset ${a.takeId} is not an approved take of this production.` });
        return false;
      }
      return true;
    };

    const link = (sceneId: string, label: string, t: JourneySpec["scenes"][number]["ctas"][number]["target"]): string | null => {
      if (t.kind === "url") return t.path;
      const page = t.pageId ? pages.get(t.pageId) : undefined;
      if (!page) {
        gap(sceneId, `"${label}" links to a page that is not ${mode === "published" ? "published" : "in the site"}.`);
        return null;
      }
      if (t.kind === "section") {
        if (!t.sectionId || !page.sectionIds.has(t.sectionId)) {
          gap(sceneId, `"${label}" links to a section that is no longer on "${page.title}".`);
          return page.path;
        }
        return `${page.path}#${sectionAnchor(t.sectionId)}`;
      }
      return page.path;
    };

    const scenes: BundleScene[] = spec.scenes.map((s) => {
      const slots = prod?.manifest.scenes.find((x) => x.sceneId === s.id)?.slots ?? [];
      const moving = slots.filter((x) => x.kind === "video" || x.kind === "loop");
      const approved = moving.find((x) => x.status === "approved" && x.asset && validAsset(s.id, x.asset));
      const still = slots.find((x) => x.kind === "still" && x.status === "approved" && x.asset && validAsset(s.id, x.asset));
      let unavailableReason: string | null = null;
      if (!approved) {
        const blocked = moving.find((x) => x.status === "blocked");
        if (blocked) {
          unavailableReason = `Blocked in production: ${blocked.blockedReason}`;
          issues.push({ level: "warning", sceneId: s.id, message: `"${s.title}" has no footage (${unavailableReason}). It plays as a title card.` });
        } else if (moving.length || !prod) {
          unavailableReason = "No approved footage yet";
          if (prod) gap(s.id, `"${s.title}" has no approved take and is not marked blocked.`);
        }
      }
      const a = approved?.asset;
      const ctas = s.ctas.flatMap((c) => {
        const href = link(s.id, c.label, c.target);
        return href ? [{ id: c.id, label: c.label, href, actionKind: c.actionKind, placement: c.placement as BundleScene["ctas"][number]["placement"], appearsAtSeconds: c.appearsAtSeconds }] : [];
      });
      return {
        id: s.id,
        title: s.title,
        type: s.type,
        durationSeconds: s.durationSeconds,
        video: a ? { src: a.url, type: a.mimeType as "video/mp4", width: a.width, height: a.height, durationSeconds: a.durationSeconds, sha256: a.sha256 } : null,
        loop: approved?.kind === "loop",
        poster: still?.asset ? { src: still.asset.url, type: still.asset.mimeType as "image/png" } : null,
        unavailableReason,
        next: s.next ? { to: { kind: "scene" as const, sceneId: s.next.to }, style: s.next.style, durationMs: s.next.durationMs } : null,
        choice: s.choice
          ? {
              heading: s.title,
              branches: s.choice.branches.map((b) => ({ id: b.id, label: b.label, to: { kind: "scene" as const, sceneId: b.to }, style: b.style, durationMs: b.durationMs })),
              timeout: s.choice.timeout,
            }
          : null,
        ctas,
      };
    });

    // Where visitors go when they finish, leave or the journey cannot play:
    // the entry page, else the first page a conversion CTA links to, else home.
    const ep = spec.entryPoint;
    const ctaPage = spec.scenes.flatMap((s) => s.ctas).find((c) => c.target.pageId && pages.has(c.target.pageId))?.target.pageId;
    const home = [...pages.values()].find((p) => p.path === "/");
    const exitPage = (ep.pageId && pages.get(ep.pageId)) || (ctaPage && pages.get(ctaPage)) || home;
    if (!exitPage) issues.push({ level: "error", sceneId: null, message: `Publish a page visitors can fall back to (the home page or the journey's entry page). The conventional site must work without the journey.` });
    if (ep.pageId && !pages.has(ep.pageId)) issues.push({ level: "warning", sceneId: null, message: "The entry page is not published, so no launcher appears on the site; the journey is reachable at its own URL." });

    const draft = {
      schema: JOURNEY_BUNDLE_SCHEMA,
      generatedAt: now(),
      release: null,
      project: { id: projectId },
      journey: { id: spec.journey.id, key: spec.journey.key, name: spec.journey.name, version: spec.version.number },
      sources: { journeySpec: { schema: spec.schema, version: spec.version.number }, assetManifest: prod ? { schema: prod.manifest.schema, productionId: prod.id } : null, content: mode },
      aspectRatio: ctx.aspectRatio(projectId, journeyId),
      entry: ep.pageId && pages.has(ep.pageId) ? { pageId: ep.pageId, sectionId: ep.sectionId } : null,
      exit: { href: exitPage?.path ?? "/", label: exitPage?.title.slice(0, 60) || "Home" },
      startSceneId: spec.startSceneId,
      scenes,
    };
    const checked = checkBundle(draft);
    issues.push(...checked.issues);
    return { bundle: checked.bundle, issues, productionId: prod?.id ?? null, version: spec.version.number };
  }

  const self = {
    assemble,

    publish(projectId: string, journeyId: string): Release {
      const j = requireJourney(projectId, journeyId);
      const { bundle, issues, productionId, version } = assemble(projectId, journeyId, "published");
      const errors = issues.filter((i) => i.level === "error");
      if (!bundle || errors.length) throw new StoreError("invalid", `Not published: ${errors.length} item(s) to fix.`, errors.map((e) => ({ path: e.sceneId ?? "journey", message: e.message })));
      return transaction(db, () => {
        const number = Number((db.prepare("select coalesce(max(number), 0) as n from journey_releases where journey_id = ?").get(journeyId) as Row).n) + 1;
        const at = now();
        const frozen: JourneyBundle = { ...bundle, release: { number, publishedAt: at } };
        const id = randomUUID();
        db.prepare("insert into journey_releases (id, project_id, journey_id, number, journey_version, production_id, bundle, created_at, withdrawn_at) values (?, ?, ?, ?, ?, ?, ?, ?, null)").run(
          id,
          projectId,
          journeyId,
          number,
          version,
          productionId,
          JSON.stringify(frozen),
          at,
        );
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "journey_published", `Journey "${j.journey.name}" release ${number} published (version ${version})`);
        return toRelease(db.prepare("select * from journey_releases where id = ?").get(id) as Row);
      });
    },

    // Takes the journey off the site; visitors are sent to the conventional pages.
    withdraw(projectId: string, journeyId: string): void {
      requireJourney(projectId, journeyId);
      const r = db.prepare("update journey_releases set withdrawn_at = ? where journey_id = ? and project_id = ? and withdrawn_at is null").run(now(), journeyId, projectId);
      if (!r.changes) throw new StoreError("conflict", "This journey has no live release.");
      ctx.touchProject(projectId);
      ctx.logActivity(projectId, "journey_withdrawn", "Journey withdrawn from the site");
    },

    releases(projectId: string, journeyId: string): Release[] {
      requireJourney(projectId, journeyId);
      return (db.prepare("select * from journey_releases where journey_id = ? and project_id = ? order by number desc").all(journeyId, projectId) as Row[]).map(toRelease);
    },

    // What the site plays at /journeys/<key>: the newest live release,
    // re-checked on the way out. null: nothing to play (use the fallback).
    live(projectId: string, key: string): { name: string; bundle: JourneyBundle | null; issues: BundleIssue[] } | null {
      const j = ctx.journeys().list(projectId).find((x) => x.journey.key === key);
      if (!j) return null;
      const r = db.prepare("select * from journey_releases where journey_id = ? and project_id = ? and withdrawn_at is null order by number desc limit 1").get(j.journey.id, projectId) as Row | undefined;
      if (!r) return { name: j.journey.name, bundle: null, issues: [{ level: "error", sceneId: null, message: "Not published" }] };
      const { bundle, issues } = checkBundle(JSON.parse(String(r.bundle)));
      return { name: j.journey.name, bundle, issues };
    },

    preview(projectId: string, key: string): { name: string; bundle: JourneyBundle | null; issues: BundleIssue[] } | null {
      const j = ctx.journeys().list(projectId).find((x) => x.journey.key === key);
      if (!j) return null;
      if (!j.approved) return { name: j.journey.name, bundle: null, issues: [{ level: "error", sceneId: null, message: "The journey has no approved version." }] };
      const { bundle, issues } = assemble(projectId, j.journey.id, "preview");
      return { name: j.journey.name, bundle, issues };
    },

    // Journeys to offer on conventional pages, by entry page.
    launchers(projectId: string, mode: Mode): { key: string; name: string; pageId: string; sectionId: string | null; poster: string | null }[] {
      return ctx
        .journeys()
        .list(projectId)
        .flatMap((j) => {
          const found = mode === "published" ? self.live(projectId, j.journey.key) : j.approved ? self.preview(projectId, j.journey.key) : null;
          const b = found?.bundle;
          if (!b?.entry) return [];
          const start = b.scenes.find((s) => s.id === b.startSceneId);
          return [{ key: j.journey.key, name: j.journey.name, pageId: b.entry.pageId, sectionId: b.entry.sectionId, poster: start?.poster?.src ?? null }];
        });
    },
  };
  return self;
}

export type ExperienceStore = ReturnType<typeof createExperienceStore>;

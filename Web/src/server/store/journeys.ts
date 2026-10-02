import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ClientBrief } from "@/domain/client-brief";
import { NO_TEXT_NEGATIVE, JourneyContent, type MediaRef } from "@/domain/journey";
import { JOURNEY_SPEC_SCHEMA, JourneySpec, SCENE_MANIFEST_SCHEMA, SceneManifest } from "@/domain/journey-contract";
import { sampleJourney, templateJourney } from "@/domain/journey-samples";
import { sceneOrder, validateJourney, type JourneyContext, type JourneyIssue } from "@/domain/journey-validate";
import type { Project } from "@/domain/project";
import { slugify } from "@/lib/slug";
import { transaction } from "./db";
import { issuesFrom, now, StoreError, type Row } from "./errors";

// WF-06 persistence. Journeys are versioned like brands: one editable draft,
// one approved, the rest superseded. Nothing here produces or needs video.

export type JourneyVersion = { id: string; version: number; status: "draft" | "approved" | "superseded"; content: JourneyContent; createdAt: string; updatedAt: string; approvedAt: string | null };
export type Journey = { id: string; projectId: string; key: string; name: string; createdAt: string; updatedAt: string };

type Context = {
  db: DatabaseSync;
  requireProject: (id: string) => Project;
  approvedBrief: (projectId: string) => ClientBrief | null;
  logActivity: (projectId: string, kind: string, summary: string) => void;
  touchProject: (projectId: string) => void;
  // Read from the other modules, so a journey is checked against what exists now.
  pages: (projectId: string) => { id: string; title: string; path: string; sections: { id: string }[] }[];
  assetIds: (projectId: string) => Set<string>;
  captures: (projectId: string) => Set<string>;
  brand: (projectId: string) => { id: string; version: number } | null;
};

const toJourney = (r: Row): Journey => ({ id: String(r.id), projectId: String(r.project_id), key: String(r.key), name: String(r.name), createdAt: String(r.created_at), updatedAt: String(r.updated_at) });
const toVersion = (r: Row): JourneyVersion => ({
  id: String(r.id),
  version: Number(r.version),
  status: r.status as JourneyVersion["status"],
  content: JourneyContent.parse(JSON.parse(String(r.content))),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  approvedAt: (r.approved_at as string | null) ?? null,
});

export function createJourneyStore(ctx: Context) {
  const { db } = ctx;

  const requireJourney = (projectId: string, journeyId: string): Journey => {
    ctx.requireProject(projectId);
    const r = db.prepare("select * from journeys where id = ? and project_id = ?").get(journeyId, projectId) as Row | undefined;
    if (!r) throw new StoreError("not_found", "Journey not found.");
    return toJourney(r);
  };
  const versions = (journeyId: string) => (db.prepare("select * from journey_versions where journey_id = ? order by version desc").all(journeyId) as Row[]).map(toVersion);

  const context = (projectId: string): JourneyContext => ({
    pages: ctx.pages(projectId).map((p) => ({ id: p.id, title: p.title, sectionIds: p.sections.map((s) => s.id) })),
    assetIds: ctx.assetIds(projectId),
    captures: ctx.captures(projectId),
    desiredActions: [...new Set(ctx.approvedBrief(projectId)?.content?.desiredActions.map((a) => a.kind) ?? [])],
  });

  const parse = (input: unknown): JourneyContent => {
    const r = JourneyContent.safeParse(input);
    if (!r.success) throw new StoreError("invalid", "Some values are not valid. Fix the highlighted fields.", issuesFrom(r.error));
    return r.data;
  };

  const resolveVersion = (projectId: string, journeyId: string, which: "approved" | "latest" | number) => {
    const journey = requireJourney(projectId, journeyId);
    const all = versions(journeyId);
    const v = which === "approved" ? all.find((x) => x.status === "approved") : which === "latest" ? all[0] : all.find((x) => x.version === which);
    if (!v) throw new StoreError("not_found", which === "approved" ? "No approved version yet." : "Version not found.");
    return { journey, version: v };
  };

  const header = (projectId: string, journey: Journey, v: JourneyVersion) => {
    const project = ctx.requireProject(projectId);
    return {
      generatedAt: now(),
      project: { id: project.id, slug: project.slug },
      journey: { id: journey.id, key: journey.key, name: journey.name },
      version: { number: v.version, status: v.status, approvedAt: v.approvedAt },
    };
  };

  const refUrl = (projectId: string, r: MediaRef | null) =>
    !r ? null : r.kind === "asset" ? { kind: "asset" as const, url: `/api/projects/${projectId}/assets/${r.assetId}/file` } : r.kind === "reference_capture" ? { kind: "reference_capture" as const, url: `/api/projects/${projectId}/references/${r.referenceId}/captures/${r.captureId}/file` } : { kind: "url" as const, url: r.url };

  const self = {
    context,
    validate: (projectId: string, content: JourneyContent): JourneyIssue[] => validateJourney(content, context(projectId)),

    list(projectId: string) {
      ctx.requireProject(projectId);
      return (db.prepare("select * from journeys where project_id = ? order by created_at").all(projectId) as Row[]).map((r) => {
        const journey = toJourney(r);
        const all = versions(journey.id);
        const issues = validateJourney(all[0].content, context(projectId));
        return { journey, latest: all[0], approved: all.find((v) => v.status === "approved") ?? null, errors: issues.filter((i) => i.level === "error").length };
      });
    },

    get(projectId: string, journeyId: string) {
      const journey = requireJourney(projectId, journeyId);
      const all = versions(journeyId);
      return { journey, versions: all, latest: all[0], approved: all.find((v) => v.status === "approved") ?? null };
    },

    // Starts from a template (structure, blanks to fill) or the complete sample.
    create(projectId: string, input: { name: unknown; start: unknown }): Journey {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 80) throw new StoreError("invalid", "Name the journey (up to 80 characters).", [{ path: "name", message: "Required" }]);
      const start = input.start === "linear" || input.start === "branching" || input.start === "sample" ? input.start : null;
      if (!start) throw new StoreError("invalid", "Choose how to start.", [{ path: "start", message: "Choose a starting point" }]);
      const brief = ctx.approvedBrief(projectId)?.content ?? null;
      const actions = [...new Set(brief?.desiredActions.map((a) => a.kind) ?? [])];
      const content =
        start === "sample"
          ? sampleJourney(actions[0] ?? "lead_form")
          : templateJourney(start, {
              objective: brief?.cinematic?.intent ?? "",
              audience: brief?.audiences.map((a) => a.name).join("; ").slice(0, 500) ?? "",
              aspectRatio: "16:9",
              targetRuntimeSeconds: brief?.cinematic?.targetRuntimeSeconds ?? 60,
              intendedActions: actions,
              conversion: null,
              conversionAction: actions[0] ?? null,
            });
      return transaction(db, () => {
        ctx.requireProject(projectId);
        const base = slugify(name, 40) || "journey";
        let key = base;
        for (let n = 2; db.prepare("select 1 from journeys where project_id = ? and key = ?").get(projectId, key); n++) key = `${base}-${n}`;
        const id = randomUUID();
        const at = now();
        db.prepare("insert into journeys (id, project_id, key, name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(id, projectId, key, name, at, at);
        db.prepare("insert into journey_versions (id, journey_id, version, status, content, created_at, updated_at, approved_at) values (?, ?, 1, 'draft', ?, ?, ?, null)").run(randomUUID(), id, JSON.stringify(parse(content)), at, at);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "journey_created", `Journey created: ${name} (${start})`);
        return requireJourney(projectId, id);
      });
    },

    saveDraft(projectId: string, journeyId: string, versionId: string, input: unknown): JourneyVersion {
      const content = parse(input);
      return transaction(db, () => {
        requireJourney(projectId, journeyId);
        const l = versions(journeyId)[0];
        if (l.id !== versionId || l.status !== "draft") throw new StoreError("conflict", "This journey changed since you opened it. Reload to see the current version.");
        db.prepare("update journey_versions set content = ?, updated_at = ? where id = ?").run(JSON.stringify(content), now(), versionId);
        db.prepare("update journeys set updated_at = ? where id = ?").run(now(), journeyId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "journey_saved", `Journey draft saved (v${l.version})`);
        return versions(journeyId)[0];
      });
    },

    approve(projectId: string, journeyId: string, versionId: string): JourneyVersion {
      return transaction(db, () => {
        requireJourney(projectId, journeyId);
        const l = versions(journeyId)[0];
        if (l.id !== versionId || l.status !== "draft") throw new StoreError("conflict", "This journey changed since you opened it. Reload to see the current version.");
        const errors = validateJourney(l.content, context(projectId)).filter((i) => i.level === "error");
        if (errors.length) throw new StoreError("invalid", `Not approved: ${errors.length} item(s) to fix.`, errors.map((e) => ({ path: e.path, message: e.message })));
        const at = now();
        db.prepare("update journey_versions set status = 'superseded', updated_at = ? where journey_id = ? and status = 'approved'").run(at, journeyId);
        db.prepare("update journey_versions set status = 'approved', approved_at = ?, updated_at = ? where id = ?").run(at, at, versionId);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "journey_approved", `Journey version ${l.version} approved`);
        return versions(journeyId)[0];
      });
    },

    revise(projectId: string, journeyId: string): JourneyVersion {
      return transaction(db, () => {
        requireJourney(projectId, journeyId);
        const l = versions(journeyId)[0];
        if (l.status === "draft") return l;
        const at = now();
        db.prepare("insert into journey_versions (id, journey_id, version, status, content, created_at, updated_at, approved_at) values (?, ?, ?, 'draft', ?, ?, ?, null)").run(randomUUID(), journeyId, l.version + 1, JSON.stringify(l.content), at, at);
        ctx.touchProject(projectId);
        ctx.logActivity(projectId, "journey_revision", `Journey version ${l.version + 1} opened`);
        return versions(journeyId)[0];
      });
    },

    // For WF-07: what to produce. Defaults to the approved version.
    sceneManifest(projectId: string, journeyId: string, which: "approved" | "latest" | number): SceneManifest {
      const { journey, version } = resolveVersion(projectId, journeyId, which);
      const j = version.content;
      const brand = ctx.brand(projectId);
      const { order } = sceneOrder(j);
      return SceneManifest.parse({
        schema: SCENE_MANIFEST_SCHEMA,
        ...header(projectId, journey, version),
        format: j.format,
        brand: brand ? { id: brand.id, version: brand.version, configPath: `/api/projects/${projectId}/brands/${brand.id}/config` } : null,
        textPolicy: "No text, captions, UI or logos may be generated into footage. All interface text is overlaid by WF-08.",
        scenes: order.map((s, i) => ({
          id: s.id,
          order: i,
          title: s.title,
          type: s.type,
          purpose: s.purpose,
          durationSeconds: s.durationSeconds,
          aspectRatio: s.aspectRatio,
          visual: s.visual,
          continuity: s.continuity,
          keyframes: s.keyframes.map((k) => ({ id: k.id, label: k.label, position: k.position, ref: refUrl(projectId, k.ref), notes: k.notes })),
          visualNotes: s.visualNotes,
          // The no-text instruction is always present, whatever the scene says.
          prompt: { positive: s.prompt.positive, negative: s.prompt.negative.includes(NO_TEXT_NEGATIVE) ? s.prompt.negative : [s.prompt.negative, NO_TEXT_NEGATIVE].filter(Boolean).join(", ") },
          assetSlots: s.assetSlots.map((a) => ({
            id: a.id,
            kind: a.kind,
            label: a.label,
            durationSeconds: a.durationSeconds,
            required: a.required,
            acceptance: { aspectRatio: s.aspectRatio, minDurationSeconds: a.kind === "audio" || a.kind === "still" ? null : (a.durationSeconds ?? s.durationSeconds), seamlessLoop: a.kind === "loop", noBurnedInText: true as const },
          })),
          overlays: [
            ...s.branches.map((b) => ({ kind: "choice" as const, label: b.label, placement: "choice", atSeconds: null })),
            ...s.ctas.map((c) => ({ kind: "cta" as const, label: c.label, placement: c.placement, atSeconds: c.appearsAtSeconds })),
          ],
        })),
        issues: validateJourney(j, context(projectId)),
      });
    },

    // For WF-08: how the journey plays.
    journeySpec(projectId: string, journeyId: string, which: "approved" | "latest" | number): JourneySpec {
      const { journey, version } = resolveVersion(projectId, journeyId, which);
      const j = version.content;
      const pages = ctx.pages(projectId);
      const pathOf = (pageId: string) => pages.find((p) => p.id === pageId)?.path ?? null;
      const { order } = sceneOrder(j);
      const ep = j.goals.entryPoint;
      const target = (t: (typeof j.scenes)[number]["ctas"][number]["target"]) =>
        t.kind === "url" ? { kind: "url" as const, pageId: null, sectionId: null, path: t.url } : { kind: t.kind, pageId: t.pageId, sectionId: t.kind === "section" ? t.sectionId : null, path: `${pathOf(t.pageId) ?? ""}${t.kind === "section" ? `#s-${t.sectionId}` : ""}` };
      const firstCta = j.scenes.find((s) => s.type === "conversion")?.ctas.find((c) => c.target.kind !== "url");
      const fallbackPath = ep.kind !== "standalone" ? pathOf(ep.pageId) : firstCta && firstCta.target.kind !== "url" ? pathOf(firstCta.target.pageId) : null;
      return JourneySpec.parse({
        schema: JOURNEY_SPEC_SCHEMA,
        ...header(projectId, journey, version),
        goals: { objective: j.goals.objective, audience: j.goals.audience, intendedActions: j.goals.intendedActions, successCriteria: j.goals.successCriteria },
        entryPoint: { kind: ep.kind, pageId: ep.kind === "standalone" ? null : ep.pageId, sectionId: ep.kind === "page_section" ? ep.sectionId : null, path: ep.kind === "standalone" ? null : pathOf(ep.pageId) },
        fallback: { path: fallbackPath, reason: "Shown when the journey cannot play: no JavaScript, data saver, or the visitor prefers not to watch. The conventional site must stand on its own." },
        startSceneId: j.startSceneId ?? "",
        scenes: order.map((s, i) => ({
          id: s.id,
          order: i,
          type: s.type,
          title: s.title,
          durationSeconds: s.durationSeconds,
          slotIds: s.assetSlots.map((a) => a.id),
          next: s.next,
          choice: s.type === "decision" ? { branches: s.branches, timeout: s.decisionTimeout } : null,
          ctas: s.ctas.map((c) => ({ id: c.id, label: c.label, actionKind: c.actionKind, target: target(c.target), placement: c.placement, appearsAtSeconds: c.appearsAtSeconds })),
        })),
        endingSceneIds: j.scenes.filter((s) => s.type === "ending").map((s) => s.id),
        conversionSceneIds: j.scenes.filter((s) => s.type === "conversion").map((s) => s.id),
        issues: validateJourney(j, context(projectId)),
      });
    },
  };
  return self;
}

export type JourneyStore = ReturnType<typeof createJourneyStore>;

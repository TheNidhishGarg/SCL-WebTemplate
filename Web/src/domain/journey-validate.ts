import { SCENE_TYPE_LABELS, TEXT_REQUEST, type JourneyContent, type MediaRef, type Scene } from "./journey";

// Structural and production checks for a journey plan. Errors block approval;
// warnings are reported. Pure: the editor runs it live, the server on approve
// and export.

export type JourneyIssue = { sceneId: string | null; path: string; level: "error" | "warning"; area: "structure" | "production" | "goals"; message: string };

export type JourneyContext = {
  pages: { id: string; title: string; sectionIds: string[] }[];
  assetIds: Set<string>;
  captures: Set<string>; // "<referenceId>:<captureId>"
  desiredActions: string[];
};

export const outgoing = (s: Scene): { id: string; to: string; label: string }[] =>
  s.type === "decision" ? s.branches.map((b) => ({ id: b.id, to: b.to, label: b.label })) : s.next ? [{ id: s.next.id, to: s.next.to, label: "next" }] : [];

// Breadth-first from the start scene: the playback order WF-07 and the
// storyboard use. Unreachable scenes follow at the end, in list order.
export function sceneOrder(j: JourneyContent): { order: Scene[]; depth: Map<string, number>; reachable: Set<string> } {
  const byId = new Map(j.scenes.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const order: Scene[] = [];
  const start = j.startSceneId ? byId.get(j.startSceneId) : undefined;
  if (start) {
    depth.set(start.id, 0);
    const queue = [start];
    while (queue.length) {
      const s = queue.shift()!;
      order.push(s);
      for (const o of outgoing(s)) {
        const t = byId.get(o.to);
        if (t && !depth.has(t.id)) {
          depth.set(t.id, depth.get(s.id)! + 1);
          queue.push(t);
        }
      }
    }
  }
  const reachable = new Set(order.map((s) => s.id));
  for (const s of j.scenes) if (!reachable.has(s.id)) order.push(s);
  return { order, depth, reachable };
}

// Scenes from which some path reaches a scene matching `goal`.
function canReach(j: JourneyContent, goal: (s: Scene) => boolean): Set<string> {
  const ok = new Set(j.scenes.filter(goal).map((s) => s.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of j.scenes) {
      if (!ok.has(s.id) && outgoing(s).some((o) => ok.has(o.to))) {
        ok.add(s.id);
        changed = true;
      }
    }
  }
  return ok;
}

const blank = (s: string) => s.trim() === "";

export function validateJourney(j: JourneyContent, ctx: JourneyContext): JourneyIssue[] {
  const issues: JourneyIssue[] = [];
  const add = (level: "error" | "warning", area: JourneyIssue["area"], path: string, message: string, sceneId: string | null = null) => issues.push({ sceneId, path, level, area, message });
  const byId = new Map(j.scenes.map((s) => [s.id, s]));
  const name = (s: Scene) => `"${s.title || SCENE_TYPE_LABELS[s.type]}"`;

  // ---- goals
  if (blank(j.goals.objective)) add("error", "goals", "goals.objective", "State the journey's objective");
  if (blank(j.goals.audience)) add("error", "goals", "goals.audience", "Name the target audience");
  if (j.goals.intendedActions.length === 0) add("error", "goals", "goals.intendedActions", "Choose at least one intended visitor action");
  if (j.goals.successCriteria.length === 0) add("error", "goals", "goals.successCriteria", "Add at least one success criterion");
  j.goals.successCriteria.forEach((c, i) => (blank(c.metric) || blank(c.target)) && add("error", "goals", `goals.successCriteria.${i}`, `Success criterion ${i + 1} needs a metric and a target`));
  const ep = j.goals.entryPoint;
  if (ep.kind !== "standalone") {
    const page = ctx.pages.find((p) => p.id === ep.pageId);
    if (!page) add("error", "goals", "goals.entryPoint", "The entry page no longer exists (WF-05)");
    else if (ep.kind === "page_section" && !page.sectionIds.includes(ep.sectionId)) add("error", "goals", "goals.entryPoint", `The entry section no longer exists on "${page.title}"`);
  }
  for (const a of j.goals.intendedActions) if (!ctx.desiredActions.includes(a)) add("warning", "goals", "goals.intendedActions", `"${a}" is not a desired action in the approved brief`);

  // ---- structure
  if (j.scenes.length === 0) {
    add("error", "structure", "scenes", "Missing scenes: the journey has none");
    return issues;
  }
  const openings = j.scenes.filter((s) => s.type === "opening");
  if (openings.length === 0) add("error", "structure", "scenes", "Missing scene: add an opening scene");
  if (openings.length > 1) add("error", "structure", "scenes", `Only one opening scene is allowed; there are ${openings.length}`);
  if (!j.scenes.some((s) => s.type === "ending")) add("error", "structure", "scenes", "Missing scene: add at least one ending scene");
  const start = j.startSceneId ? byId.get(j.startSceneId) : undefined;
  if (!start) add("error", "structure", "startSceneId", "Choose the start scene");
  else if (start.type !== "opening") add("error", "structure", "startSceneId", `The journey must start on the opening scene, not ${name(start)}`);

  for (const s of j.scenes) {
    const at = `scenes.${s.id}`;
    if (s.type === "decision") {
      if (s.next) add("error", "structure", `${at}.next`, `${name(s)} is a decision: it continues through its branches, not a single next scene`, s.id);
      if (s.branches.length < 2) add("error", "structure", `${at}.branches`, `${name(s)} needs at least two branches`, s.id);
      const targets = s.branches.map((b) => b.to);
      if (new Set(targets).size < targets.length) add("warning", "structure", `${at}.branches`, `Two branches of ${name(s)} lead to the same scene`, s.id);
      s.branches.forEach((b, i) => blank(b.label) && add("error", "structure", `${at}.branches.${i}.label`, `Branch ${i + 1} of ${name(s)} needs a label for its on-screen choice`, s.id));
      if (s.decisionTimeout && !s.branches.some((b) => b.id === s.decisionTimeout!.defaultBranchId)) add("error", "structure", `${at}.decisionTimeout`, `The timeout of ${name(s)} defaults to a branch that does not exist`, s.id);
    } else {
      if (s.branches.length) add("error", "structure", `${at}.branches`, `Only decision scenes have branches; ${name(s)} is ${SCENE_TYPE_LABELS[s.type].toLowerCase()}`, s.id);
      if (s.type === "ending" && s.next) add("error", "structure", `${at}.next`, `${name(s)} is an ending: it cannot continue`, s.id);
      if (s.type !== "ending" && !s.next) add("error", "structure", `${at}.next`, `${name(s)} goes nowhere: give it a next scene or make it an ending`, s.id);
    }
    for (const o of outgoing(s)) {
      const t = byId.get(o.to);
      if (!t) add("error", "structure", `${at}.transitions`, `Invalid transition: ${name(s)} leads to a scene that does not exist`, s.id);
      else if (t.id === s.id) add("error", "structure", `${at}.transitions`, `Invalid transition: ${name(s)} leads to itself`, s.id);
      else if (t.type === "opening") add("error", "structure", `${at}.transitions`, `Invalid transition: ${name(s)} leads back to the opening scene`, s.id);
    }
    if (s.type === "conversion" && s.ctas.length === 0) add("error", "structure", `${at}.ctas`, `Conversion scene ${name(s)} needs at least one call to action`, s.id);
    s.ctas.forEach((c, i) => {
      if (blank(c.label)) add("error", "structure", `${at}.ctas.${i}.label`, `CTA ${i + 1} of ${name(s)} needs a label`, s.id);
      if (c.target.kind !== "url") {
        const t = c.target;
        const page = ctx.pages.find((p) => p.id === t.pageId);
        if (!page) add("error", "structure", `${at}.ctas.${i}.target`, `CTA "${c.label}" links to a page that no longer exists (WF-05)`, s.id);
        else if (t.kind === "section" && !page.sectionIds.includes(t.sectionId)) add("error", "structure", `${at}.ctas.${i}.target`, `CTA "${c.label}" links to a section that no longer exists`, s.id);
      }
      if (c.appearsAtSeconds > s.durationSeconds) add("warning", "structure", `${at}.ctas.${i}.appearsAtSeconds`, `CTA "${c.label}" appears after ${name(s)} has ended`, s.id);
      if (c.actionKind && !ctx.desiredActions.includes(c.actionKind)) add("warning", "structure", `${at}.ctas.${i}.actionKind`, `"${c.actionKind}" is not a desired action in the brief`, s.id);
    });
  }

  const { reachable } = sceneOrder(j);
  if (start) for (const s of j.scenes) if (!reachable.has(s.id)) add("error", "structure", `scenes.${s.id}`, `Unreachable: no path from the opening leads to ${name(s)}`, s.id);

  const toEnding = canReach(j, (s) => s.type === "ending");
  for (const s of j.scenes) if (reachable.has(s.id) && !toEnding.has(s.id)) add("error", "structure", `scenes.${s.id}`, `${name(s)} can never reach an ending (a loop with no way out)`, s.id);

  const toConversion = canReach(j, (s) => s.type === "conversion");
  if (start && !toConversion.has(start.id)) add("error", "structure", "scenes", "Missing conversion path: no path from the opening reaches a conversion scene");
  for (const s of j.scenes) {
    if (s.type !== "decision" || !reachable.has(s.id)) continue;
    s.branches.forEach((b, i) => {
      if (byId.has(b.to) && !toConversion.has(b.to)) add("warning", "structure", `scenes.${s.id}.branches.${i}`, `Branch "${b.label || i + 1}" of ${name(s)} never reaches a conversion scene`, s.id);
    });
  }

  // ---- production: everything WF-07 needs, per scene
  const checkRef = (r: MediaRef | null, path: string, sceneId: string) => {
    if (!r) return;
    if (r.kind === "asset" && !ctx.assetIds.has(r.assetId)) add("error", "production", path, "Keyframe refers to an asset not in this project's register", sceneId);
    if (r.kind === "reference_capture" && !ctx.captures.has(`${r.referenceId}:${r.captureId}`)) add("error", "production", path, "Keyframe refers to a WF-02 capture that does not exist in this project", sceneId);
  };
  for (const s of j.scenes) {
    const at = `scenes.${s.id}`;
    const need = (v: string, field: string, label: string) => blank(v) && add("error", "production", `${at}.${field}`, `${name(s)}: ${label} is missing`, s.id);
    need(s.title, "title", "title");
    need(s.purpose, "purpose", "narrative purpose");
    need(s.visual.description, "visual.description", "visual description");
    need(s.visual.subject, "visual.subject", "subject");
    need(s.visual.environment, "visual.environment", "environment");
    need(s.visual.lighting, "visual.lighting", "lighting");
    need(s.visual.mood, "visual.mood", "mood");
    need(s.prompt.positive, "prompt.positive", "generation prompt");
    if (!s.assetSlots.some((a) => (a.kind === "video" || a.kind === "loop") && a.required)) add("error", "production", `${at}.assetSlots`, `${name(s)}: needs a required video or loop asset slot`, s.id);
    s.assetSlots.forEach((a, i) => blank(a.label) && add("error", "production", `${at}.assetSlots.${i}.label`, `${name(s)}: asset slot ${i + 1} needs a label`, s.id));
    if (s.type === "decision" && !s.assetSlots.some((a) => a.kind === "loop")) add("warning", "production", `${at}.assetSlots`, `${name(s)}: a decision usually needs a loop to play while the visitor chooses`, s.id);
    if (needsKeyframe(s) && s.keyframes.length === 0) add("warning", "production", `${at}.keyframes`, `${name(s)}: no keyframe reference yet`, s.id);
    s.keyframes.forEach((k, n) => checkRef(k.ref, `${at}.keyframes.${n}.ref`, s.id));
    for (const m of s.continuity.matchesSceneIds) if (!byId.has(m)) add("error", "production", `${at}.continuity`, `${name(s)}: continuity refers to a scene that no longer exists`, s.id);
    const textAsk = TEXT_REQUEST.exec(s.prompt.positive);
    if (textAsk) add("warning", "production", `${at}.prompt.positive`, `${name(s)}: the prompt mentions "${textAsk[0]}". Interface text is overlaid by the site, never generated into footage.`, s.id);
  }

  // Runtime along the shortest path from the opening to an ending.
  if (start) {
    const best = new Map<string, number>([[start.id, start.durationSeconds]]);
    const queue = [start];
    let shortest = Infinity;
    while (queue.length) {
      const s = queue.shift()!;
      const d = best.get(s.id)!;
      if (s.type === "ending") shortest = Math.min(shortest, d);
      for (const o of outgoing(s)) {
        const t = byId.get(o.to);
        if (t && !best.has(t.id)) {
          best.set(t.id, d + t.durationSeconds);
          queue.push(t);
        }
      }
    }
    const target = j.format.targetRuntimeSeconds;
    if (Number.isFinite(shortest) && Math.abs(shortest - target) / target > 0.25) {
      add("warning", "goals", "format.targetRuntimeSeconds", `The shortest path runs ${Math.round(shortest)}s against a ${target}s target`);
    }
  }
  return issues;
}

// Short transitions are often abstract; every other scene should have a visual reference.
const needsKeyframe = (s: Scene) => s.type !== "transition";

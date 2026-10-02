import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { compose, initCompositions } from "./composition";
import { flattenItems, itemId, listFiles, pageIds, readComposition, readJson, readPage, type Composition, type Item, type SectionDef } from "./model";
import { readOverrides, writeOverrides, type OpContext, type Recorded } from "./operations";
import { coverage, inventoryOf, loadInventory, sectionLabel, sourceEdits, type Coverage, type SectionReport, type SourceEdits, type Status } from "./reports";
import { normalizeTokens, readTokenMap, type TokenBinding, type TokenInfo } from "./tokens";
import type { Verification } from "./verify";

// Web's processing of a generated website template (deterministic, no
// models): composition, design-token provenance, explicit overrides,
// page/section status, reports, verification and export. It works on the
// generator's output (template sources, inventories, raw capture) and never
// re-captures or re-segments a site.

export { applyOperation, OperationSchema, replayOperations, type Operation, type Recorded } from "./operations";
export { verifyTemplate, missingAssets, type Verification } from "./verify";
export { STATUS_LABEL, type Status } from "./reports";

const COMPOSE_SCRIPT = () => join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "template-compose.mjs");

/** First processing of a freshly extracted template (also used when reprocessing). */
export function processTemplate(t: string, captureDir: string) {
  copyFileSync(COMPOSE_SCRIPT(), join(t, "compose.mjs"));
  const tokens = normalizeTokens(t, existsSync(captureDir) ? captureDir : null);
  const created = initCompositions(t);
  if (!existsSync(join(t, "overrides.json"))) writeOverrides(t, { version: 1, note: "", operations: [] });
  compose(t);
  return { bindings: tokens.bindings.length, compositions: created.length };
}

export function opContext(t: string, captureDir: string): OpContext {
  const inv = loadInventory(captureDir);
  let defs: Map<string, SectionDef> | null = null;
  return {
    dependencies: (s) => {
      defs ??= new Map(pageIds(t).flatMap((id) => readPage(t, id).sections.map((x) => [x.id, x] as const)));
      return inventoryOf(inv, defs, s)?.interactionDependencies ?? [];
    },
  };
}

// --------------------------------------------------------------- the view

export type ViewItem = { id: string; kind: "section" | "group" | "frame"; label: string; type: string; status: Status | null; reasons: string[]; notes: string[]; members?: ViewItem[]; region?: string };
export type ViewRegion = { id: string; parent: string; nestedIn: string | null; items: ViewItem[] };
export type StructureView = {
  version: string;
  pages: { pageId: string; route: string; composable: boolean; regions: ViewRegion[]; removed: (ViewItem & { reason: string; selector?: string })[] }[];
  library: { page: string; section: string; label: string }[];
  operations: (Recorded & { index: number })[];
  tokens: { tokens: TokenInfo[]; bindings: TokenBinding[]; total: number; inline: number; unaligned: string[] };
  coverage: Coverage;
  sourceEdits: SourceEdits;
  verification: Verification | null;
};

export function structureView(t: string, captureDir: string, reportsDir: string): StructureView {
  const verification = existsSync(join(reportsDir, "verification.json")) ? readJson<Verification>(join(reportsDir, "verification.json")) : null;
  const cov = coverage(t, captureDir, verification);
  const bySection = new Map<string, SectionReport>(cov.sections.map((s) => [s.id, s]));
  const pages = pageIds(t).map((pageId) => {
    const p = readPage(t, pageId);
    const defs = new Map(p.sections.map((s) => [s.id, s]));
    const c = readComposition(t, pageId);
    const view = (i: Item): ViewItem => {
      const id = itemId(i);
      if ("group" in i) return { id, kind: "group", label: `Merged: ${i.items.length} sections`, type: "group", status: null, reasons: [], notes: [], members: i.items.map(view) };
      const s = defs.get(id);
      const rep = bySection.get(id);
      return { id, kind: "section" in i ? "section" : "frame", label: s ? sectionLabel(t, pageId, s) : id, type: s?.type ?? "unknown", status: rep?.status ?? null, reasons: rep?.reasons ?? [], notes: rep?.notes ?? [], ...("frame" in i ? { region: i.region } : {}) };
    };
    const regions: ViewRegion[] = [];
    if (c) {
      const nestedIn = new Map<string, string>();
      for (const r of Object.values(c.regions)) for (const i of r.items) if ("frame" in i) nestedIn.set(i.region, i.frame);
      const order = orderRegions(c, t, pageId);
      for (const rid of order) regions.push({ id: rid, parent: c.regions[rid].parent, nestedIn: nestedIn.get(rid) ?? null, items: c.regions[rid].items.map(view) });
    }
    return {
      pageId,
      route: p.route,
      composable: !!c,
      regions,
      removed: (c?.removed ?? []).map((r) => ({ ...view(r.item), reason: r.reason, ...(r.selector ? { selector: r.selector } : {}) })),
    };
  });
  const library = pageIds(t).flatMap((pageId) => {
    const p = readPage(t, pageId);
    const c = readComposition(t, pageId);
    const placed = new Set(c ? Object.values(c.regions).flatMap((r) => flattenItems(c, r.items)) : p.sections.map((s) => s.id));
    const frames = new Set(c ? Object.values(c.regions).flatMap((r) => r.items.flatMap((i) => ("frame" in i ? [i.frame] : []))) : []);
    return p.sections.filter((s) => placed.has(s.id) && !frames.has(s.id)).map((s) => ({ page: pageId, section: s.id, label: sectionLabel(t, pageId, s) }));
  });
  const ops = readOverrides(t).operations.map((o, index) => ({ ...o, index }));
  const map = readTokenMap(t);
  return {
    version: `${ops.length}:${ops.at(-1)?.at ?? ""}:${verification?.at ?? ""}`,
    pages,
    library,
    operations: ops,
    tokens: { tokens: map?.tokens ?? [], bindings: (map?.bindings ?? []).slice(0, 400), total: map?.bindings.length ?? 0, inline: map?.inline.reduce((a, b) => a + b.occurrences, 0) ?? 0, unaligned: map?.unaligned ?? [] },
    coverage: cov,
    sourceEdits: sourceEdits(t),
    verification,
  };
}

/** Regions in page order: each root region, followed by the regions nested in it. */
function orderRegions(c: Composition, t: string, pageId: string): string[] {
  const sk = join(t, "composition", "skeletons", `${pageId}.html`);
  const roots = existsSync(sk) ? [...readFileSync(sk, "utf8").matchAll(/\{\{@region\s+([A-Za-z0-9_-]+)\s*\}\}/g)].map((m) => m[1]) : Object.keys(c.regions);
  const out: string[] = [];
  const visit = (rid: string) => {
    if (out.includes(rid) || !c.regions[rid]) return;
    out.push(rid);
    for (const i of c.regions[rid].items) if ("frame" in i) visit(i.region);
  };
  roots.forEach(visit);
  for (const rid of Object.keys(c.regions)) if (!out.includes(rid) && !c.removed.some((r) => "frame" in r.item && r.item.region === rid)) visit(rid);
  return out;
}

// ------------------------------------------------------------------ export

const STORE_ONLY = /\.(png|jpe?g|gif|webp|avif|woff2?|mp4|webm|zip|gz)$/i;
const safeEntry = (p: string) => !!p && !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\");

/**
 * The deliverable: the generated ZIP's raw capture, manifests and reports,
 * with the edited template (sources, composition, overrides, tokens) and
 * Web's reports in place of the original template folder.
 */
export function buildExport(t: string, captureDir: string, reportsDir: string, original: Uint8Array): Uint8Array {
  compose(t);
  const view = structureView(t, captureDir, reportsDir);
  const files: Zippable = {};
  const entries = unzipSync(original, { filter: (f) => !f.name.endsWith("/") });
  const root = Object.keys(entries)[0]?.split("/")[0] ?? "website-template";
  const hasRoot = Object.keys(entries).every((n) => n.startsWith(`${root}/`));
  const prefix = hasRoot ? root : "website-template";
  for (const [name, bytes] of Object.entries(entries)) {
    const rel = hasRoot ? name.slice(root.length + 1) : name;
    if (!safeEntry(rel) || rel === "template" || rel.startsWith("template/")) continue;
    files[`${prefix}/${rel}`] = [bytes, { level: STORE_ONLY.test(rel) ? 0 : 6 }];
  }
  for (const rel of listFiles(t)) {
    if (/^(dist|node_modules)\//.test(rel) || rel.endsWith(".tmp")) continue;
    files[`${prefix}/template/${rel}`] = [readFileSync(join(t, rel)), { level: STORE_ONLY.test(rel) ? 0 : 6 }];
  }
  files[`${prefix}/reports/coverage.json`] = strToU8(JSON.stringify(view.coverage, null, 2));
  files[`${prefix}/reports/source-edits.json`] = strToU8(JSON.stringify(view.sourceEdits, null, 2));
  if (view.verification) files[`${prefix}/reports/verification.json`] = strToU8(JSON.stringify(view.verification, null, 2));
  files[`${prefix}/EDITING.md`] = strToU8(editingGuide(view));
  return zipSync(files);
}

function editingGuide(v: StructureView): string {
  const s = v.coverage.summary;
  const line = (r: Record<Status, number>) => `${r.processed} processed, ${r.processed_with_limitations} with limitations, ${r.requires_manual_work} requiring manual work, ${r.inaccessible} inaccessible`;
  const interactions = v.coverage.sections.filter((x) => x.included && x.reasons.some((r) => r.startsWith("Interactions:") || r.startsWith("Unsupported")));
  return `# Editing this website template

Made by SCL Web from a capture of the reference site. Everything here is plain
HTML, CSS, JSON and a small build script: no model or AI service is needed to
edit or build it.

Pages: ${line(s.pages)}.
Sections: ${line(s.sections)}.
Details: reports/coverage.json.

## Build and preview

    cd template
    node compose.mjs      # only after editing composition/ (writes layouts/)
    node build.mjs        # writes dist/
    node serve.mjs        # serves dist/ locally

## What to edit where

| To change | Edit |
| --- | --- |
| Text and links | content/pages/<page>.json, content/shared.json (shared header, navigation, footer) |
| Brand colours, fonts, name | site.config.json. Colours and fonts are CSS variables (--sar-color-*, --sar-font-*) |
| Which sections a page shows, and their order | composition/<page>.json, then node compose.mjs |
| Section markup | components/pages/<page>/<section>.html, components/shared/*.html |
| Page markup around the sections | composition/skeletons/<page>.html (layouts/ is generated from it) |
| Stylesheets | assets/ (processed copies; the captured originals are in raw-capture/) |

## Composition

composition/<page>.json lists the page's regions. A region is a run of
sections that were siblings in one wrapper element; its "items" are rendered
in order. Reorder items within a region, delete an item to remove a section,
or copy an item to show a section twice (give the copy its own component if
its ids must differ). Moving a section to another region would change the
surrounding markup, so do that in the skeleton instead.

## Overrides

overrides.json records the explicit overrides made in SCL Web, in order:
split, merge, exclude (by selector), duplicate, insert, remove, restore,
move, and token detach/attach/set. They are already applied to these files;
the list is the record of what was changed and why.

Selectors support: tag, *, #id, .class, [attr], [attr=value] (also ~= ^= $= *=),
descendant and child (>) combinators, and comma-separated lists.

## Design tokens

tokens/token-map.json lists every declaration that uses a design token, with
the captured declaration it came from. Each var() has the captured value as
its fallback. A declaration can be detached from its token (it keeps its
captured value) without affecting other uses of the same colour.

reports/source-edits.json lists values that are not tokens or content and
need a direct edit: hard-coded colours and fonts, text written into the
markup, image references and scripts.

## Interactions and limits

Captured scripts are kept as they were. Forms are disconnected until an
endpoint is configured in site.config.json (integrations.forms); analytics
and other outside calls are blocked by the runtime guard.

${interactions.length ? `Sections with interactions or unsupported content:\n\n${interactions.map((x) => `- ${x.id}: ${x.reasons.filter((r) => r.startsWith("Interactions:") || r.startsWith("Unsupported")).join(" ")}`).join("\n")}\n` : "No sections with recorded interactions or unsupported content.\n"}
This is a reconstruction from what the browser received. It is not a
pixel-perfect copy, does not include any backend, and is not the original
source code.
`;
}

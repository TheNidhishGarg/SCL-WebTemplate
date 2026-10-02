import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { elementsOf, isElement, parseMarkup, type El } from "./markup";
import { componentFile, flattenItems, getPath, itemId, listFiles, pageIds, readComposition, readJson, readPage, sectionScope, type Composition, type Item, type PageDef, type SectionDef } from "./model";
import type { Verification } from "./verify";

// Status of every page and section, and what still needs direct edits.
//
// Every page and section gets one of four states:
//   processed                   templatised, verified, nothing known missing
//   processed_with_limitations  usable, with known gaps (listed)
//   requires_manual_work        not templatised, missing in the output, or failing checks
//   inaccessible                not captured (failed, blocked, skipped, limits)
// The inputs are the generator's inventories and verification (made when the
// template was generated) plus Web's own checks of the current template.

export type Status = "processed" | "processed_with_limitations" | "requires_manual_work" | "inaccessible";
export const STATUS_LABEL: Record<Status, string> = {
  processed: "Processed",
  processed_with_limitations: "Processed with limitations",
  requires_manual_work: "Requires manual work",
  inaccessible: "Inaccessible",
};

type InvSection = {
  sectionId: string;
  page: string;
  type: string;
  classification?: string[];
  sourceSelector?: string;
  interactionDependencies?: string[];
  unsupported?: unknown[];
  notes?: unknown[];
  processingStatus?: string;
  verificationStatus?: string;
  configEditVerified?: boolean;
};
type InvPage = {
  id: string;
  requestedUrl?: string;
  finalUrl?: string;
  route?: string;
  captureStatus?: string;
  templateStatus?: string | null;
  reason?: string | null;
  httpStatus?: number | null;
  aliasOf?: string | null;
  warnings?: unknown[];
  screenshots?: Record<string, { truncated?: boolean }>;
};
type PageInventory = { pages?: InvPage[]; skippedUrls?: unknown[]; limits?: { reached?: string[]; remainingUrls?: string[]; discoveryComplete?: boolean }; discovery?: { complete?: boolean; notes?: string[] } };
type SarCheck = { passed?: boolean; [k: string]: unknown };
type SarVerification = { checks?: { pages?: { page: string; checks: Record<string, SarCheck> }[] } };

export type SectionReport = { id: string; page: string; type: string; kind: "section" | "frame"; origin: string; included: boolean; sourceSelector: string | null; status: Status; reasons: string[]; notes: string[] };
export type PageReport = { id: string | null; url: string; route: string | null; status: Status; reasons: string[]; notes: string[] };
export type Coverage = {
  generatedAt: string;
  pages: PageReport[];
  sections: SectionReport[];
  summary: { pages: Record<Status, number>; sections: Record<Status, number> };
  discovery: { complete: boolean | null; limitsReached: string[]; remainingUrls: number; notes: string[] };
  sources: string[];
};

const text = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? String((v as { reason?: string; message?: string; kind?: string }).reason ?? (v as { message?: string }).message ?? (v as { kind?: string }).kind ?? JSON.stringify(v)) : String(v));
const readOpt = <T>(file: string): T | null => {
  try {
    return existsSync(file) ? readJson<T>(file) : null;
  } catch {
    return null;
  }
};
const worst = (a: Status, b: Status): Status => {
  const rank: Status[] = ["processed", "processed_with_limitations", "requires_manual_work", "inaccessible"];
  return rank[Math.max(rank.indexOf(a), rank.indexOf(b))];
};
const zero = (): Record<Status, number> => ({ processed: 0, processed_with_limitations: 0, requires_manual_work: 0, inaccessible: 0 });

export function loadInventory(captureDir: string) {
  const sections = readOpt<{ sections?: InvSection[] }>(join(captureDir, "section-inventory.json"))?.sections ?? [];
  return {
    sections: new Map(sections.map((s) => [s.sectionId, s])),
    pages: readOpt<PageInventory>(join(captureDir, "page-inventory.json")),
    verification: readOpt<SarVerification>(join(captureDir, "verification-report.json")),
  };
}
export type Inventory = ReturnType<typeof loadInventory>;

/** The captured inventory record of a section, following copies back to their original. */
export function inventoryOf(inv: Inventory, defs: Map<string, SectionDef>, s: SectionDef): InvSection | null {
  let cur: SectionDef | undefined = s;
  for (let i = 0; cur && i < 20; i++) {
    const rec = inv.sections.get(cur.id);
    if (rec) return rec;
    cur = cur.derivedFrom ? defs.get(cur.derivedFrom) : undefined;
  }
  return null;
}

function sectionReport(t: string, inv: Inventory, defs: Map<string, SectionDef>, p: PageDef, s: SectionDef, kind: "section" | "frame", included: boolean, web: Verification["pages"][number] | undefined): SectionReport {
  const reasons: { s: Status; r: string }[] = [];
  const notes: string[] = [];
  const rec = inventoryOf(inv, defs, s);
  if (s.derivedFrom) notes.push(s.origin === "split" ? `Part of ${s.derivedFrom}, split by an override.` : `Copy of ${s.derivedFrom} (${s.origin}).`);
  if (kind === "frame") notes.push("Split by an override: this is the wrapper kept around its parts.");
  if (!included) notes.push("Not on the page (removed or excluded).");
  if (!rec) reasons.push({ s: "processed_with_limitations", r: "No generator inventory record: status from Web's checks only." });
  else {
    if (rec.processingStatus && rec.processingStatus !== "templatised") reasons.push({ s: "requires_manual_work", r: `Not templatised by the generator (${rec.processingStatus})${rec.unsupported?.length ? `: ${rec.unsupported.map(text).join("; ")}` : ""}.` });
    else if (rec.unsupported?.length) reasons.push({ s: "processed_with_limitations", r: `Unsupported content: ${rec.unsupported.map(text).join("; ")}.` });
    if (rec.verificationStatus === "missing_in_output") reasons.push({ s: "requires_manual_work", r: "Missing from the generated output when it was verified." });
    if (rec.verificationStatus === "rendered_hidden") reasons.push({ s: "processed_with_limitations", r: "Hidden when rendered (e.g. a closed menu, tab or dialog)." });
    if (rec.configEditVerified === false) reasons.push({ s: "requires_manual_work", r: "A configuration change was not visible in this section when it was verified." });
    if (rec.interactionDependencies?.length) reasons.push({ s: "processed_with_limitations", r: `Interactions: ${rec.interactionDependencies.join("; ")}.` });
    if (rec.type === "content" && kind === "section" && !s.derivedFrom) reasons.push({ s: "processed_with_limitations", r: "Uncertain classification (no rule matched): check its boundaries; split, merge or exclude it with an override if needed." });
    for (const n of rec.notes ?? []) notes.push(text(n));
  }
  if (kind === "section" && !existsSync(componentFile(t, s.component))) reasons.push({ s: "requires_manual_work", r: `Its component (components/${s.component}.html) is missing.` });
  if (web && included) {
    if (!web.sections.rendered.includes(s.id)) reasons.push({ s: "requires_manual_work", r: "Not found in the built page (Web check)." });
    const missing = web.content.missing.filter((m) => m.section === s.id);
    if (missing.length) reasons.push({ s: "processed_with_limitations", r: `Content not visible in the built page: ${missing.map((m) => m.field).join(", ")}.` });
  }
  const status = reasons.reduce<Status>((acc, x) => worst(acc, x.s), "processed");
  return { id: s.id, page: p.id, type: s.type, kind, origin: s.origin ?? "captured", included, sourceSelector: rec?.sourceSelector ?? null, status, reasons: reasons.map((x) => x.r), notes };
}

export function coverage(t: string, captureDir: string, web: Verification | null): Coverage {
  const inv = loadInventory(captureDir);
  const pages: PageReport[] = [];
  const sections: SectionReport[] = [];
  const invPages = new Map((inv.pages?.pages ?? []).map((p) => [p.id, p]));
  const sarChecks = new Map((inv.verification?.checks?.pages ?? []).map((p) => [p.page, p.checks]));
  const ids = pageIds(t);

  for (const id of ids) {
    const p = readPage(t, id);
    const defs = new Map(p.sections.map((s) => [s.id, s]));
    const c = readComposition(t, id);
    const webPage = web?.pages.find((x) => x.page === id);
    // Sections: those placed on the page (in order), then removed/excluded ones, then unplaced definitions.
    const placed: { id: string; kind: "section" | "frame" }[] = [];
    if (c) {
      const walk = (items: Item[]) => {
        for (const i of items) {
          if ("section" in i) placed.push({ id: i.section, kind: "section" });
          else if ("group" in i) walk(i.items);
          else {
            placed.push({ id: i.frame, kind: "frame" });
            walk(c.regions[i.region]?.items ?? []);
          }
        }
      };
      for (const r of rootOrder(c, t, id)) walk(c.regions[r]?.items ?? []);
    } else for (const s of p.sections) placed.push({ id: s.id, kind: "section" });
    const removed = c ? c.removed.flatMap((r) => flattenItems(c, [r.item])) : [];
    const seen = new Set<string>();
    const pageSections: SectionReport[] = [];
    for (const x of placed) {
      const s = defs.get(x.id);
      if (!s || seen.has(x.id)) continue;
      seen.add(x.id);
      pageSections.push(sectionReport(t, inv, defs, p, s, x.kind, true, webPage));
    }
    for (const rid of removed) {
      const s = defs.get(rid);
      if (s && !seen.has(rid)) {
        seen.add(rid);
        pageSections.push(sectionReport(t, inv, defs, p, s, "section", false, undefined));
      }
    }
    // Sections the generator found on this page but did not put in the template.
    for (const rec of inv.sections.values()) {
      if (rec.page !== id || seen.has(rec.sectionId)) continue;
      const reasons = [`Found on the captured page but not in the template${rec.processingStatus ? ` (${rec.processingStatus}${rec.unsupported?.length ? `): ${rec.unsupported.map(text).join("; ")}` : ")"}` : ""}.`];
      if (rec.verificationStatus === "missing_in_output") reasons.push("Missing from the generated output when it was verified.");
      pageSections.push({ id: rec.sectionId, page: id, type: rec.type, kind: "section", origin: "captured", included: true, sourceSelector: rec.sourceSelector ?? null, status: "requires_manual_work", reasons, notes: [] });
    }
    sections.push(...pageSections);

    const rec = invPages.get(id);
    const reasons: { s: Status; r: string }[] = [];
    const notes: string[] = [];
    if (rec?.templateStatus && rec.templateStatus !== "templatised") reasons.push({ s: "requires_manual_work", r: `Not templatised (${rec.templateStatus}).` });
    for (const w of rec?.warnings ?? []) reasons.push({ s: "processed_with_limitations", r: `Capture warning: ${text(w)}` });
    for (const [vp, shot] of Object.entries(rec?.screenshots ?? {})) if (shot?.truncated) reasons.push({ s: "processed_with_limitations", r: `The ${vp} screenshot of the capture was cut off (very long page).` });
    const sar = sarChecks.get(id);
    if (sar) {
      for (const [name, check] of Object.entries(sar)) {
        if (name.endsWith("Rendering")) {
          const ratio = Number(check.mismatchRatio ?? 0);
          if (check.compared && ratio > 0.05) reasons.push({ s: "processed_with_limitations", r: `At generation, the ${name.replace("Rendering", "")} rendering differed from the capture in ${(ratio * 100).toFixed(1)}% of pixels (a comparison, not a pixel-perfect claim).` });
        } else if (check.passed === false) reasons.push({ s: "processed_with_limitations", r: `Generation check "${name}" failed${sarDetail(check)}.` });
      }
    } else if (inv.verification) notes.push("Not verified when the template was generated.");
    if (webPage) {
      if (!webPage.load) reasons.push({ s: "requires_manual_work", r: "The built page is missing (Web check)." });
      if (webPage.missingAssets.length) reasons.push({ s: "processed_with_limitations", r: `${webPage.missingAssets.length} missing asset(s), e.g. ${webPage.missingAssets[0].ref}.` });
      if (webPage.brokenLinks.length) reasons.push({ s: "processed_with_limitations", r: `${webPage.brokenLinks.length} broken internal link(s), e.g. ${webPage.brokenLinks[0].ref}.` });
      if (webPage.duplicateIds.length) reasons.push({ s: "processed_with_limitations", r: `Duplicate ids: ${webPage.duplicateIds.slice(0, 5).join(", ")}.` });
      if (!webPage.sections.passed) reasons.push({ s: "requires_manual_work", r: "The built page's sections do not match its composition (Web check)." });
      if (webPage.external.length) notes.push(`${webPage.external.length} reference(s) to other sites (blocked in previews).`);
    }
    const manual = pageSections.filter((s) => s.included && s.status === "requires_manual_work").length;
    const limited = pageSections.filter((s) => s.included && s.status === "processed_with_limitations").length;
    if (manual) reasons.push({ s: "processed_with_limitations", r: `${manual} section(s) require manual work.` });
    if (limited) notes.push(`${limited} section(s) processed with limitations.`);
    if (rec?.aliasOf) notes.push(`Same content as ${rec.aliasOf}.`);
    pages.push({ id, url: rec?.finalUrl ?? rec?.requestedUrl ?? p.sourceUrl ?? "", route: p.route, status: reasons.reduce<Status>((a, x) => worst(a, x.s), "processed"), reasons: reasons.map((x) => x.r), notes });
  }

  // Pages the capture found but did not turn into template pages.
  for (const rec of inv.pages?.pages ?? []) {
    if (ids.includes(rec.id)) continue;
    const captured = rec.captureStatus === "captured";
    const status: Status = rec.captureStatus === "alias" ? "processed" : captured ? "requires_manual_work" : "inaccessible";
    const why = rec.captureStatus === "alias" ? `Same content as ${rec.aliasOf ?? "another page"}; not a separate template page.` : captured ? `Captured but not templatised (${rec.templateStatus ?? "unknown"}).` : `Not captured (${rec.captureStatus ?? "unknown"}${rec.httpStatus ? `, HTTP ${rec.httpStatus}` : ""})${rec.reason ? `: ${rec.reason}` : ""}.`;
    pages.push({ id: rec.id, url: rec.finalUrl ?? rec.requestedUrl ?? "", route: null, status, reasons: status === "processed" ? [] : [why], notes: status === "processed" ? [why] : [] });
  }
  for (const u of inv.pages?.skippedUrls ?? []) {
    const url = typeof u === "string" ? u : String((u as { url?: string }).url ?? JSON.stringify(u));
    const reason = typeof u === "object" && u ? (u as { reason?: string }).reason : undefined;
    pages.push({ id: null, url, route: null, status: "inaccessible", reasons: [`Skipped by the capture${reason ? `: ${reason}` : ""}.`], notes: [] });
  }

  const summary = { pages: zero(), sections: zero() };
  for (const p of pages) summary.pages[p.status]++;
  for (const s of sections) if (s.included) summary.sections[s.status]++;
  const limits = inv.pages?.limits;
  return {
    generatedAt: new Date().toISOString(),
    pages,
    sections,
    summary,
    discovery: {
      complete: inv.pages ? (inv.pages.discovery?.complete ?? limits?.discoveryComplete ?? null) : null,
      limitsReached: limits?.reached ?? [],
      remainingUrls: limits?.remainingUrls?.length ?? 0,
      notes: inv.pages?.discovery?.notes ?? [],
    },
    sources: [
      inv.pages ? "page-inventory.json and section-inventory.json (generator, at generation)" : "no page inventory in this template",
      inv.verification ? "verification-report.json (generator, at generation)" : "no generation-time verification in this template",
      web ? `Web's checks of the current template (${web.at})` : "Web's checks not run yet (Run checks)",
    ],
  };
}

function sarDetail(check: SarCheck) {
  const list = (check.localFailures ?? check.broken ?? check.errors ?? check.blocked) as unknown[] | undefined;
  return Array.isArray(list) && list.length ? `: ${list.slice(0, 2).map((x) => (typeof x === "string" ? x : text((x as { url?: string }).url ?? x))).join("; ")}` : "";
}
function rootOrder(c: Composition, t: string, id: string): string[] {
  const sk = join(t, "composition", "skeletons", `${id}.html`);
  if (!existsSync(sk)) return Object.keys(c.regions);
  return [...readFileSync(sk, "utf8").matchAll(/\{\{@region\s+([A-Za-z0-9_-]+)\s*\}\}/g)].map((m) => m[1]);
}

// ------------------------------------------------------------- source edits
//
// Values that are not editable through content or design tokens and so need
// a direct edit of the template's source files.

export type SourceEdit = { kind: "colour" | "font" | "text" | "image" | "script"; file: string; where: string; value: string };
export type SourceEdits = { generatedAt: string; counts: Record<SourceEdit["kind"], number>; items: SourceEdit[]; truncated: boolean };

const COLOUR_PROP = /^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-shadow|text-decoration(-color)?|caret-color|column-rule(-color)?|accent-color|stop-color|flood-color|lighting-color|--[\w-]+)$/i;
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/i;
const stripVars = (v: string) => v.replace(/var\((?:[^()]|\([^()]*\))*\)/g, "");
const MAX_ITEMS = 2000;

export function sourceEdits(t: string): SourceEdits {
  const items: SourceEdit[] = [];
  const counts: SourceEdits["counts"] = { colour: 0, font: 0, text: 0, image: 0, script: 0 };
  const add = (e: SourceEdit) => {
    counts[e.kind]++;
    if (items.length < MAX_ITEMS) items.push(e);
  };
  const files = listFiles(t).filter((f) => !/^(dist|runtime|lib|node_modules|tokens)\//.test(f));

  const cssDecls = (css: string, file: string, where = "") => {
    try {
      postcss.parse(css, { from: undefined }).walkDecls((d) => {
        const inFontFace = d.parent?.type === "atrule" && (d.parent as postcss.AtRule).name === "font-face";
        const sel = d.parent?.type === "rule" ? (d.parent as postcss.Rule).selector : d.parent?.type === "atrule" ? `@${(d.parent as postcss.AtRule).name}` : "";
        if (COLOUR_PROP.test(d.prop) && COLOUR.test(stripVars(d.value))) add({ kind: "colour", file, where: `${where}${sel} { ${d.prop} }`, value: d.value });
        else if (d.prop === "font-family" && !inFontFace && !d.value.includes("var(")) add({ kind: "font", file, where: `${where}${sel} { font-family }`, value: d.value });
      });
    } catch {
      /* not parseable: not reported */
    }
  };

  for (const f of files) {
    if (f.endsWith(".css")) cssDecls(readFileSync(join(t, f), "utf8"), f);
    else if (/\.m?js$/.test(f) && f.startsWith("assets/")) add({ kind: "script", file: f, where: "script file", value: "Scripts are kept as captured: edit them directly." });
    else if (f.endsWith(".html") && /^(components|composition)\//.test(f)) {
      const html = readFileSync(join(t, f), "utf8");
      const els = elementsOf(parseMarkup(html));
      for (const el of els) {
        const tag = el.tagName;
        const style = el.attrs.find((a) => a.name === "style")?.value;
        if (style && COLOUR.test(stripVars(style))) add({ kind: "colour", file: f, where: `<${tag} style>`, value: style.slice(0, 200) });
        for (const a of el.attrs) if (["fill", "stroke", "stop-color", "color", "bgcolor"].includes(a.name) && COLOUR.test(a.value)) add({ kind: "colour", file: f, where: `<${tag} ${a.name}>`, value: a.value });
        for (const a of el.attrs) if (["src", "srcset", "poster"].includes(a.name) && a.value && !a.value.includes("{{@") && !a.value.startsWith("data:")) add({ kind: "image", file: f, where: `<${tag} ${a.name}>`, value: a.value.slice(0, 200) });
        if (tag === "style") cssDecls(textOf(el), f, "<style> ");
        if (tag === "script" || tag === "style") continue;
        for (const n of el.childNodes) {
          if (isElement(n) || n.nodeName !== "#text") continue;
          const v = (n as unknown as { value: string }).value.trim();
          if (v && !v.includes("{{@") && /[\p{L}\p{N}]/u.test(v)) add({ kind: "text", file: f, where: `<${tag}>`, value: v.slice(0, 120) });
        }
      }
    }
  }
  return { generatedAt: new Date().toISOString(), counts, items, truncated: Object.values(counts).reduce((a, b) => a + b, 0) > items.length };
}
const textOf = (el: El) => el.childNodes.map((n) => ("value" in n ? String((n as { value: unknown }).value) : "")).join("");

// ------------------------------------------------------------ section labels

/** A short label for a section: its type and its first heading-like text. */
export function sectionLabel(t: string, pageId: string, s: SectionDef): string {
  let scope: Record<string, unknown> = {};
  try {
    scope = sectionScope(t, pageId, s);
  } catch {
    /* no content */
  }
  for (const k of ["heading", "title", "headline", "label", "text"]) {
    const v = getPath(scope, k);
    if (typeof v === "string" && v.trim() && !v.includes("<")) return `${s.type} · ${v.trim().slice(0, 60)}`;
  }
  return `${s.type} · ${s.localId}`;
}
export const describeItem = (i: Item) => itemId(i);

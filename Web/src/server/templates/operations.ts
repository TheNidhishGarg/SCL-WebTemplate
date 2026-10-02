import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StoreError } from "@/server/store/errors";
import { cut, eachDepthAt, idsIn, isElement, parseDocument, parseMarkup, parseSelector, rangeOf, rescopeTokens, rootElement, select, suffixIds, tokenKeys, type ChildNode, type El, type Range } from "./markup";
import {
  componentFile,
  findItem,
  flattenItems,
  itemId,
  listFiles,
  LOCAL_ID,
  PAGE_ID,
  pageIds,
  readComponent,
  readComposition,
  readContent,
  readJson,
  readPage,
  sectionScope,
  skeletonFile,
  writeComposition,
  writeContent,
  writeJson,
  writePage,
  writeText,
  type Composition,
  type Item,
  type JsonObject,
  type PageDef,
  type SectionDef,
} from "./model";
import { compose } from "./composition";
import { setBinding } from "./tokens";

// Structural edits and explicit overrides on a generated template. Each one
// is a deterministic change to the template's own sources, recorded in
// overrides.json so the whole set can be replayed on a fresh copy of the
// generated template (to undo one, or to reprocess).
//
//   move / remove / restore      a section within its region
//   duplicate / insert           an independent copy (ids made unique)
//   merge / unmerge              adjacent sections handled as one unit
//   split                        a section into parts at a selector
//   exclude                      elements matching a selector, on one page
//   token-detach/-attach/-set    one declaration's use of a design token

const itemRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_/-]*$/, "Invalid section.");
const page = z.string().regex(PAGE_ID, "Invalid page.");
const region = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "Invalid region.");
const entry = z.string().min(1).max(600);
const selector = z.string().trim().min(1, "Enter a selector.").max(500);

export const OperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"), page, item: itemRef, to: z.number().int().min(0).max(10_000) }),
  z.object({ op: z.literal("remove"), page, item: itemRef }),
  z.object({ op: z.literal("restore"), page, item: itemRef }),
  z.object({ op: z.literal("duplicate"), page, item: itemRef, force: z.boolean().optional() }),
  z.object({ op: z.literal("insert"), page, from: z.object({ page, section: itemRef }), region, index: z.number().int().min(0).max(10_000), force: z.boolean().optional() }),
  z.object({ op: z.literal("merge"), page, items: z.array(itemRef).min(2).max(50) }),
  z.object({ op: z.literal("unmerge"), page, item: itemRef }),
  z.object({ op: z.literal("split"), page, item: itemRef, selector }),
  z.object({ op: z.literal("exclude"), page, selector }),
  z.object({ op: z.literal("token-detach"), entry }),
  z.object({ op: z.literal("token-attach"), entry }),
  z.object({ op: z.literal("token-set"), entry, value: z.string().max(500) }),
]);
export type Operation = z.infer<typeof OperationSchema>;
export type Recorded = Operation & { as?: string; at: string; status: "applied" | "failed"; warnings: string[]; error?: string };
export type Overrides = { version: 1; note: string; operations: Recorded[] };

export type OpContext = {
  /** Captured interaction dependencies of a section (from the section inventory). */
  dependencies: (s: SectionDef) => string[];
  /** Replaying: nothing-matched becomes a warning instead of an error. */
  replay?: boolean;
};

export const overridesFile = (t: string) => join(t, "overrides.json");
export const readOverrides = (t: string): Overrides =>
  existsSync(overridesFile(t)) ? readJson<Overrides>(overridesFile(t)) : { version: 1, note: "", operations: [] };
export const writeOverrides = (t: string, o: Overrides) =>
  writeJson(overridesFile(t), { ...o, note: "Explicit overrides applied to the generated template, in order. Web replays them on a fresh copy of the generated template when one is undone or the template is reprocessed." });

// ----------------------------------------------------------------- helpers

const conflict = (m: string) => new StoreError("conflict", m);
const notFound = (m: string) => new StoreError("not_found", m);

function composition(t: string, pageId: string): Composition {
  const c = readComposition(t, pageId);
  if (!c) throw conflict(`Page ${pageId} has no editable composition (its layout places no sections).`);
  return c;
}
const sectionOf = (p: PageDef, id: string) => {
  const s = p.sections.find((x) => x.id === id);
  if (!s) throw notFound(`Page ${p.id} has no section ${id}.`);
  return s;
};
const pick = (scope: JsonObject, keys: Iterable<string>): JsonObject =>
  Object.fromEntries([...keys].filter((k) => k in scope).map((k) => [k, structuredClone(scope[k])]));

function scriptsText(t: string): string {
  let out = "";
  for (const rel of listFiles(t)) {
    if (/^(dist|runtime|lib|node_modules)\//.test(rel)) continue;
    if (/\.(m?js)$/.test(rel) && rel.startsWith("assets/")) out += readFileSync(join(t, rel), "utf8") + "\n";
    else if (rel.endsWith(".html") && /^(components|layouts|composition)\//.test(rel)) {
      for (const m of readFileSync(join(t, rel), "utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) out += m[1] + "\n";
    }
    if (out.length > 20_000_000) break;
  }
  return out;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function uniqueLocal(t: string, pages: PageDef[], base: string) {
  for (let n = 1; ; n++) {
    const id = `${base}-copy${n}`;
    if (!pages.some((p) => p.sections.some((s) => s.localId === id)) && !existsSync(componentFile(t, `pages/${pages[0].id}/${id}`))) return id;
  }
}

/** Removes an item wherever it is (a region, or a merged group). */
function detach(c: Composition, id: string): { region: string; index: number; item: Item } | null {
  for (const [rid, r] of Object.entries(c.regions)) {
    for (let i = 0; i < r.items.length; i++) {
      const it = r.items[i];
      if (itemId(it) === id) {
        r.items.splice(i, 1);
        return { region: rid, index: i, item: it };
      }
      if ("group" in it) {
        const k = it.items.findIndex((x) => itemId(x) === id);
        if (k >= 0) {
          const [gone] = it.items.splice(k, 1);
          if (!it.items.length) r.items.splice(i, 1);
          return { region: rid, index: i, item: gone };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- copying

type Copied = { def: SectionDef; warnings: string[] };
function copySection(t: string, src: { page: string; section: string }, dstPage: string, origin: "duplicate" | "insert", ctx: OpContext, force: boolean, as?: string): Copied {
  const sp = readPage(t, src.page);
  const s = sectionOf(sp, src.section);
  const dp = src.page === dstPage ? sp : readPage(t, dstPage);
  if (!existsSync(componentFile(t, s.component))) throw conflict(`Section ${s.id} has no component file, so it cannot be copied.`);
  const text = readComponent(t, s.component);

  // What could break if this markup appears twice on a page.
  const risks: string[] = [];
  if (/<script\b/i.test(text)) risks.push("it contains a script");
  const deps = ctx.dependencies(s);
  if (deps.length) risks.push(`it has interactions (${deps.join("; ")})`);
  const { ids, dynamic } = idsIn(text);
  if (dynamic) risks.push("some of its ids are built from content and cannot be made unique");
  if (ids.length) {
    const js = scriptsText(t);
    const used = ids.filter((id) => new RegExp(`(#|['"])${escapeRe(id)}(['"\\s.:\\[)]|$)`).test(js));
    if (used.length) risks.push(`scripts refer to ${used.map((i) => `#${i}`).join(", ")}, which the copy renames`);
  }
  if (risks.length && !force) throw conflict(`Copying ${s.id} may not work: ${risks.join("; ")}. Confirm to copy it anyway.`);

  const localId = as ?? uniqueLocal(t, [dp], src.page === dstPage ? s.localId : `${src.page}-${s.localId}`);
  if (!LOCAL_ID.test(localId) || dp.sections.some((x) => x.localId === localId)) throw conflict(`Section ${dstPage}/${localId} already exists.`);
  const { text: copied, renamed } = suffixIds(text, `-${localId}`);
  const component = `pages/${dstPage}/${localId}`;
  writeText(componentFile(t, component), copied);

  const content = readContent(t, dstPage);
  content.sections = { ...(content.sections ?? {}), [localId]: structuredClone(sectionScope(t, src.page, s)) };
  writeContent(t, dstPage, content);
  const def: SectionDef = { id: `${dstPage}/${localId}`, localId, type: s.type, component, content: "page", origin, derivedFrom: s.id };
  dp.sections.push(def);
  writePage(t, dp);

  const warnings = risks.map((r) => `Copied although ${r}.`);
  const n = Object.keys(renamed).length;
  if (n) warnings.push(`${n} id(s) renamed in the copy (e.g. #${Object.keys(renamed)[0]} → #${Object.values(renamed)[0]}), with the references inside the section.`);
  if (/data-sar-form=/.test(copied)) warnings.push("The copy's form uses the same form configuration (site.config.json → integrations.forms) as the original.");
  if (s.content !== "page") warnings.push(`The copy has its own content; the original's shared content (${s.content}) is unchanged.`);
  return { def, warnings };
}

// ----------------------------------------------------------- split/exclude

function labelOf(el: El) {
  const id = el.attrs.find((a) => a.name === "id")?.value;
  const cls = el.attrs.find((a) => a.name === "class")?.value.trim().split(/\s+/)[0];
  return el.tagName + (id && !id.includes("{{") ? `#${id}` : cls && !cls.includes("{{") ? `.${cls}` : "");
}
function balanced(text: string) {
  let d = 0;
  for (const m of text.matchAll(/\{\{@(each|end)\b/g)) {
    d += m[1] === "each" ? 1 : -1;
    if (d < 0) return false;
  }
  return d === 0;
}
function markSection(text: string): { text: string; marked: boolean } {
  const m = /^(\s*<([A-Za-z][\w-]*))([^>]*)>/.exec(text);
  if (!m) return { text, marked: false };
  if (/\sdata-sar-section=/.test(m[3])) return { text, marked: true };
  return { text: `${m[1]} data-sar-section="{{@sectionid}}"${text.slice(m[1].length)}`, marked: true };
}
const nextRegion = (c: Composition) => `r${Math.max(0, ...Object.keys(c.regions).map((k) => Number(/^r(\d+)$/.exec(k)?.[1] ?? 0))) + 1}`;

function split(t: string, op: Extract<Operation, { op: "split" }>): string[] {
  const sel = parseSelector(op.selector);
  const c = composition(t, op.page);
  const loc = findItem(c, op.item);
  if (!loc) throw notFound(`${op.item} is not a section placed on this page (sections inside a merged group must be unmerged first).`);
  if (!("section" in loc.item)) throw conflict("Only a single section can be split.");
  const p = readPage(t, op.page);
  const s = sectionOf(p, op.item);
  const text = readComponent(t, s.component);
  const frag = parseMarkup(text);
  const root = rootElement(frag);
  if (!root) throw conflict(`${s.id} has no single root element, so it cannot be split. Edit its component (components/${s.component}.html) directly.`);
  const hits = select(frag, sel).filter((h) => h !== root);
  if (!hits.length) throw new StoreError("invalid", `"${op.selector}" matched nothing inside ${s.id}.`);
  if (hits.some((h) => eachDepthAt(text, rangeOf(h).start) > 0)) throw conflict(`The matched elements are repeated from a list ({{@each}}): edit the list in the content instead of splitting ${s.id}.`);
  const parent = hits[0].parentNode;
  if (!parent || !isElement(parent) || !hits.every((h) => h.parentNode === parent)) throw conflict(`The elements "${op.selector}" matches must be siblings (have the same parent element) to split ${s.id} at them.`);
  const ploc = parent.sourceCodeLocation;
  if (!ploc?.startTag || !ploc.endTag) throw conflict(`The parent element of the split points has no explicit end tag, so ${s.id} cannot be split safely.`);
  const innerStart = ploc.startTag.endOffset;
  const innerEnd = ploc.endTag.startOffset;
  if (eachDepthAt(text, innerStart) > 0) throw conflict(`The matched elements are repeated from a list ({{@each}}): edit the list in the content instead of splitting ${s.id}.`);

  // Partition the parent's children: each match starts a part.
  const parts: ChildNode[][] = [];
  const lead: ChildNode[] = [];
  for (const ch of parent.childNodes) {
    if (isElement(ch) && hits.includes(ch)) parts.push([ch]);
    else if (parts.length) parts[parts.length - 1].push(ch);
    else lead.push(ch);
  }
  if (lead.length) {
    if (lead.some(isElement)) parts.unshift(lead);
    else parts[0] = [...lead, ...parts[0]];
  }
  if (parts.length < 2) throw new StoreError("invalid", `Splitting ${s.id} at "${op.selector}" would leave it in one piece.`);
  const texts = parts.map((ns) => text.slice(rangeOf(ns[0]).start, rangeOf(ns[ns.length - 1]).end));
  if (!texts.every(balanced)) throw conflict(`A split point falls inside a repeated block ({{@each}}) of ${s.id}.`);

  const warnings: string[] = [];
  const rid = nextRegion(c);
  const outer = text.slice(0, innerStart) + text.slice(innerEnd);
  const frameKeys = tokenKeys(outer);
  const frame = rescopeTokens(text.slice(0, innerStart) + `{{@region ${rid}}}` + text.slice(innerEnd), `page.frames.${s.localId}`, s.id);
  const frameFile = `composition/frames/${op.page}/${s.localId}.html`;
  writeText(join(t, frameFile), frame);

  const scope = sectionScope(t, op.page, s);
  const content = readContent(t, op.page);
  content.page = { ...(content.page ?? {}), frames: { ...(((content.page ?? {}).frames ?? {}) as JsonObject), [s.localId]: pick(scope, frameKeys) } };
  if (s.content === "page") delete content.sections?.[s.localId];
  else warnings.push(`The parts have page-specific content; the shared content (${s.content}) is unchanged for other pages.`);
  const seen = new Map<string, number>();
  for (const k of frameKeys) seen.set(k, 1);
  const items: Item[] = [];
  texts.forEach((pt, i) => {
    const localId = `${s.localId}-p${i + 1}`;
    if (p.sections.some((x) => x.localId === localId)) throw conflict(`Section ${op.page}/${localId} already exists.`);
    const marked = markSection(pt);
    if (!marked.marked) warnings.push(`Part ${i + 1} starts with text, not an element, so it is not marked in the output.`);
    const component = `pages/${op.page}/${localId}`;
    writeText(componentFile(t, component), marked.text);
    const keys = tokenKeys(pt);
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
    content.sections = { ...(content.sections ?? {}), [localId]: pick(scope, keys) };
    p.sections.push({ id: `${op.page}/${localId}`, localId, type: s.type, component, content: "page", origin: "split", derivedFrom: s.id });
    items.push({ section: `${op.page}/${localId}` });
  });
  const shared = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (shared.length) warnings.push(`Content used by more than one part was copied to each: ${shared.join(", ")}.`);
  writeContent(t, op.page, content);
  writePage(t, p);
  c.regions[rid] = { parent: labelOf(parent), joiner: "", items };
  c.regions[loc.region].items[loc.index] = { frame: s.id, region: rid, file: frameFile };
  writeComposition(t, c);
  warnings.unshift(`${s.id} was split into ${texts.length} parts; its wrapper (${labelOf(root)}${parent !== root ? ` › … › ${labelOf(parent)}` : ""}) stays around them.`);
  return warnings;
}

function exclude(t: string, op: Extract<Operation, { op: "exclude" }>, ctx: OpContext): string[] {
  const sel = parseSelector(op.selector);
  const c = composition(t, op.page);
  const p = readPage(t, op.page);
  const warnings: string[] = [];
  let removedSections = 0;
  let removedElements = 0;
  const rendered = Object.values(c.regions).flatMap((r) => flattenItems(c, r.items));
  const framesById = new Map(Object.values(c.regions).flatMap((r) => r.items).filter((i): i is Extract<Item, { frame: string }> => "frame" in i).map((f) => [f.frame, f]));
  const otherUsers = (component: string, self: string) => pageIds(t).some((id) => (id === op.page ? p : readPage(t, id)).sections.some((s) => s.component === component && s.id !== self));

  for (const id of new Set(rendered)) {
    const frame = framesById.get(id);
    if (frame) {
      const text = readFileSync(join(t, frame.file), "utf8");
      const hits = select(parseMarkup(text), sel);
      const ranges = hits.map((h) => rangeOf(h)).filter((r) => !text.slice(r.start, r.end).includes("{{@region"));
      if (ranges.length < hits.length) warnings.push(`In ${id}, ${hits.length - ranges.length} match(es) contain the section's parts and were kept: exclude the parts instead.`);
      if (ranges.length) {
        writeText(join(t, frame.file), cut(text, ranges));
        removedElements += ranges.length;
      }
      continue;
    }
    const s = p.sections.find((x) => x.id === id);
    if (!s || !existsSync(componentFile(t, s.component))) continue;
    const text = readComponent(t, s.component);
    const frag = parseMarkup(text);
    const root = rootElement(frag);
    const hits = select(frag, sel);
    if (!hits.length) continue;
    if (root && hits.includes(root)) {
      const gone = detach(c, id);
      if (gone) c.removed.push({ item: gone.item, region: gone.region, index: gone.index, reason: "excluded", selector: op.selector });
      removedSections++;
      continue;
    }
    const ranges: Range[] = hits.map((h) => rangeOf(h));
    let component = s.component;
    if (component.startsWith("shared/") || otherUsers(component, s.id)) {
      // Page-scoped: other pages keep the shared markup.
      component = `pages/${op.page}/${s.localId}`;
      if (existsSync(componentFile(t, component))) component = `pages/${op.page}/${s.localId}-local`;
      s.component = component;
      warnings.push(`${s.id} now uses a page-specific copy of its shared markup (components/${component}.html); other pages are unchanged.`);
    }
    writeText(componentFile(t, component), cut(text, ranges));
    removedElements += ranges.length;
  }

  // The layout around the sections.
  const skFile = skeletonFile(t, op.page);
  const sk = readFileSync(skFile, "utf8");
  const hits = select(parseDocument(sk), sel).filter((h) => !["html", "head", "body"].includes(h.tagName) && h.sourceCodeLocation);
  const ranges = hits.map((h) => rangeOf(h)).filter((r) => !sk.slice(r.start, r.end).includes("{{@region"));
  if (ranges.length < hits.length) warnings.push(`${hits.length - ranges.length} match(es) in the page layout contain sections and were kept: exclude the sections instead.`);
  if (ranges.length) {
    writeText(skFile, cut(sk, ranges));
    removedElements += ranges.length;
  }

  if (!removedSections && !removedElements) {
    const msg = `"${op.selector}" matched nothing in page ${op.page}'s markup (text inside rich-text content fields is not searched).`;
    if (!ctx.replay) throw new StoreError("invalid", msg);
    warnings.push(msg);
  }
  writePage(t, p);
  writeComposition(t, c);
  warnings.unshift(`Excluded ${removedSections} section(s) and ${removedElements} element(s) matching "${op.selector}".`);
  return warnings;
}

// ---------------------------------------------------------------- dispatch

function run(t: string, op: Operation, ctx: OpContext, as?: string): { as?: string; warnings: string[] } {
  switch (op.op) {
    case "move": {
      const c = composition(t, op.page);
      const loc = findItem(c, op.item);
      if (!loc) throw notFound(`${op.item} is not placed on this page.`);
      const r = c.regions[loc.region];
      const to = Math.min(op.to, r.items.length - 1);
      r.items.splice(loc.index, 1);
      r.items.splice(to, 0, loc.item);
      writeComposition(t, c);
      return { warnings: [] };
    }
    case "remove": {
      const c = composition(t, op.page);
      const gone = detach(c, op.item);
      if (!gone) throw notFound(`${op.item} is not placed on this page.`);
      c.removed.push({ item: gone.item, region: gone.region, index: gone.index, reason: "removed" });
      writeComposition(t, c);
      return { warnings: [] };
    }
    case "restore": {
      const c = composition(t, op.page);
      const k = c.removed.findIndex((r) => itemId(r.item) === op.item);
      if (k < 0) throw notFound(`${op.item} has not been removed from this page.`);
      const [r] = c.removed.splice(k, 1);
      const items = c.regions[r.region]?.items;
      if (!items) throw conflict(`The region ${op.item} came from no longer exists.`);
      items.splice(Math.min(r.index, items.length), 0, r.item);
      writeComposition(t, c);
      return { warnings: [] };
    }
    case "duplicate": {
      const c = composition(t, op.page);
      const loc = findItem(c, op.item);
      if (!loc) throw notFound(`${op.item} is not placed on this page.`);
      if (!("section" in loc.item)) throw conflict("Only single sections can be duplicated: unmerge the group, or duplicate the parts of a split section.");
      const { def, warnings } = copySection(t, { page: op.page, section: op.item }, op.page, "duplicate", ctx, !!op.force, as);
      c.regions[loc.region].items.splice(loc.index + 1, 0, { section: def.id });
      writeComposition(t, c);
      return { as: def.localId, warnings };
    }
    case "insert": {
      const c = composition(t, op.page);
      const items = c.regions[op.region]?.items;
      if (!items) throw notFound(`Page ${op.page} has no region ${op.region}.`);
      const { def, warnings } = copySection(t, op.from, op.page, "insert", ctx, !!op.force, as);
      items.splice(Math.min(op.index, items.length), 0, { section: def.id });
      writeComposition(t, c);
      return { as: def.localId, warnings };
    }
    case "merge": {
      const c = composition(t, op.page);
      const locs = op.items.map((id) => findItem(c, id) ?? (() => { throw notFound(`${id} is not placed on this page.`); })());
      if (new Set(locs.map((l) => l.region)).size > 1) throw conflict("Only sections in the same region (the same wrapper) can be merged.");
      locs.sort((a, b) => a.index - b.index);
      if (locs.some((l, i) => i && l.index !== locs[i - 1].index + 1)) throw conflict("Only adjacent sections can be merged.");
      const all = new Set(Object.values(c.regions).flatMap((r) => r.items.map(itemId)));
      let name = as;
      for (let n = 1; !name; n++) if (!all.has(`${op.page}/merged-${n}`)) name = `${op.page}/merged-${n}`;
      const r = c.regions[locs[0].region];
      r.items.splice(locs[0].index, locs.length, { group: name, items: locs.flatMap((l) => ("group" in l.item ? l.item.items : [l.item])) });
      writeComposition(t, c);
      return { as: name, warnings: [] };
    }
    case "unmerge": {
      const c = composition(t, op.page);
      const loc = findItem(c, op.item);
      if (!loc || !("group" in loc.item)) throw notFound(`${op.item} is not a merged group on this page.`);
      c.regions[loc.region].items.splice(loc.index, 1, ...loc.item.items);
      writeComposition(t, c);
      return { warnings: [] };
    }
    case "split":
      return { warnings: split(t, op) };
    case "exclude":
      return { warnings: exclude(t, op, ctx) };
    case "token-detach":
    case "token-attach": {
      const b = setBinding(t, op.entry, op.op === "token-detach" ? "detach" : "attach");
      return { warnings: [`${b.property} in ${b.selector} (${b.file}) is now ${b.current}.`] };
    }
    case "token-set": {
      const b = setBinding(t, op.entry, "set", op.value);
      return { warnings: [`${b.property} in ${b.selector} (${b.file}) is now ${b.current}.`] };
    }
  }
}

/** Applies one operation and records it. */
export function applyOperation(t: string, input: unknown, ctx: OpContext): Recorded {
  const parsed = OperationSchema.safeParse(input);
  if (!parsed.success) throw new StoreError("invalid", parsed.error.issues[0]?.message ?? "Invalid operation.");
  const op = parsed.data;
  const { as, warnings } = run(t, op, ctx);
  compose(t); // layouts/ follow the composition
  const rec: Recorded = { ...op, ...(as ? { as } : {}), at: new Date().toISOString(), status: "applied", warnings };
  const o = readOverrides(t);
  o.operations.push(rec);
  writeOverrides(t, o);
  return rec;
}

/** Replays recorded operations on a fresh copy; failures are recorded, not thrown. */
export function replayOperations(t: string, ops: Recorded[], ctx: OpContext): Recorded[] {
  const out: Recorded[] = [];
  for (const rec of ops) {
    const { as, at } = rec;
    const op = OperationSchema.parse(rec); // drops the record's own fields
    try {
      const r = run(t, op, { ...ctx, replay: true }, as);
      out.push({ ...op, ...(r.as ? { as: r.as } : {}), at, status: "applied", warnings: r.warnings });
    } catch (e) {
      out.push({ ...op, ...(as ? { as } : {}), at, status: "failed", warnings: [], error: (e as Error).message });
    }
  }
  writeOverrides(t, { version: 1, note: "", operations: out });
  return out;
}

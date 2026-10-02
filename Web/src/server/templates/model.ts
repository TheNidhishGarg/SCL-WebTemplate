import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StoreError } from "@/server/store/errors";

// The generated template's files, as SaveAllResources writes them
// (pages/, content/, components/, layouts/, site.config.json), plus the
// composition files Web adds (composition/, overrides.json, tokens/).

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export type SectionDef = {
  id: string;
  localId: string;
  type: string;
  component: string;
  content: string; // "page" or "shared:<key>"
  origin?: "duplicate" | "insert" | "split";
  derivedFrom?: string;
};
export type PageDef = { id: string; route: string; sourceUrl?: string; layout: string; sections: SectionDef[] };
export type PageContent = { page?: JsonObject; sections?: Record<string, Json> };

export type Item = { section: string } | { group: string; items: Item[] } | { frame: string; region: string; file: string };
export type Region = { parent: string; joiner: string; gaps?: string[]; items: Item[] };
export type Removed = { item: Item; region: string; index: number; reason: "removed" | "excluded"; selector?: string };
export type Composition = { version: 1; page: string; regions: Record<string, Region>; removed: Removed[] };

export const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
export const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}
export function writeText(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** A path inside the template, refusing anything that would leave it. */
export function inside(t: string, rel: string): string {
  const base = resolve(t);
  const p = resolve(base, rel);
  if (!p.startsWith(base + sep)) throw new StoreError("invalid", "That path is outside the template.");
  return p;
}

const pageId = (id: string) => {
  if (!PAGE_ID.test(id)) throw new StoreError("invalid", "Invalid page.");
  return id;
};
export const pageIds = (t: string) =>
  existsSync(join(t, "pages"))
    ? readdirSync(join(t, "pages"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .filter((id) => PAGE_ID.test(id))
        .sort()
    : [];

export const readPage = (t: string, id: string) => readJson<PageDef>(join(t, "pages", `${pageId(id)}.json`));
export const writePage = (t: string, p: PageDef) => writeJson(join(t, "pages", `${pageId(p.id)}.json`), p);
export function readContent(t: string, id: string): PageContent {
  const f = join(t, "content", "pages", `${pageId(id)}.json`);
  return existsSync(f) ? readJson<PageContent>(f) : { page: {}, sections: {} };
}
export const writeContent = (t: string, id: string, c: PageContent) => writeJson(join(t, "content", "pages", `${pageId(id)}.json`), c);
export const readShared = (t: string): JsonObject => (existsSync(join(t, "content", "shared.json")) ? readJson<JsonObject>(join(t, "content", "shared.json")) : {});

export const compositionFile = (t: string, id: string) => join(t, "composition", `${pageId(id)}.json`);
export const skeletonFile = (t: string, id: string) => join(t, "composition", "skeletons", `${pageId(id)}.html`);
export const readComposition = (t: string, id: string): Composition | null => (existsSync(compositionFile(t, id)) ? readJson<Composition>(compositionFile(t, id)) : null);
export const writeComposition = (t: string, c: Composition) => writeJson(compositionFile(t, c.page), c);

export const componentFile = (t: string, component: string) => inside(t, join("components", `${component}.html`));
export const readComponent = (t: string, component: string) => readFileSync(componentFile(t, component), "utf8");

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
export function deepMerge(base: Json | undefined, over: Json | undefined): Json | undefined {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || !base || !over || typeof base !== "object" || typeof over !== "object") return over;
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v) as Json;
  return out;
}

/** The content a section renders with (its page content, or shared content with page overrides). */
export function sectionScope(t: string, pageIdValue: string, s: SectionDef): JsonObject {
  const local = readContent(t, pageIdValue).sections?.[s.localId];
  if (s.content === "page") return (local && typeof local === "object" && !Array.isArray(local) ? local : {}) as JsonObject;
  const shared = getPath(readShared(t), s.content.replace(/^shared:/, "")) as Json | undefined;
  return (deepMerge(shared ?? {}, local) ?? {}) as JsonObject;
}

// ------------------------------------------------------------ composition

export const itemId = (i: Item) => ("section" in i ? i.section : "group" in i ? i.group : i.frame);
export const itemKind = (i: Item) => ("section" in i ? "section" : "group" in i ? "group" : "frame");

/** Sections in render order (a frame's own id comes before its parts). */
export function flattenItems(c: Composition, items: Item[]): string[] {
  return items.flatMap((i) => ("section" in i ? [i.section] : "group" in i ? flattenItems(c, i.items) : [i.frame, ...flattenItems(c, c.regions[i.region]?.items ?? [])]));
}
/** Top-level regions: the ones in the skeleton (not inside a frame). */
export function rootRegions(c: Composition): string[] {
  const nested = new Set(Object.values(c.regions).flatMap((r) => r.items.flatMap(function inner(i: Item): string[] {
    return "frame" in i ? [i.region] : "group" in i ? i.items.flatMap(inner) : [];
  })));
  for (const r of c.removed) if ("frame" in r.item) nested.add(r.item.region);
  return Object.keys(c.regions).filter((id) => !nested.has(id));
}
export function renderOrder(c: Composition, skeleton: string): string[] {
  const order: string[] = [];
  for (const m of skeleton.matchAll(/\{\{@region\s+([A-Za-z0-9_-]+)\s*\}\}/g)) order.push(...flattenItems(c, c.regions[m[1]]?.items ?? []));
  return order;
}

export function findItem(c: Composition, id: string): { region: string; index: number; item: Item } | null {
  for (const [rid, r] of Object.entries(c.regions)) {
    const index = r.items.findIndex((i) => itemId(i) === id);
    if (index >= 0) return { region: rid, index, item: r.items[index] };
  }
  return null;
}

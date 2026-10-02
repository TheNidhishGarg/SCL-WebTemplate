import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { StoreError } from "@/server/store/errors";

// Markup helpers for generated templates. Every change is made by cutting
// the original text at parse5's source offsets, never by re-serialising a
// parsed tree, so markup Web does not touch stays byte-for-byte as generated.

export type El = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type Parent = DefaultTreeAdapterMap["parentNode"];
export type ChildNode = DefaultTreeAdapterMap["childNode"];

export const isElement = (n: Node): n is El => "tagName" in n;
export const parseDocument = (text: string) => parse(text, { sourceCodeLocationInfo: true });
export const parseMarkup = (text: string) => parseFragment(text, { sourceCodeLocationInfo: true });

export function elementsOf(root: Parent): El[] {
  const out: El[] = [];
  const walk = (n: Parent) => {
    for (const c of n.childNodes) {
      if (!isElement(c)) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

export const attr = (el: El, name: string) => el.attrs.find((a) => a.name === name)?.value;

// ------------------------------------------------------------------ selectors
//
// A small, explicit subset of CSS selectors, enough to point at captured
// markup: tag, *, #id, .class, [attr], [attr=v] (also ~= ^= $= *=), descendant
// and child (>) combinators, comma-separated lists. Anything else is refused
// with this message rather than guessed at.

export const SELECTOR_HELP = "Supported selectors: tag, *, #id, .class, [attr], [attr=value] (also ~= ^= $= *=), descendant and child (>) combinators, and comma-separated lists.";
type AttrTest = { name: string; op: "" | "=" | "~=" | "^=" | "$=" | "*="; value: string };
type Compound = { tag: string | null; id: string | null; classes: string[]; attrs: AttrTest[] };
type Complex = { parts: Compound[]; combinators: (" " | ">")[] };
export type Selector = Complex[];

const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*/;
export function parseSelector(input: string): Selector {
  const text = input.trim();
  if (!text || text.length > 500) throw new StoreError("invalid", `Enter a selector (up to 500 characters). ${SELECTOR_HELP}`);
  const out: Selector = [];
  let i = 0;
  const fail = (): never => {
    throw new StoreError("invalid", `Unsupported selector "${text}" near "${text.slice(i, i + 20)}". ${SELECTOR_HELP}`);
  };
  const ident = () => {
    const m = IDENT.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
    return m![0];
  };
  let complex: Complex = { parts: [], combinators: [] };
  let pending: " " | ">" | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (complex.parts.length && pending === null) pending = " ";
      continue;
    }
    if (ch === ">") {
      if (!complex.parts.length) fail();
      pending = ">";
      i++;
      continue;
    }
    if (ch === ",") {
      if (!complex.parts.length || (pending === ">")) fail();
      out.push(complex);
      complex = { parts: [], combinators: [] };
      pending = null;
      i++;
      continue;
    }
    // a compound selector
    const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
    if (ch === "*") i++;
    else if (/[A-Za-z]/.test(ch)) c.tag = ident().toLowerCase();
    while (i < text.length && /[#.[]/.test(text[i])) {
      if (text[i] === "#") {
        i++;
        c.id = ident();
      } else if (text[i] === ".") {
        i++;
        c.classes.push(ident());
      } else {
        const m = /^\[\s*([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(text.slice(i));
        if (!m) fail();
        c.attrs.push({ name: m![1].toLowerCase(), op: (m![2] ?? "") as AttrTest["op"], value: m![3] ?? m![4] ?? m![5] ?? "" });
        i += m![0].length;
      }
    }
    if (c.tag === null && c.id === null && !c.classes.length && !c.attrs.length && ch !== "*") fail();
    if (complex.parts.length) complex.combinators.push(pending ?? " ");
    complex.parts.push(c);
    pending = null;
  }
  if (!complex.parts.length || pending === ">") fail();
  out.push(complex);
  return out;
}

function matchesCompound(el: El, c: Compound) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && attr(el, "id") !== c.id) return false;
  if (c.classes.length) {
    const cls = (attr(el, "class") ?? "").split(/\s+/);
    if (!c.classes.every((k) => cls.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = attr(el, a.name);
    if (v === undefined) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  return true;
}

const parentEl = (el: El): El | null => (el.parentNode && isElement(el.parentNode) ? el.parentNode : null);

function matchesComplex(el: El, s: Complex, at = s.parts.length - 1): boolean {
  if (!matchesCompound(el, s.parts[at])) return false;
  if (at === 0) return true;
  const comb = s.combinators[at - 1];
  if (comb === ">") {
    const p = parentEl(el);
    return !!p && matchesComplex(p, s, at - 1);
  }
  for (let p = parentEl(el); p; p = parentEl(p)) if (matchesComplex(p, s, at - 1)) return true;
  return false;
}

export const matches = (el: El, sel: Selector) => sel.some((s) => matchesComplex(el, s));

/** Matching elements, outermost only (a match inside another match is dropped). */
export function select(root: Parent, sel: Selector): El[] {
  const all = elementsOf(root).filter((el) => matches(el, sel));
  return all.filter((el) => !all.some((o) => o !== el && contains(o, el)));
}
const contains = (a: El, b: El) => {
  for (let p = parentEl(b); p; p = parentEl(p)) if (p === a) return true;
  return false;
};

// ------------------------------------------------------------------- ranges

export type Range = { start: number; end: number };
export function rangeOf(n: ChildNode): Range {
  const loc = n.sourceCodeLocation;
  if (!loc) throw new StoreError("conflict", "This markup has no source positions (it was rewritten by the parser), so Web will not edit it.");
  return { start: loc.startOffset, end: loc.endOffset };
}
/** Removes ranges (outermost, non-overlapping) from the text. */
export function cut(text: string, ranges: Range[]): string {
  let out = text;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + out.slice(r.end);
  return out;
}

/** The single root element of a parsed component, if it has exactly one. */
export function rootElement(frag: ReturnType<typeof parseMarkup>): El | null {
  const els = frag.childNodes.filter(isElement);
  const other = frag.childNodes.filter((n) => !isElement(n) && !("value" in n && /^\s*$/.test((n as { value: string }).value)) && n.nodeName !== "#comment");
  return els.length === 1 && !other.length ? els[0] : null;
}

// ---------------------------------------------------------------------- ids

const ID_LIST_ATTRS = new Set(["for", "list", "form", "headers", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-details", "aria-errormessage", "aria-flowto"]);
const FRAGMENT_ATTRS = new Set(["href", "xlink:href", "data-target", "data-bs-target", "data-href"]);
const TAG = /<[A-Za-z][^>]*>/g;
const ATTR = /(\s)([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g;

/** Static ids in a component, and whether any id is built from content. */
export function idsIn(text: string): { ids: string[]; dynamic: boolean } {
  const ids: string[] = [];
  let dynamic = false;
  for (const tag of text.match(TAG) ?? []) {
    for (const m of tag.matchAll(ATTR)) {
      if (m[2].toLowerCase() !== "id") continue;
      if (m[3].includes("{{@")) dynamic = true;
      else if (m[3]) ids.push(m[3]);
    }
  }
  return { ids: [...new Set(ids)], dynamic };
}

/**
 * Gives every static id in a component a suffix, and updates the references
 * to those ids inside the component (labels, ARIA, #fragment links, url(#x)),
 * so a copy of a section never repeats the original's ids.
 */
export function suffixIds(text: string, suffix: string): { text: string; renamed: Record<string, string> } {
  const { ids } = idsIn(text);
  const renamed = Object.fromEntries(ids.map((id) => [id, `${id}${suffix}`]));
  if (!ids.length) return { text, renamed };
  const has = (v: string) => Object.prototype.hasOwnProperty.call(renamed, v);
  const out = text.replace(TAG, (tag) =>
    tag.replace(ATTR, (m, ws: string, name: string, value: string) => {
      const n = name.toLowerCase();
      let v = value;
      if (n === "id" && has(v)) v = renamed[v];
      else if (ID_LIST_ATTRS.has(n)) v = v.split(/(\s+)/).map((t) => (has(t) ? renamed[t] : t)).join("");
      else if (FRAGMENT_ATTRS.has(n) && v.startsWith("#") && has(v.slice(1))) v = `#${renamed[v.slice(1)]}`;
      v = v.replace(/url\(\s*#([^)\s]+)\s*\)/g, (u, id: string) => (has(id) ? `url(#${renamed[id]})` : u));
      return v === value ? m : `${ws}${name}="${v}"`;
    }),
  );
  return { text: out, renamed };
}

// ------------------------------------------------------------ template tokens

// The template engine's token syntax ({{@name path}}), as documented in the
// template's lib/engine.mjs. Web only reads and re-prefixes paths.
const TOKEN = /\{\{@([a-z-]*)(?:\s+([^}]*?))?\s*\}\}/g;
const PATH_TOKENS = new Set(["", "html", "url", "srcset", "each"]);

/** Top-level content keys a piece of markup reads (outside {{@each}} blocks). */
export function tokenKeys(text: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  for (const m of text.matchAll(TOKEN)) {
    const [, name, arg = ""] = m;
    if (name === "end") depth = Math.max(0, depth - 1);
    else {
      if (depth === 0 && PATH_TOKENS.has(name) && arg.trim()) keys.add(arg.trim().split(".")[0]);
      if (name === "each") depth++;
    }
  }
  return keys;
}

/** {{@each}} nesting depth at an offset (0 = not inside a repeated block). */
export function eachDepthAt(text: string, offset: number): number {
  let depth = 0;
  for (const m of text.slice(0, offset).matchAll(TOKEN)) {
    if (m[1] === "each") depth++;
    else if (m[1] === "end") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Moves markup from a section's scope to the page's scope: content paths
 * outside {{@each}} blocks get a prefix, and {{@sectionid}} becomes the
 * literal id (the layout renders without a section).
 */
export function rescopeTokens(text: string, prefix: string, sectionId: string): string {
  let depth = 0;
  return text.replace(TOKEN, (m, name: string, arg: string | undefined) => {
    if (name === "end") {
      depth = Math.max(0, depth - 1);
      return m;
    }
    if (name === "sectionid") return sectionId;
    let out = m;
    if (depth === 0 && PATH_TOKENS.has(name) && arg?.trim()) out = `{{@${name} ${prefix}.${arg.trim()}}}`;
    if (name === "each") depth++;
    return out;
  });
}

export const escapeHtml = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

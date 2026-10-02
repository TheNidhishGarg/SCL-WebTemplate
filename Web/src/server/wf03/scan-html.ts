import { createHash } from "node:crypto";
import { parse, serializeOuter, type DefaultTreeAdapterMap } from "parse5";
import type { Evidence } from "@/domain/source-analysis";
import { ev, excerpt } from "./scan-util";

// Facts read from one HTML file with a spec-compliant parser, each with its
// line. Structural blocks are kept with their exact markup so the scanner can
// tell "identical in five pages" (observed) from "looks similar" (inferred).

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export type RefKind = "page" | "image" | "script" | "stylesheet" | "font" | "media" | "other";

export type HtmlBlock = { tag: string; signature: string; label: string; startLine: number; endLine: number; markup: string };

export type HtmlFacts = {
  lang: string | null;
  title: string | null;
  viewport: boolean;
  generator: string | null;
  refs: { ref: string; kind: RefKind; integrity: boolean; e: Evidence }[];
  blankTargetsWithoutNoopener: Evidence[];
  inlineScripts: { text: string; line: number }[];
  inlineStyles: { text: string; line: number }[];
  imgWithoutAlt: Evidence[];
  unlabeledControls: Evidence[];
  unnamedControls: Evidence[];
  headingSkips: Evidence[];
  positiveTabindex: Evidence[];
  hasH1: boolean;
  srcset: number;
  picture: number;
  layoutBlocks: HtmlBlock[]; // header, nav, footer
  sections: HtmlBlock[];
  skeleton: string;
  markers: { name: string; e: Evidence }[];
  googleFontFamilies: string[];
};

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;
const isElement = (n: Node): n is Element => "tagName" in n;
const lineOf = (n: Node) => n.sourceCodeLocation?.startLine ?? null;
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function textOf(n: Node): string {
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  if (!("childNodes" in n)) return "";
  return n.childNodes.map(textOf).join(" ");
}

function walk(n: Node, visit: (el: Element, ancestors: Element[]) => void, ancestors: Element[] = []) {
  if (isElement(n)) visit(n, ancestors);
  const kids = n.nodeName === "template" ? ((n as DefaultTreeAdapterMap["template"]).content.childNodes as Node[]) : "childNodes" in n ? (n.childNodes as Node[]) : [];
  const next = isElement(n) ? [...ancestors, n] : ancestors;
  for (const k of kids) walk(k, visit, next);
}

const CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const UNLABELLED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

export function scanHtml(path: string, html: string): HtmlFacts {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const out: HtmlFacts = {
    lang: null,
    title: null,
    viewport: false,
    generator: null,
    refs: [],
    blankTargetsWithoutNoopener: [],
    inlineScripts: [],
    inlineStyles: [],
    imgWithoutAlt: [],
    unlabeledControls: [],
    unnamedControls: [],
    headingSkips: [],
    positiveTabindex: [],
    hasH1: false,
    srcset: 0,
    picture: 0,
    layoutBlocks: [],
    sections: [],
    skeleton: "",
    markers: [],
    googleFontFamilies: [],
  };
  const labelFor = new Set<string>();
  const controls: { el: Element; insideLabel: boolean }[] = [];
  let lastHeading = 0;
  const ref = (raw: string | null, kind: RefKind, el: Element, integrity = false) => {
    if (raw) out.refs.push({ ref: raw, kind, integrity, e: ev(path, lineOf(el), serializeOuter(el).slice(0, 300)) });
  };
  const srcsetRefs = (value: string | null, kind: RefKind, el: Element) => {
    if (!value) return;
    for (const part of value.split(",")) ref(part.trim().split(/\s+/)[0] ?? null, kind, el);
  };

  walk(doc as unknown as Node, (el, ancestors) => {
    const tag = el.tagName;
    const line = lineOf(el);
    const tabindex = attr(el, "tabindex");
    if (tabindex !== null && Number(tabindex) > 0) out.positiveTabindex.push(ev(path, line, `tabindex="${tabindex}"`));
    for (const a of el.attrs) {
      if (a.name === "data-wf-page" || a.name === "data-wf-site") out.markers.push({ name: "webflow", e: ev(path, line, `${a.name}="${a.value}"`) });
      if (a.name.startsWith("data-framer")) out.markers.push({ name: "framer", e: ev(path, line, a.name) });
      if (a.name === "data-aos") out.markers.push({ name: "aos", e: ev(path, line, `data-aos="${a.value}"`) });
      if (a.name === "style" && /url\(/.test(a.value)) for (const m of a.value.matchAll(/url\(\s*['"]?([^'")]+)/g)) ref(m[1], "image", el);
    }

    switch (tag) {
      case "html":
        out.lang = attr(el, "lang");
        break;
      case "title":
        out.title = excerpt(textOf(el), 200) || null;
        break;
      case "meta": {
        const name = attr(el, "name")?.toLowerCase();
        if (name === "viewport") out.viewport = true;
        if (name === "generator") out.generator = attr(el, "content");
        break;
      }
      case "link": {
        const rel = (attr(el, "rel") ?? "").toLowerCase();
        const href = attr(el, "href");
        if (href && /fonts\.googleapis\.com/.test(href)) {
          for (const fam of new URL(href.startsWith("//") ? `https:${href}` : href, "https://x").searchParams.getAll("family")) {
            out.googleFontFamilies.push(fam.split(":")[0].replace(/\+/g, " "));
          }
        }
        const kind: RefKind = rel.includes("stylesheet") ? "stylesheet" : /\bas=["']?font/.test(serializeOuter(el)) || /\.(woff2?|ttf|otf)$/i.test(href ?? "") ? "font" : "other";
        if (rel.includes("stylesheet") || rel.includes("preload") || rel.includes("icon") || rel.includes("modulepreload") || rel.includes("manifest")) ref(href, kind, el, attr(el, "integrity") !== null);
        break;
      }
      case "script": {
        const src = attr(el, "src");
        if (src) ref(src, "script", el, attr(el, "integrity") !== null);
        else {
          const text = textOf(el);
          if (text.trim()) out.inlineScripts.push({ text, line: line ?? 1 });
          if (attr(el, "id") === "__NEXT_DATA__") out.markers.push({ name: "next-data", e: ev(path, line, '<script id="__NEXT_DATA__">') });
        }
        break;
      }
      case "style":
        out.inlineStyles.push({ text: textOf(el), line: line ?? 1 });
        break;
      case "img": {
        ref(attr(el, "src"), "image", el);
        srcsetRefs(attr(el, "srcset"), "image", el);
        if (attr(el, "srcset")) out.srcset++;
        const decorative = attr(el, "role") === "presentation" || attr(el, "aria-hidden") === "true";
        if (attr(el, "alt") === null && !decorative) out.imgWithoutAlt.push(ev(path, line, serializeOuter(el)));
        break;
      }
      case "picture":
        out.picture++;
        break;
      case "source":
        ref(attr(el, "src"), "media", el);
        srcsetRefs(attr(el, "srcset"), "image", el);
        break;
      case "video":
      case "audio":
        ref(attr(el, "src"), "media", el);
        ref(attr(el, "poster"), "image", el);
        break;
      case "iframe":
        ref(attr(el, "src"), "other", el);
        break;
      case "a": {
        const href = attr(el, "href");
        if (href) ref(href, "page", el);
        if (attr(el, "target") === "_blank" && !/noopener|noreferrer/.test(attr(el, "rel") ?? "")) out.blankTargetsWithoutNoopener.push(ev(path, line, serializeOuter(el).slice(0, 200)));
        if (href && !textOf(el).trim() && !attr(el, "aria-label") && !attr(el, "aria-labelledby") && !el.childNodes.some((c) => isElement(c) && c.tagName === "img" && attr(c, "alt"))) {
          out.unnamedControls.push(ev(path, line, serializeOuter(el).slice(0, 200)));
        }
        break;
      }
      case "button":
        if (!textOf(el).trim() && !attr(el, "aria-label") && !attr(el, "aria-labelledby") && !attr(el, "title")) out.unnamedControls.push(ev(path, line, serializeOuter(el).slice(0, 200)));
        break;
      case "label": {
        const f = attr(el, "for");
        if (f) labelFor.add(f);
        break;
      }
    }
    if (CONTROL_TAGS.has(tag) && !(tag === "input" && UNLABELLED_INPUT_TYPES.has((attr(el, "type") ?? "text").toLowerCase()))) {
      controls.push({ el, insideLabel: ancestors.some((a) => a.tagName === "label") });
    }
    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      const level = Number(h[1]);
      if (level === 1) out.hasH1 = true;
      if (lastHeading && level > lastHeading + 1) out.headingSkips.push(ev(path, line, `h${lastHeading} followed by h${level}`));
      lastHeading = level;
    }

    const loc = el.sourceCodeLocation;
    if (!loc) return;
    // Layout blocks: compared by their exact markup across pages.
    if ((tag === "header" || tag === "nav" || tag === "footer") && !ancestors.some((a) => a.tagName === "header" || a.tagName === "nav" || a.tagName === "footer")) {
      const markup = serializeOuter(el);
      const cls = attr(el, "class");
      out.layoutBlocks.push({ tag, signature: hash(markup.replace(/\s+/g, " ")), label: cls ? `${tag}.${cls.split(/\s+/)[0]}` : tag, startLine: loc.startLine, endLine: loc.endLine, markup });
    }
    // Sections: identified by their class list, the closest thing static HTML
    // has to a component name. Unclassed sections cannot be matched across pages.
    if (tag === "section" && !ancestors.some((a) => a.tagName === "section")) {
      const cls = (attr(el, "class") ?? "").split(/\s+/).filter(Boolean).sort();
      if (cls.length) {
        const heading = (() => {
          let found = "";
          walk(el, (inner) => {
            if (!found && /^h[1-6]$/.test(inner.tagName)) found = excerpt(textOf(inner), 60);
          });
          return found;
        })();
        out.sections.push({ tag, signature: `section.${cls.join(".")}`, label: heading || cls[0], startLine: loc.startLine, endLine: loc.endLine, markup: serializeOuter(el) });
      }
    }
  });

  for (const { el, insideLabel } of controls) {
    const id = attr(el, "id");
    const named = insideLabel || (id && labelFor.has(id)) || attr(el, "aria-label") || attr(el, "aria-labelledby") || attr(el, "title");
    if (!named) out.unlabeledControls.push(ev(path, lineOf(el), serializeOuter(el).slice(0, 200)));
  }

  // The page's top-level structure, used to group pages that share a template.
  const body = (() => {
    let b: Element | null = null;
    walk(doc as unknown as Node, (el) => {
      if (!b && el.tagName === "body") b = el;
    });
    return b as Element | null;
  })();
  if (body) {
    const parts: string[] = [];
    const describe = (el: Element) => `${el.tagName}${attr(el, "class") ? `.${(attr(el, "class") ?? "").split(/\s+/)[0]}` : ""}`;
    for (const c of body.childNodes) {
      if (!isElement(c) || c.tagName === "script" || c.tagName === "noscript" || c.tagName === "style") continue;
      if (c.tagName === "main") parts.push(`main[${c.childNodes.filter(isElement).map(describe).join(",")}]`);
      else parts.push(describe(c));
    }
    out.skeleton = parts.join(" > ");
  }
  return out;
}

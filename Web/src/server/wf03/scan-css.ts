import type { Evidence } from "@/domain/source-analysis";
import { ev, lineIndex } from "./scan-util";

// Facts read from CSS text: custom properties, breakpoints, font faces,
// colours, families, keyframes and url() references. A regex scan, not a full
// CSS parser: it reads what is literally written (comments removed), which is
// what an evidence-backed fact needs, and it does not evaluate cascade or
// preprocessor logic - the report says so.

export type CssFacts = {
  customProperties: { name: string; value: string; line: number }[];
  breakpoints: { px: number; feature: "min-width" | "max-width"; e: Evidence }[];
  mediaQueries: number;
  containerQueries: number;
  reducedMotion: number;
  fontFaces: { family: string; weight: string | null; style: string | null; src: string[]; line: number }[];
  colors: string[];
  families: string[];
  keyframes: { name: string; line: number }[];
  transitions: number;
  urls: { ref: string; line: number; text: string }[];
};

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

export function scanCss(path: string, raw: string, lineOffset = 0): CssFacts {
  const text = stripComments(raw);
  const line = lineIndex(text);
  const at = (i: number) => line(i) + lineOffset;
  const out: CssFacts = {
    customProperties: [],
    breakpoints: [],
    mediaQueries: 0,
    containerQueries: 0,
    reducedMotion: 0,
    fontFaces: [],
    colors: [],
    families: [],
    keyframes: [],
    transitions: 0,
    urls: [],
  };

  for (const m of text.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/g)) {
    out.customProperties.push({ name: m[1], value: m[2].trim().slice(0, 200), line: at(m.index) });
  }
  for (const m of text.matchAll(/@media([^{]+)\{/g)) {
    out.mediaQueries++;
    if (/prefers-reduced-motion/.test(m[1])) out.reducedMotion++;
    for (const b of m[1].matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/g)) {
      const px = b[3] === "px" ? Number(b[2]) : Number(b[2]) * 16;
      out.breakpoints.push({ px, feature: `${b[1]}-width` as "min-width" | "max-width", e: ev(path, at(m.index), `@media${m[1]}`) });
    }
  }
  out.containerQueries = [...text.matchAll(/@container\b/g)].length;
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const family = /font-family\s*:\s*([^;]+)/.exec(body);
    out.fontFaces.push({
      family: family ? unquote(family[1]) : "(unnamed)",
      weight: /font-weight\s*:\s*([^;]+)/.exec(body)?.[1].trim() ?? null,
      style: /font-style\s*:\s*([^;]+)/.exec(body)?.[1].trim() ?? null,
      src: [...body.matchAll(/url\(\s*([^)]+?)\s*\)/g)].map((u) => unquote(u[1])),
      line: at(m.index),
    });
  }
  for (const m of text.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|(?:rgba?|hsla?)\([^)]*\)/g)) {
    // Skip hex in url() fragments and ids in selectors: a colour follows ":" or "," or space in a value.
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    if (m[0].startsWith("#") && !/[:\s,(]/.test(before)) continue;
    out.colors.push(m[0].toLowerCase().replace(/\s+/g, ""));
  }
  for (const m of text.matchAll(/font-family\s*:\s*([^;{}]+)/g)) {
    if (/@font-face\s*\{[^}]*$/.test(text.slice(Math.max(0, m.index - 400), m.index))) continue; // declared above
    const first = unquote(m[1].split(",")[0]);
    if (first && !first.startsWith("var(")) out.families.push(first);
  }
  for (const m of text.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g)) out.keyframes.push({ name: m[1], line: at(m.index) });
  out.transitions = [...text.matchAll(/(?:^|[;{\s])(?:transition|animation)(?:-[a-z]+)?\s*:/g)].length;
  for (const m of text.matchAll(/url\(\s*([^)]+?)\s*\)/g)) out.urls.push({ ref: unquote(m[1]), line: at(m.index), text: m[0] });
  for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)) out.urls.push({ ref: m[1], line: at(m.index), text: m[0] });
  return out;
}

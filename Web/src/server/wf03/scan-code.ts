import type { Evidence } from "@/domain/source-analysis";
import { ev, extOf, lineIndex } from "./scan-util";

// Facts read from script files: imports, exported components, risky calls,
// licence banners, and whether a file is a minified bundle.

export type CodeFacts = {
  imports: { spec: string; line: number }[];
  componentNames: string[];
  risky: { kind: "eval" | "new-function" | "document-write"; e: Evidence }[];
  banners: { line: number; text: string }[];
  minified: boolean;
};

const IMPORT_RE = /(?:\bimport\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*|\bexport\s+[^'";]*?\s+from\s+)['"]([^'"\n]+)['"]/g;

export function scanCode(path: string, text: string): CodeFacts {
  const line = lineIndex(text);
  const lines = text.split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  // Hand-written code has short lines; a long file made of a few huge lines is a build product.
  const minified = text.length > 5000 && longest > 1000 && text.length / lines.length > 300;

  const imports: CodeFacts["imports"] = [];
  for (const m of text.matchAll(IMPORT_RE)) imports.push({ spec: m[1], line: line(m.index) });

  const names = new Set<string>();
  const ext = extOf(path);
  if (["vue", "svelte", "astro"].includes(ext)) {
    const base = path.split("/").pop()!.replace(/\.[^.]+$/, "");
    if (/^[A-Z]/.test(base) || /(^|\/)components\//.test(path)) names.add(base);
  } else if (["jsx", "tsx"].includes(ext) || (/(^|\/)components\//.test(path) && ["js", "ts"].includes(ext))) {
    for (const m of text.matchAll(/export\s+default\s+(?:async\s+)?function\s+([A-Z]\w*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]\w*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/export\s+const\s+([A-Z]\w*)\s*[:=]/g)) names.add(m[1]);
    const def = /export\s+default\s+([A-Z]\w*)\s*;?\s*$/m.exec(text);
    if (def) names.add(def[1]);
  }

  const risky: CodeFacts["risky"] = [];
  const pushRisk = (kind: CodeFacts["risky"][number]["kind"], re: RegExp) => {
    for (const m of text.matchAll(re)) risky.push({ kind, e: ev(path, line(m.index), text.slice(Math.max(0, m.index - 30), m.index + 50)) });
  };
  pushRisk("eval", /(?<![\w.$])eval\s*\(/g);
  pushRisk("new-function", /\bnew\s+Function\s*\(/g);
  pushRisk("document-write", /\bdocument\.write(?:ln)?\s*\(/g);

  const banners: CodeFacts["banners"] = [];
  for (const m of text.matchAll(/\/\*[!*]?[\s*]*([\s\S]{0,600}?)\*\//g)) {
    const body = m[1];
    if (!/@license|\blicen[cs]e\b|copyright|\(c\)|©/i.test(body)) continue;
    const first = body
      .split("\n")
      .map((s) => s.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
    banners.push({ line: line(m.index), text: first.slice(0, 200) });
    if (banners.length >= 20) break;
  }
  return { imports, componentNames: [...names].sort(), risky, banners, minified };
}

// Next.js file-system routes, from a path relative to the archive root.
export function nextRoute(path: string): { route: string; origin: "next_app" | "next_pages"; dynamic: boolean } | null {
  const app = /^(?:src\/)?app\/(.*?)\/?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(path) ?? /^(?:src\/)?app\/()page\.(?:tsx|jsx|ts|js|mdx)$/.exec(path);
  if (app) {
    const segs = app[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return { route: `/${segs.join("/")}`, origin: "next_app", dynamic: segs.some((s) => s.startsWith("[")) };
  }
  const pages = /^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|mdx)$/.exec(path);
  if (pages) {
    const p = pages[1];
    if (/^(_app|_document|_error|404|500)$/.test(p) || p.startsWith("api/")) return null;
    const segs = p.split("/").filter((s) => s !== "index");
    return { route: `/${segs.join("/")}`, origin: "next_pages", dynamic: segs.some((s) => s.startsWith("[")) };
  }
  return null;
}

// Resolves a relative import to a file in the archive, trying the usual
// extensions and index files. Bare package names return null.
export function resolveImport(from: string, spec: string, exists: (p: string) => boolean): string | null {
  let base: string[];
  if (spec.startsWith(".")) base = from.split("/").slice(0, -1);
  else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    spec = spec.slice(2);
    base = [];
    for (const root of ["src/", ""]) {
      const r = resolveImport(`${root}x`, `./${spec}`, exists);
      if (r) return r;
    }
    return null;
  } else return null;
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  const p = base.join("/");
  const candidates = [p, ...["tsx", "ts", "jsx", "js", "mjs", "vue", "svelte", "astro", "css", "scss"].map((e) => `${p}.${e}`), ...["tsx", "ts", "jsx", "js"].map((e) => `${p}/index.${e}`)];
  return candidates.find(exists) ?? null;
}

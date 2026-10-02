import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { compose } from "./composition";
import { attr, elementsOf, escapeHtml, parseDocument, tokenKeys } from "./markup";
import { getPath, listFiles, pageIds, readComponent, readComposition, readJson, readPage, renderOrder, sectionScope, skeletonFile, writeJson } from "./model";

// Web's checks of the current template (after edits), run on a build made
// with the template's own build.mjs into a separate folder:
//   load          every page's route was built
//   assets        every local file a page or stylesheet refers to exists
//   links         internal links lead to built pages
//   sections      the page's sections appear in the composition's order
//   duplicateIds  no id appears twice on a page
//   content       content values appear in the built page
//   tokens        every design token used without a fallback is defined
//   external      references to other sites (blocked in previews)
// These are file-level checks. Browser checks (screenshots, console,
// interactions) are made by the generator at generation time and by Web's
// end-to-end tests; they are not repeated here.

type Ref = { ref: string; from: string };
export type PageCheck = {
  page: string;
  route: string;
  load: boolean;
  missingAssets: Ref[];
  brokenLinks: Ref[];
  external: string[];
  duplicateIds: string[];
  sections: { passed: boolean; expected: string[]; rendered: string[] };
  content: { checked: number; missing: { section: string; field: string }[] };
  undefinedTokens: string[];
  passed: boolean;
};
export type Verification = { at: string; build: { ok: boolean; error: string | null }; pages: PageCheck[]; summary: { pages: number; passed: number; failed: number }; note: string };

const ASSET_ATTRS: Record<string, string[]> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  script: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  iframe: ["src"],
  embed: ["src"],
  object: ["data"],
  input: ["src"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};
const ASSET_RELS = /\b(stylesheet|icon|apple-touch-icon|preload|modulepreload|manifest|mask-icon)\b/i;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;

type Resolved = { kind: "skip" } | { kind: "external"; url: string } | { kind: "local"; path: string };
function resolveRef(ref: string, from: string): Resolved {
  const r = ref.trim();
  if (!r || r.startsWith("#") || /^(data|blob|mailto|tel|javascript|about|sms):/i.test(r)) return { kind: "skip" };
  if (/^(https?:)?\/\//i.test(r)) return { kind: "external", url: r };
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return { kind: "skip" };
  try {
    const u = new URL(r, `http://template.invalid/${from}`);
    return { kind: "local", path: decodeURIComponent(u.pathname).replace(/^\/+/, "") };
  } catch {
    return { kind: "local", path: r };
  }
}
function existsIn(out: string, path: string): boolean {
  const p = join(out, path);
  if (!p.startsWith(out)) return false;
  if (path === "" || path.endsWith("/")) return existsSync(join(p, "index.html"));
  if (!existsSync(p)) return false;
  return statSync(p).isDirectory() ? existsSync(join(p, "index.html")) : true;
}
const srcsetUrls = (v: string) => v.split(/\s*,\s*(?=\S)/).map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);

/** Local references of one HTML file: assets (incl. url() in styles) and links. */
function htmlRefs(html: string) {
  const doc = parseDocument(html);
  const assets: string[] = [];
  const links: string[] = [];
  const ids: string[] = [];
  const sections: string[] = [];
  for (const el of elementsOf(doc)) {
    const tag = el.tagName;
    for (const a of ASSET_ATTRS[tag] ?? []) {
      const v = attr(el, a);
      if (v) assets.push(...(a === "srcset" ? srcsetUrls(v) : [v]));
    }
    if (tag === "link") {
      const href = attr(el, "href");
      if (href && ASSET_RELS.test(attr(el, "rel") ?? "")) assets.push(href);
    }
    if (tag === "a" || tag === "area") {
      const href = attr(el, "href");
      if (href) links.push(href);
    }
    const style = attr(el, "style");
    if (style) for (const m of style.matchAll(CSS_URL)) assets.push(m[2] ?? m[4]);
    if (tag === "style") for (const n of el.childNodes) if ("value" in n) for (const m of String(n.value).matchAll(CSS_URL)) assets.push(m[2] ?? m[4]);
    const id = attr(el, "id");
    if (id) ids.push(id);
    const sec = attr(el, "data-sar-section");
    if (sec) sections.push(sec);
  }
  return { assets, links, ids, sections };
}

/** Missing local files referenced by the built pages and stylesheets. */
export function missingAssets(out: string): Ref[] {
  if (!existsSync(out)) return [];
  const missing: Ref[] = [];
  for (const f of listFiles(out)) {
    let refs: string[] = [];
    if (f.endsWith(".html")) refs = htmlRefs(readFileSync(join(out, f), "utf8")).assets;
    else if (f.endsWith(".css")) refs = [...readFileSync(join(out, f), "utf8").matchAll(CSS_URL)].map((m) => m[2] ?? m[4]);
    else continue;
    for (const ref of refs) {
      const r = resolveRef(ref, f);
      if (r.kind === "local" && !existsIn(out, r.path) && !missing.some((m) => m.ref === ref && m.from === f)) missing.push({ ref, from: f });
    }
  }
  return missing;
}

const interpolate = (v: string, config: unknown) => v.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (m, p: string) => {
  const x = getPath(config, p);
  return x == null || typeof x === "object" ? m : String(x);
});
function leaves(v: unknown, prefix: string, out: { path: string; value: string }[] = []) {
  if (typeof v === "string") out.push({ path: prefix, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${prefix}.${i}`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export function checkBuild(t: string, out: string): PageCheck[] {
  const config = existsSync(join(t, "site.config.json")) ? readJson<unknown>(join(t, "site.config.json")) : {};
  const brandCss = existsSync(join(out, "brand", "brand.css")) ? readFileSync(join(out, "brand", "brand.css"), "utf8") : "";
  const defined = new Set([...brandCss.matchAll(/(--sar-[\w-]+)\s*:/g)].map((m) => m[1]));
  const cssText = listFiles(out).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
  const missingAll = missingAssets(out);

  return pageIds(t).map((id) => {
    const p = readPage(t, id);
    const file = join(out, p.route);
    const empty: PageCheck = { page: id, route: p.route, load: false, missingAssets: [], brokenLinks: [], external: [], duplicateIds: [], sections: { passed: false, expected: [], rendered: [] }, content: { checked: 0, missing: [] }, undefinedTokens: [], passed: false };
    if (!existsSync(file)) return empty;
    const html = readFileSync(file, "utf8");
    const refs = htmlRefs(html);
    const brokenLinks: Ref[] = [];
    const external = new Set<string>();
    for (const ref of refs.assets) {
      const r = resolveRef(ref, p.route);
      if (r.kind === "external") external.add(r.url);
    }
    for (const ref of refs.links) {
      const r = resolveRef(ref, p.route);
      if (r.kind === "local" && !existsIn(out, r.path)) brokenLinks.push({ ref, from: p.route });
    }
    const pageCss = new Set(refs.assets.map((r) => resolveRef(r, p.route)).flatMap((r) => (r.kind === "local" && r.path.endsWith(".css") ? [r.path] : [])));
    const counts = new Map<string, number>();
    for (const i of refs.ids) counts.set(i, (counts.get(i) ?? 0) + 1);
    const c = readComposition(t, id);
    const expected = c && existsSync(skeletonFile(t, id)) ? renderOrder(c, readFileSync(skeletonFile(t, id), "utf8")) : p.sections.map((s) => s.id);
    const rendered = refs.sections;
    const sectionsPassed = c ? expected.length === rendered.length && expected.every((x, i) => x === rendered[i]) : expected.every((x) => rendered.includes(x));

    // Content: each text value a section's markup uses should appear in the page.
    const missing: { section: string; field: string }[] = [];
    let checked = 0;
    for (const sid of new Set(expected)) {
      const s = p.sections.find((x) => x.id === sid);
      if (!s) continue;
      let used: Set<string>;
      try {
        used = tokenKeys(readComponent(t, s.component));
      } catch {
        continue;
      }
      for (const leaf of leaves(sectionScope(t, id, s), "")) {
        const key = leaf.path.split(".").pop()!;
        if (!used.has(leaf.path.split(".")[0]) || ["href", "src", "srcset", "poster"].includes(key) || leaf.value.includes("<") || leaf.value.trim().length < 2) continue;
        checked++;
        if (!html.includes(escapeHtml(interpolate(leaf.value, config)))) missing.push({ section: sid, field: leaf.path });
      }
    }
    const used = new Set([...(html + cssText).matchAll(/var\(\s*(--sar-[\w-]+)\s*\)/g)].map((m) => m[1]));
    const undefinedTokens = [...used].filter((v) => !defined.has(v));
    const check: PageCheck = {
      page: id,
      route: p.route,
      load: true,
      missingAssets: missingAll.filter((m) => m.from === p.route || pageCss.has(m.from)),
      brokenLinks,
      external: [...external],
      duplicateIds: [...counts].filter(([, n]) => n > 1).map(([k]) => k),
      sections: { passed: sectionsPassed, expected, rendered },
      content: { checked, missing },
      undefinedTokens,
      passed: false,
    };
    check.passed = check.missingAssets.length === 0 && brokenLinks.length === 0 && check.duplicateIds.length === 0 && sectionsPassed && missing.length === 0 && undefinedTokens.length === 0;
    return check;
  });
}

/**
 * Composes and builds the template into <out> with its own build.mjs, then
 * checks it. Only call this for a template whose runtime has been verified.
 */
export function verifyTemplate(t: string, out: string, reportFile: string): Verification {
  let build: Verification["build"] = { ok: true, error: null };
  try {
    compose(t);
    rmSync(out, { recursive: true, force: true });
    const r = spawnSync(process.execPath, ["build.mjs", "--out", out], { cwd: t, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv });
    if (r.status !== 0) build = { ok: false, error: `The template's build failed (exit ${r.status ?? r.signal}): ${`${r.stdout}${r.stderr}`.trim().split("\n").slice(-6).join("\n").slice(0, 1500)}` };
  } catch (e) {
    build = { ok: false, error: (e as Error).message };
  }
  const pages = build.ok ? checkBuild(t, out) : [];
  const v: Verification = {
    at: new Date().toISOString(),
    build,
    pages,
    summary: { pages: pages.length, passed: pages.filter((p) => p.passed).length, failed: pages.filter((p) => !p.passed).length },
    note: "File-level checks of the current template. Screenshots, console errors and interactions were checked by the generator when the template was generated, and are covered by Web's end-to-end tests; they are not repeated here.",
  };
  writeJson(reportFile, v);
  return v;
}

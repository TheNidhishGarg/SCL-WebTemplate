import { createHash } from "node:crypto";
import {
  ANALYZER_VERSION,
  SOURCE_ANALYSIS_SCHEMA,
  SourceAnalysis,
  type Evidence,
  type FileKind,
  type Question,
  type Risk,
  type TemplateCandidate,
} from "@/domain/source-analysis";
import { readArchive, type ArchiveLimits, DEFAULT_LIMITS, type SourceFile } from "./archive";
import { nextRoute, resolveImport, scanCode, type CodeFacts } from "./scan-code";
import { scanCss, type CssFacts } from "./scan-css";
import { scanHtml, type HtmlFacts } from "./scan-html";
import { byString, ev, isTextKind, kindOf, lineIndex, mask, resolveRef, SECRET_PATTERNS, Tally } from "./scan-util";

// WF-03 scanner: archive in, SourceAnalysis out. Pure and deterministic -
// the same bytes always give the same report and digest. It states what is in
// the files, cites where, and marks every conclusion that goes beyond the
// files as inferred. What it cannot know becomes a question, never a guess.

export type ScanOutput = { analysis: SourceAnalysis; digest: string };

const decoder = new TextDecoder("utf-8", { fatal: false });

// Each library is recognised by its package name, its API in code, or its
// own CDN file name - never by another library's evidence.
const LIBRARIES: { name: string; pkg: RegExp; text: RegExp | null; url: RegExp | null }[] = [
  { name: "GSAP", pkg: /^gsap$|^@gsap\//, text: /\bgsap\.(?:to|from|timeline|registerPlugin)\b/, url: /\/gsap(?:@[^/]+)?\/(?:dist\/)?gsap(?:\.min)?\.js/i },
  { name: "GSAP ScrollTrigger", pkg: /^$/, text: /\bScrollTrigger\b/, url: /ScrollTrigger(?:\.min)?\.js/i },
  { name: "Lenis smooth scroll", pkg: /^(@studio-freight\/)?lenis$|^lenis$/, text: /\bnew Lenis\(/, url: /lenis(?:\.min)?\.js|\/lenis@/i },
  { name: "Locomotive Scroll", pkg: /^locomotive-scroll$/, text: /\bLocomotiveScroll\b/, url: /locomotive-scroll/i },
  { name: "Framer Motion", pkg: /^(framer-motion|motion)$/, text: null, url: null },
  { name: "Swiper", pkg: /^swiper$/, text: /\bnew Swiper\(/, url: /swiper(?:-bundle)?(?:\.min)?\.js|\/swiper@/i },
  { name: "Lottie", pkg: /^(lottie-web|@lottiefiles\/.*)$/, text: /\blottie\.loadAnimation\b/, url: /lottie(?:\.min)?\.js|\/lottie-web@/i },
  { name: "three.js", pkg: /^three$/, text: /\bTHREE\.(?:Scene|WebGLRenderer)\b/, url: /\/three(?:@[^/]+)?\/build\/three|three(?:\.module)?(?:\.min)?\.js/i },
  { name: "Barba.js page transitions", pkg: /^@barba\/core$/, text: /\bbarba\.init\(/, url: /barba(?:\.umd)?(?:\.min)?\.js|\/@barba\//i },
  { name: "AOS scroll animations", pkg: /^aos$/, text: /\bAOS\.init\(/, url: /\/aos(?:@[^/]+)?\/dist\/aos/i },
  { name: "jQuery", pkg: /^jquery$/, text: null, url: /jquery(?:-[\d.]+)?(?:\.min)?\.js|\/jquery@/i },
];

const FRAMEWORK_PKGS: [string, string][] = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["nuxt", "Nuxt"],
  ["svelte", "Svelte"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["gatsby", "Gatsby"],
  ["@angular/core", "Angular"],
  ["vite", "Vite"],
  ["tailwindcss", "Tailwind CSS"],
  ["bootstrap", "Bootstrap"],
];
const CONFIG_FILES: [RegExp, string][] = [
  [/^next\.config\.(js|mjs|ts|cjs)$/, "Next.js"],
  [/^nuxt\.config\.(js|ts|mjs)$/, "Nuxt"],
  [/^astro\.config\.(js|mjs|ts)$/, "Astro"],
  [/^svelte\.config\.(js|mjs)$/, "SvelteKit"],
  [/^vite\.config\.(js|mjs|ts)$/, "Vite"],
  [/^tailwind\.config\.(js|cjs|mjs|ts)$/, "Tailwind CSS"],
  [/^gatsby-config\.(js|ts)$/, "Gatsby"],
  [/^angular\.json$/, "Angular"],
];
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const LICENSE_FILE = /(^|\/)(LICEN[CS]E|COPYING|NOTICE)(\.[a-z]+)?$/i;
const LICENSE_KINDS: [RegExp, string][] = [
  [/\bMIT License\b|Permission is hereby granted, free of charge/i, "MIT"],
  [/Apache License,?\s+Version 2\.0/i, "Apache-2.0"],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "AGPL"],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, "LGPL"],
  [/GNU GENERAL PUBLIC LICENSE/i, "GPL"],
  [/SIL OPEN FONT LICENSE/i, "OFL-1.1"],
  [/Redistribution and use in source and binary forms/i, "BSD-style"],
  [/Mozilla Public License/i, "MPL-2.0"],
  [/THE SOFTWARE IS PROVIDED "AS IS"|ISC License/i, "ISC/MIT-style"],
];

const top = <T>(m: Map<T, number>, n: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1)).slice(0, n);

export function analyzeArchive(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): ScanOutput {
  const archive = readArchive(bytes, limits);
  return analyzeFiles(archive.files, {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    rootPrefix: archive.rootPrefix,
    skipped: archive.skipped,
  });
}

export function analyzeFiles(
  files: SourceFile[],
  meta: { sha256: string; sizeBytes: number; rootPrefix: string; skipped: { path: string; reason: string }[] },
): ScanOutput {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const has = (p: string) => byPath.has(p);
  const text = new Map<string, string>();
  for (const f of files) if (isTextKind(kindOf(f.path), f.path)) text.set(f.path, decoder.decode(f.bytes));

  // A reference may point at a file under public/ (frameworks serve it at /),
  // or - in a multi-host capture - under the referencing file's host folder.
  const locate = (from: string, raw: string): { type: "local"; path: string; found: boolean } | { type: "external"; url: string } | null => {
    const r = resolveRef(from, raw);
    if (r.type === "ignored") return null;
    if (r.type === "external") return r;
    const tries = [r.path, `public/${r.path}`];
    if (raw.trim().startsWith("/") && from.includes("/")) tries.push(`${from.split("/")[0]}/${r.path}`);
    const hit = tries.find(has);
    return { type: "local", path: hit ?? r.path, found: Boolean(hit) };
  };

  const html = new Map<string, HtmlFacts>();
  const css = new Map<string, CssFacts>();
  const code = new Map<string, CodeFacts>();
  const cssExtra: { owner: string; facts: CssFacts }[] = [];
  const inlineCode: { owner: string; facts: CodeFacts; lineOffset: number }[] = [];

  for (const [path, t] of text) {
    const k = kindOf(path);
    if (k === "html") {
      const h = scanHtml(path, t);
      html.set(path, h);
      for (const s of h.inlineStyles) cssExtra.push({ owner: path, facts: scanCss(path, s.text, s.line - 1) });
      for (const s of h.inlineScripts) inlineCode.push({ owner: path, facts: scanCode(path, s.text), lineOffset: s.line - 1 });
    } else if (k === "css") css.set(path, scanCss(path, t));
    else if (k === "script") code.set(path, scanCode(path, t));
  }

  // ------------------------------------------------------------ references
  const referencedBy = new Map<string, Set<string>>();
  const missing = new Tally();
  const missingPages = new Tally();
  const external = new Map<string, { kind: SourceAnalysis["externalResources"][number]["kind"]; integrity: boolean; evidence: Evidence[] }>();
  const noteRef = (from: string, raw: string, kind: string, e: Evidence, integrity = false) => {
    const r = locate(from, raw);
    if (!r) return;
    if (r.type === "external") {
      const k = kind === "page" ? null : (kind as SourceAnalysis["externalResources"][number]["kind"]);
      if (!k) return; // outbound links are not resources
      const entry = external.get(r.url) ?? { kind: k === ("media" as string) ? "media" : k, integrity, evidence: [] };
      entry.integrity = entry.integrity && integrity;
      if (entry.evidence.length < 5) entry.evidence.push(e);
      external.set(r.url, entry);
      return;
    }
    if (kind === "page") {
      const candidates = [r.path, `${r.path}.html`, `${r.path}/index.html`, `${r.path.replace(/\/$/, "")}/index.html`];
      if (r.path === "" || candidates.some(has)) return;
      if (/\.[a-z0-9]{2,5}$/i.test(r.path) && !/\.html?$/i.test(r.path)) {
        if (!r.found) missing.add(r.path, e);
        else referencedBy.set(r.path, (referencedBy.get(r.path) ?? new Set()).add(from));
        return;
      }
      missingPages.add(`/${r.path}`, e);
      return;
    }
    if (!r.found) missing.add(r.path, e);
    else referencedBy.set(r.path, (referencedBy.get(r.path) ?? new Set()).add(from));
  };
  for (const [path, h] of html) for (const r of h.refs) noteRef(path, r.ref, r.kind, r.e, r.integrity);
  const cssRefs = (owner: string, f: CssFacts) => {
    for (const u of f.urls) noteRef(owner, u.ref, /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u.ref) ? "font" : /\.css(\?|$)/i.test(u.ref) ? "stylesheet" : "image", ev(owner, u.line, u.text));
  };
  for (const [path, f] of css) cssRefs(path, f);
  for (const { owner, facts } of cssExtra) cssRefs(owner, facts);

  // Import graph: which files import which.
  const importedBy = new Map<string, Set<string>>();
  const importsOf = new Map<string, string[]>();
  for (const [path, c] of code) {
    const local: string[] = [];
    for (const imp of c.imports) {
      const target = resolveImport(path, imp.spec, has);
      if (target) {
        local.push(target);
        importedBy.set(target, (importedBy.get(target) ?? new Set()).add(path));
        referencedBy.set(target, (referencedBy.get(target) ?? new Set()).add(path));
      }
    }
    importsOf.set(path, [...new Set(local)].sort());
  }
  const closure = (start: string, max = 50) => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length && seen.size < max) {
      for (const n of importsOf.get(queue.shift()!) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return [...seen].sort();
  };

  // ------------------------------------------------------------ package.json
  const dependencies: SourceAnalysis["dependencies"] = [];
  const declared = new Map<string, { version: string; path: string }>();
  const pkgLicenses: { path: string; license: string }[] = [];
  for (const [path, t] of text) {
    if (!/(^|\/)package\.json$/.test(path)) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(t);
    } catch {
      continue;
    }
    for (const scope of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const deps = pkg[scope];
      if (deps && typeof deps === "object") {
        for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
          dependencies.push({ name, version: String(version), scope, path });
          if (!declared.has(name)) declared.set(name, { version: String(version), path });
        }
      }
    }
    if (typeof pkg.license === "string") pkgLicenses.push({ path, license: pkg.license });
  }
  for (const url of external.keys()) {
    const m =
      /cdn\.jsdelivr\.net\/(?:npm|gh)\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/.exec(url) ??
      /unpkg\.com\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/.exec(url) ??
      /cdnjs\.cloudflare\.com\/ajax\/libs\/([^/]+)\/([^/]+)\//.exec(url);
    if (m) dependencies.push({ name: m[1], version: m[2], scope: "cdn", path: url });
  }
  dependencies.sort(byString((d) => `${d.scope}\u0000${d.name}\u0000${d.path}`));

  // ------------------------------------------------------------ frameworks
  const frameworks: SourceAnalysis["frameworks"] = [];
  const fw = (name: string, version: string | null, basis: "observed" | "inferred", rationale: string, evidence: Evidence[]) => {
    const existing = frameworks.find((f) => f.name === name);
    if (existing) {
      if (existing.basis === "inferred" && basis === "observed") Object.assign(existing, { basis, rationale, version });
      if (existing.evidence.length < 5) existing.evidence.push(...evidence.slice(0, 5 - existing.evidence.length));
      return;
    }
    frameworks.push({ name, version, basis, rationale, evidence });
  };
  for (const [pkgName, label] of FRAMEWORK_PKGS) {
    const d = declared.get(pkgName);
    if (d) fw(label, d.version, "observed", `Declared as a dependency in ${d.path}.`, [ev(d.path, null, `"${pkgName}": "${d.version}"`)]);
  }
  for (const f of files) {
    const name = f.path.split("/").pop()!;
    for (const [re, label] of CONFIG_FILES) if (re.test(name)) fw(label, declared.get(label.toLowerCase())?.version ?? null, "observed", `Configuration file ${f.path} is present.`, [ev(f.path)]);
  }
  for (const [path, h] of html) {
    if (h.generator) fw(h.generator.split(/\s/)[0], h.generator.split(/\s/)[1] ?? null, "observed", `The page declares its generator: "${h.generator}".`, [ev(path, null, `<meta name="generator" content="${h.generator}">`)]);
    const nextMarker = h.markers.find((m) => m.name === "next-data") ?? h.refs.find((r) => r.ref.includes("/_next/static/"));
    if (nextMarker) fw("Next.js", null, "inferred", "Built output contains Next.js markers (__NEXT_DATA__ or /_next/static/); the source itself is not in the archive.", [nextMarker.e]);
    const wf = h.markers.find((m) => m.name === "webflow");
    if (wf) fw("Webflow", null, "inferred", "Markup carries Webflow data attributes.", [wf.e]);
    const fr = h.markers.find((m) => m.name === "framer");
    if (fr) fw("Framer", null, "inferred", "Markup carries Framer data attributes.", [fr.e]);
    const wp = h.refs.find((r) => r.ref.includes("/wp-content/") || r.ref.includes("/wp-includes/"));
    if (wp) fw("WordPress", null, "inferred", "References WordPress asset paths (wp-content / wp-includes).", [wp.e]);
  }
  frameworks.sort(byString((f) => f.name));

  // ------------------------------------------------------------ routes
  const routes: SourceAnalysis["routes"] = [];
  for (const f of files) {
    const r = nextRoute(f.path);
    if (r) routes.push({ ...r, file: f.path });
  }
  for (const path of html.keys()) {
    const route = `/${path.replace(/(^|\/)index\.html?$/i, "").replace(/\.html?$/i, "")}`.replace(/\/$/, "") || "/";
    routes.push({ route, file: path, origin: "html", dynamic: false });
  }
  routes.sort(byString((r) => `${r.route}\u0000${r.file}`));

  // ------------------------------------------------------------ components
  const components: SourceAnalysis["components"] = [];
  for (const [path, c] of code) {
    const kind = path.endsWith(".vue") ? "vue" : path.endsWith(".svelte") ? "svelte" : path.endsWith(".astro") ? "astro" : "react";
    for (const name of c.componentNames) components.push({ name, file: path, kind, usedBy: [...(importedBy.get(path) ?? [])].sort() });
  }
  components.sort(byString((c) => `${c.file}\u0000${c.name}`));

  // ------------------------------------------------------------ templates
  const candidates: TemplateCandidate[] = [];
  const stylesheetsOf = (page: string) =>
    (html.get(page)?.refs ?? [])
      .filter((r) => r.kind === "stylesheet")
      .map((r) => locate(page, r.ref))
      .flatMap((r) => (r && r.type === "local" && r.found ? [r.path] : []));
  for (const f of files) {
    const m = /^(?:src\/)?app\/(.*?)\/?layout\.(?:tsx|jsx|ts|js)$/.exec(f.path) ?? /^(?:src\/)?app\/()layout\.(?:tsx|jsx|ts|js)$/.exec(f.path);
    if (m) {
      candidates.push({ key: `next-layout:${f.path}`, kind: "layout", name: `Layout ${m[1] ? `/${m[1]}` : "(root)"}`, basis: "observed", rationale: "A Next.js layout file: by framework convention it wraps every page beneath it.", files: closure(f.path), pages: [], evidence: [ev(f.path)] });
    }
  }
  for (const r of routes) {
    if (r.dynamic) {
      candidates.push({ key: `route-template:${r.file}`, kind: "page_template", name: `Page template ${r.route}`, basis: "inferred", rationale: "A dynamic route renders one page per parameter value, so it acts as a template; which values exist is not in the source.", files: closure(r.file), pages: [r.route], evidence: [ev(r.file)] });
    }
  }
  for (const c of components) {
    if (c.usedBy.length < 2) continue;
    const kind = /nav|menu|header/i.test(c.name) ? "navigation" : /footer|layout|shell/i.test(c.name) ? "layout" : "component";
    candidates.push({ key: `component:${c.file}:${c.name}`, kind, name: c.name, basis: "inferred", rationale: `Imported by ${c.usedBy.length} files, so likely reusable.`, files: closure(c.file), pages: [], evidence: c.usedBy.slice(0, 10).map((u) => ev(u)) });
  }
  const pages = [...html.keys()].sort();
  const single = pages.length === 1;
  const groupBlocks = (pick: (h: HtmlFacts) => HtmlFacts["sections"], kindFor: (tag: string) => TemplateCandidate["kind"], prefix: string) => {
    const groups = new Map<string, { label: string; tag: string; occurrences: { page: string; startLine: number }[] }>();
    for (const page of pages) {
      for (const b of pick(html.get(page)!)) {
        const g = groups.get(b.signature) ?? { label: b.label, tag: b.tag, occurrences: [] };
        if (!g.occurrences.some((o) => o.page === page)) g.occurrences.push({ page, startLine: b.startLine });
        groups.set(b.signature, g);
      }
    }
    for (const [sig, g] of [...groups.entries()].sort(byString(([s]) => s))) {
      const n = g.occurrences.length;
      if (n < 2 && !single) continue;
      const exact = prefix === "block";
      candidates.push({
        key: `${prefix}:${sig}`,
        kind: kindFor(g.tag),
        name: g.label,
        basis: exact && n >= 2 ? "observed" : "inferred",
        rationale:
          n >= 2
            ? exact
              ? `Identical markup on ${n} pages.`
              : `The same class list on ${n} pages; markup may differ between them.`
            : "On the only page in the source; reuse is not demonstrated.",
        files: [...new Set(g.occurrences.flatMap((o) => [o.page, ...stylesheetsOf(o.page)]))].sort(),
        pages: g.occurrences.map((o) => o.page),
        evidence: g.occurrences.slice(0, 10).map((o) => ev(o.page, o.startLine, g.label)),
      });
    }
  };
  groupBlocks((h) => h.layoutBlocks, (tag) => (tag === "footer" ? "layout" : "navigation"), "block");
  groupBlocks((h) => h.sections, () => "section", "section");
  const skeletons = new Map<string, string[]>();
  for (const page of pages) {
    const s = html.get(page)!.skeleton;
    if (s) skeletons.set(s, [...(skeletons.get(s) ?? []), page]);
  }
  for (const [s, ps] of [...skeletons.entries()].sort(byString(([k]) => k))) {
    if (ps.length < 2) continue;
    const id = createHash("sha256").update(s).digest("hex").slice(0, 12);
    candidates.push({ key: `page-skeleton:${id}`, kind: "page_template", name: `Page layout shared by ${ps.length} pages`, basis: "inferred", rationale: `These pages have the same top-level structure (${s.slice(0, 160)}).`, files: [...new Set(ps.flatMap((p) => [p, ...stylesheetsOf(p)]))].sort(), pages: ps, evidence: ps.slice(0, 10).map((p) => ev(p)) });
  }
  candidates.sort(byString((c) => `${c.kind}\u0000${c.key}`));

  // ------------------------------------------------------------ styles
  const allCss: { owner: string; f: CssFacts }[] = [...[...css.entries()].map(([owner, f]) => ({ owner, f })), ...cssExtra.map((x) => ({ owner: x.owner, f: x.facts }))];
  const colorCount = new Map<string, number>();
  const familyCount = new Map<string, number>();
  const bp = new Map<string, { px: number; feature: "min-width" | "max-width"; count: number; evidence: Evidence[] }>();
  const customProperties: SourceAnalysis["styles"]["customProperties"] = [];
  const fontFaces: SourceAnalysis["styles"]["fontFaces"] = [];
  const keyframes: SourceAnalysis["styles"]["keyframes"] = [];
  let mediaQueries = 0,
    containerQueries = 0,
    reducedMotion = 0,
    transitions = 0;
  for (const { owner, f } of allCss) {
    for (const c of f.colors) colorCount.set(c, (colorCount.get(c) ?? 0) + 1);
    for (const fam of f.families) familyCount.set(fam, (familyCount.get(fam) ?? 0) + 1);
    for (const b of f.breakpoints) {
      const key = `${b.feature}:${b.px}`;
      const e = bp.get(key) ?? { px: b.px, feature: b.feature, count: 0, evidence: [] };
      e.count++;
      if (e.evidence.length < 5) e.evidence.push(b.e);
      bp.set(key, e);
    }
    for (const p of f.customProperties) customProperties.push({ ...p, path: owner });
    for (const ff of f.fontFaces) fontFaces.push({ ...ff, path: owner });
    for (const k of f.keyframes) keyframes.push({ ...k, path: owner });
    mediaQueries += f.mediaQueries;
    containerQueries += f.containerQueries;
    reducedMotion += f.reducedMotion;
    transitions += f.transitions;
  }
  // Google Fonts are declared by a <link>, not @font-face; record each family once.
  const googleSeen = new Set<string>();
  for (const [path, h] of html) {
    for (const fam of h.googleFontFamilies) {
      if (googleSeen.has(fam)) continue;
      googleSeen.add(fam);
      fontFaces.push({ family: fam, weight: null, style: null, src: ["https://fonts.googleapis.com"], path, line: 1 });
    }
  }

  // ------------------------------------------------------------ assets
  const ASSET_KINDS: FileKind[] = ["image", "font", "video", "audio"];
  const assets = files
    .filter((f) => ASSET_KINDS.includes(kindOf(f.path)))
    .map((f) => ({ path: f.path, kind: kindOf(f.path), sizeBytes: f.sizeBytes, sha256: f.sha256, referencedBy: [...(referencedBy.get(f.path) ?? [])].sort() }));

  // ------------------------------------------------------------ licences
  const licenses: SourceAnalysis["licenses"] = [];
  for (const f of files) {
    if (!LICENSE_FILE.test(f.path)) continue;
    const t = text.get(f.path) ?? "";
    const id = LICENSE_KINDS.find(([re]) => re.test(t))?.[1] ?? null;
    licenses.push({ path: f.path, identified: id, basis: "inferred" });
  }
  for (const p of pkgLicenses) licenses.push({ path: p.path, identified: p.license, basis: "observed" });
  licenses.sort(byString((l) => l.path));
  const licenseBanners: SourceAnalysis["licenseBanners"] = [];
  for (const [path, c] of code) for (const b of c.banners) licenseBanners.push({ path, ...b });
  for (const { owner, facts, lineOffset } of inlineCode) for (const b of facts.banners) licenseBanners.push({ path: owner, line: b.line + lineOffset, text: b.text });
  licenseBanners.sort(byString((b) => `${b.path}\u0000${String(b.line).padStart(8, "0")}`));

  // ------------------------------------------------------------ interactions
  const interactions: SourceAnalysis["interactions"] = [];
  for (const lib of LIBRARIES) {
    const evidence: Evidence[] = [];
    const reasons: string[] = [];
    let basis: "observed" | "inferred" = "inferred";
    const dep = [...declared.entries()].find(([n]) => lib.pkg.test(n));
    if (dep) {
      evidence.push(ev(dep[1].path, null, `"${dep[0]}": "${dep[1].version}"`));
      reasons.push("declared as a dependency");
      basis = "observed";
    }
    for (const [path, c] of code) {
      const imp = c.imports.find((i) => lib.pkg.test(i.spec.split("/").slice(0, i.spec.startsWith("@") ? 2 : 1).join("/")));
      if (imp && evidence.length < 5) {
        evidence.push(ev(path, imp.line, `import "${imp.spec}"`));
        if (!reasons.includes("imported by project code")) reasons.push("imported by project code");
        basis = "observed";
      }
    }
    if (lib.url) {
      for (const url of [...external.keys(), ...files.map((f) => f.path)]) {
        if (lib.url.test(url) && evidence.length < 5) {
          evidence.push(ev(url));
          if (!reasons.includes("its script file is loaded")) reasons.push("its script file is loaded");
          basis = "observed";
        }
      }
    }
    if (lib.text) {
      let called = false;
      const scan = (path: string, t: string, offset = 0) => {
        const m = lib.text!.exec(t);
        if (!m) return;
        called = true;
        if (evidence.length < 5) evidence.push(ev(path, lineIndex(t)(m.index) + offset, t.slice(Math.max(0, m.index - 20), m.index + 60)));
      };
      for (const [path] of code) scan(path, text.get(path) ?? "");
      for (const [path, h] of html) for (const s of h.inlineScripts) scan(path, s.text, s.line - 1);
      if (called) reasons.push("its API is called in the code");
    }
    if (lib.name === "AOS scroll animations") {
      for (const h of html.values()) for (const m of h.markers.filter((x) => x.name === "aos").slice(0, 2)) evidence.push(m.e);
      if (evidence.length && !reasons.length) reasons.push("markup uses its data-aos attributes");
    }
    // Only API calls or attributes, with no package or file: the library is
    // probably bundled, which is a conclusion, so it stays inferred.
    if (evidence.length) {
      const rationale = reasons.join("; ").replace(/^./, (c) => c.toUpperCase()) + (basis === "inferred" ? " (the library itself was not found; it may be bundled)." : ".");
      interactions.push({ name: lib.name, basis, rationale, evidence });
    }
  }
  if (keyframes.length || transitions) {
    interactions.push({ name: "CSS animations and transitions", basis: "observed", rationale: `${keyframes.length} @keyframes and ${transitions} transition/animation declarations.`, evidence: keyframes.slice(0, 5).map((k) => ev(k.path, k.line, `@keyframes ${k.name}`)) });
  }
  interactions.sort(byString((i) => i.name));

  // ------------------------------------------------------------ risks
  const risks: Risk[] = [];
  const risk = (r: Omit<Risk, "occurrences" | "evidence"> & { evidence: Evidence[]; occurrences?: number }) => {
    if (r.evidence.length === 0 && !r.occurrences) return;
    risks.push({ ...r, occurrences: r.occurrences ?? r.evidence.length, evidence: r.evidence.slice(0, 10) });
  };
  const secrets = new Tally();
  for (const [path, t] of text) {
    const at = lineIndex(t);
    for (const [label, re] of SECRET_PATTERNS) for (const m of t.matchAll(re)) secrets.add(label, ev(path, at(m.index), `${label}: ${mask(m[0])}`));
  }
  for (const [label, s] of secrets.entries()) {
    risk({ key: `secret:${label}`, kind: "security", severity: "high", basis: "inferred", title: `Possible ${label} in the source`, detail: "A string matching a credential format. Treat it as exposed: rotate it if real, and never copy it into client work. Values are masked here.", evidence: s.evidence, occurrences: s.count });
  }
  const envFiles = files.filter((f) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f.path) && !/\.example$|\.sample$/.test(f.path));
  risk({ key: "env-files", kind: "security", severity: "high", basis: "observed", title: "Environment files included", detail: "Environment files usually hold credentials. Treat their contents as exposed.", evidence: envFiles.map((f) => ev(f.path)) });
  const riskyCalls = [...[...code.entries()].flatMap(([, c]) => c.risky), ...inlineCode.flatMap((x) => x.facts.risky.map((r) => ({ ...r, e: { ...r.e, path: x.owner, line: (r.e.line ?? 1) + x.lineOffset } })))];
  for (const [kind, sev, title] of [
    ["eval", "medium", "eval() calls"],
    ["new-function", "medium", "new Function() calls"],
    ["document-write", "low", "document.write() calls"],
  ] as const) {
    const hits = riskyCalls.filter((r) => r.kind === kind).map((r) => r.e);
    risk({ key: `call:${kind}`, kind: "security", severity: sev, basis: "observed", title, detail: "Executes strings as code or writes raw markup; often from third-party bundles. Do not carry into client work without review.", evidence: hits, occurrences: hits.length });
  }
  const noSri = [...external.entries()].filter(([, x]) => x.kind === "script" && !x.integrity);
  risk({ key: "external-scripts-without-sri", kind: "security", severity: "medium", basis: "observed", title: "Third-party scripts without integrity checks", detail: "Scripts loaded from other domains with no integrity attribute run whatever those servers return.", evidence: noSri.map(([url, x]) => x.evidence[0] ?? ev(url)), occurrences: noSri.length });
  const insecure = [...external.entries()].filter(([url]) => url.startsWith("http://"));
  risk({ key: "insecure-resources", kind: "security", severity: "medium", basis: "observed", title: "Resources loaded over plain HTTP", detail: "Blocked or warned about on HTTPS pages (mixed content).", evidence: insecure.map(([url, x]) => x.evidence[0] ?? ev(url)), occurrences: insecure.length });
  const blank = [...html.values()].flatMap((h) => h.blankTargetsWithoutNoopener);
  risk({ key: "blank-without-noopener", kind: "security", severity: "low", basis: "observed", title: 'Links opening new tabs without rel="noopener"', detail: "Older browsers give the opened page access to this one.", evidence: blank, occurrences: blank.length });
  const maps = files.filter((f) => f.path.endsWith(".map"));
  risk({ key: "source-maps", kind: "security", severity: "info", basis: "observed", title: "Source maps included", detail: "Source maps expose original source. Useful for analysis; they do not make the code yours to reuse.", evidence: maps.map((f) => ev(f.path)), occurrences: maps.length });

  const a11y = (key: string, sev: Risk["severity"], title: string, detail: string, pick: (h: HtmlFacts) => Evidence[]) => {
    const all = pages.flatMap((p) => pick(html.get(p)!));
    risk({ key: `a11y:${key}`, kind: "accessibility", severity: sev, basis: "observed", title, detail, evidence: all, occurrences: all.length });
  };
  a11y("lang", "medium", "Pages without a lang attribute", "Screen readers cannot pick the right pronunciation.", (h) => (h.lang ? [] : [ev(pages.find((p) => html.get(p) === h)!, 1, "<html> without lang")]));
  a11y("img-alt", "medium", "Images without alt text", 'Every image needs alt; decorative images need alt="".', (h) => h.imgWithoutAlt);
  a11y("labels", "high", "Form controls without a label", "The control has no label, aria-label or aria-labelledby.", (h) => h.unlabeledControls);
  a11y("names", "medium", "Links or buttons without an accessible name", "No text, aria-label or labelled image inside.", (h) => h.unnamedControls);
  a11y("headings", "low", "Skipped heading levels", "Heading levels jump, which breaks the outline screen-reader users navigate by.", (h) => h.headingSkips);
  a11y("tabindex", "low", "Positive tabindex", "Overrides the natural focus order.", (h) => h.positiveTabindex);
  if ((keyframes.length > 0 || transitions > 0) && reducedMotion === 0) {
    risk({ key: "a11y:reduced-motion", kind: "accessibility", severity: "medium", basis: "observed", title: "Animation without a reduced-motion alternative", detail: "CSS animates, and no prefers-reduced-motion query exists in the stylesheets. (Script-driven motion is not checked.)", evidence: keyframes.slice(0, 5).map((k) => ev(k.path, k.line, `@keyframes ${k.name}`)), occurrences: keyframes.length + transitions });
  }
  const noViewport = pages.filter((p) => !html.get(p)!.viewport);
  risk({ key: "a11y:viewport", kind: "accessibility", severity: "medium", basis: "observed", title: "Pages without a viewport meta tag", detail: "They will render as desktop pages on phones.", evidence: noViewport.map((p) => ev(p)), occurrences: noViewport.length });

  const missingAssets = missing.entries().map(([ref, e]) => ({ ref, evidence: e.evidence }));
  risk({ key: "missing-assets", kind: "missing_asset", severity: "medium", basis: "observed", title: "Referenced files not in the source", detail: "Referenced by the source but absent from the archive. Lazy loading, a different host, or an incomplete capture are possible causes; the scanner cannot tell which.", evidence: missingAssets.flatMap((m) => m.evidence.slice(0, 1)), occurrences: missingAssets.length });

  const ownLicense = licenses.filter((l) => LICENSE_FILE.test(l.path) && !l.path.includes("/"));
  if (ownLicense.length === 0) {
    risk({ key: "license:none", kind: "licensing", severity: "medium", basis: "observed", title: "No licence file at the root", detail: "Without a licence, reuse rights are unknown: by default all rights are reserved by the author.", evidence: [ev("(archive root)")], occurrences: 1 });
  }
  for (const l of licenses.filter((x) => x.identified && /GPL|AGPL|LGPL/.test(x.identified))) {
    risk({ key: `license:copyleft:${l.path}`, kind: "licensing", severity: "medium", basis: l.basis, title: `Copyleft licence (${l.identified})`, detail: "Reusing this code can oblige the client's site to be licensed the same way. Check before extracting.", evidence: [ev(l.path)], occurrences: 1 });
  }
  for (const l of pkgLicenses.filter((p) => /UNLICENSED|proprietary|SEE LICENSE/i.test(p.license))) {
    risk({ key: `license:restricted:${l.path}`, kind: "licensing", severity: "high", basis: "observed", title: `Package declares a restrictive licence (${l.license})`, detail: "Not licensed for reuse without permission.", evidence: [ev(l.path, null, `"license": "${l.license}"`)], occurrences: 1 });
  }
  const fontFiles = assets.filter((a) => a.kind === "font");
  const fontLicensed = licenses.some((l) => l.identified === "OFL-1.1") || files.some((f) => /(^|\/)(OFL|font[-_]?licen[cs]e)/i.test(f.path));
  if (fontFiles.length && !fontLicensed) {
    risk({ key: "license:fonts", kind: "licensing", severity: "medium", basis: "observed", title: "Font files without a font licence", detail: "Commercial fonts are licensed per use; files on a website do not grant a web or client licence.", evidence: fontFiles.map((f) => ev(f.path)), occurrences: fontFiles.length });
  }
  if (licenseBanners.length) {
    risk({ key: "license:banners", kind: "licensing", severity: "info", basis: "observed", title: "Third-party licence notices in bundled code", detail: "Bundles include other projects' code under their own terms; reuse must keep those notices.", evidence: licenseBanners.slice(0, 10).map((b) => ev(b.path, b.line, b.text)), occurrences: licenseBanners.length });
  }
  const lockfiles = files.filter((f) => LOCKFILES.test(f.path)).map((f) => f.path);
  if (dependencies.some((d) => d.scope !== "cdn") && lockfiles.length === 0) {
    risk({ key: "deps:no-lockfile", kind: "dependency", severity: "low", basis: "observed", title: "No lockfile", detail: "Only version ranges are declared; the exact versions that ran are unknown.", evidence: [ev(dependencies.find((d) => d.scope !== "cdn")!.path)], occurrences: 1 });
  }
  if (dependencies.length) {
    risk({ key: "deps:unaudited", kind: "dependency", severity: "info", basis: "observed", title: "Dependencies not checked for known vulnerabilities", detail: "The scanner has no advisory database. Run npm audit (or equivalent) in VS Code before reusing anything.", evidence: [], occurrences: dependencies.length });
  }
  risks.sort((a, b) => ["high", "medium", "low", "info"].indexOf(a.severity) - ["high", "medium", "low", "info"].indexOf(b.severity) || (a.key < b.key ? -1 : 1));

  // ------------------------------------------------------------ questions
  const questions: Question[] = [];
  const ask = (key: string, topic: string, q: string, evidence: Evidence[] = []) => questions.push({ key, topic, text: q, evidence: evidence.slice(0, 5) });
  if (frameworks.length === 0) ask("framework-unknown", "framework", "No framework, generator or package.json found. What built this site?");
  const minified = [...code.entries()].filter(([, c]) => c.minified).map(([p]) => p);
  if (minified.length && components.length === 0) {
    ask("source-not-included", "components", `Only built, minified scripts are present (${minified.length} file${minified.length === 1 ? "" : "s"}); component boundaries cannot be recovered from them. Is the original source repository available and authorised?`, minified.slice(0, 5).map((p) => ev(p)));
  }
  if (missingAssets.length) ask("missing-assets", "assets", `${missingAssets.length} referenced file${missingAssets.length === 1 ? " is" : "s are"} not in the source. Can a complete copy be supplied, or were they loaded from elsewhere?`, missingAssets.slice(0, 5).map((m) => m.evidence[0]));
  const missingPageList = missingPages.entries();
  if (missingPageList.length) ask("pages-not-captured", "routes", `Pages are linked but not in the source: ${missingPageList.slice(0, 8).map(([p]) => p).join(", ")}${missingPageList.length > 8 ? "…" : ""}. Should they be captured?`, missingPageList.slice(0, 5).map(([, e]) => e.evidence[0]));
  for (const r of routes.filter((x) => x.dynamic)) ask(`route-params:${r.route}`, "routes", `Route ${r.route} is dynamic. Which pages does it produce, and where does their content come from?`, [ev(r.file)]);
  const families = [...new Set(fontFaces.map((f) => f.family))].sort();
  if (families.length) ask("font-licences", "licensing", `Fonts used: ${families.join(", ")}. Is each licensed for web use in the client's project?`, fontFaces.slice(0, 5).map((f) => ev(f.path, f.line, f.family)));
  if (ownLicense.length === 0) ask("code-ownership", "licensing", "No licence file at the root. Who owns this code, and on what terms may parts of it be reused?");
  if (meta.skipped.length) ask("skipped-files", "completeness", `${meta.skipped.length} archive entr${meta.skipped.length === 1 ? "y was" : "ies were"} not analysed (see skipped). Do any of them matter?`);
  if (secrets.entries().length || envFiles.length) ask("credentials", "security", "The source appears to contain credentials. Has the owner been told, and have they been rotated?");
  questions.sort(byString((q) => q.key));

  // ------------------------------------------------------------ assemble
  const byKind = Object.fromEntries(["html", "css", "script", "json", "image", "font", "video", "audio", "document", "other"].map((k) => [k, 0])) as Record<FileKind, number>;
  for (const f of files) byKind[kindOf(f.path)]++;

  const analysis = SourceAnalysis.parse({
    schema: SOURCE_ANALYSIS_SCHEMA,
    analyzerVersion: ANALYZER_VERSION,
    input: { sha256: meta.sha256, sizeBytes: meta.sizeBytes },
    rootPrefix: meta.rootPrefix,
    skipped: meta.skipped,
    summary: { files: files.length, totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0), byKind },
    files: files.map((f) => ({ path: f.path, kind: kindOf(f.path), sizeBytes: f.sizeBytes, sha256: f.sha256 })),
    frameworks,
    routes,
    linkedButMissing: missingPageList.map(([href, e]) => ({ href, evidence: e.evidence })),
    components,
    templateCandidates: candidates,
    styles: {
      stylesheets: [...css.keys()].sort(),
      customProperties: customProperties.sort(byString((p) => `${p.path}\u0000${String(p.line).padStart(8, "0")}\u0000${p.name}`)).slice(0, 400),
      breakpoints: [...bp.values()].sort((a, b) => a.px - b.px || (a.feature < b.feature ? -1 : 1)),
      colors: top(colorCount, 40).map(([value, count]) => ({ value, count })),
      fontFamilies: top(familyCount, 30).map(([family, count]) => ({ family, count })),
      fontFaces: fontFaces.sort(byString((f) => `${f.family}\u0000${f.path}\u0000${String(f.line).padStart(8, "0")}`)),
      keyframes: keyframes.sort(byString((k) => `${k.path}\u0000${String(k.line).padStart(8, "0")}`)),
      transitionCount: transitions,
      reducedMotionQueries: reducedMotion,
    },
    assets,
    missingAssets,
    externalResources: [...external.entries()].sort(byString(([u]) => u)).map(([url, x]) => ({ url, kind: x.kind, integrity: x.integrity, evidence: x.evidence })),
    dependencies,
    lockfiles,
    licenses,
    licenseBanners,
    responsive: {
      pagesWithViewportMeta: pages.filter((p) => html.get(p)!.viewport),
      pagesWithoutViewportMeta: noViewport,
      mediaQueries,
      containerQueries,
      srcsetImages: [...html.values()].reduce((s, h) => s + h.srcset, 0),
      pictureElements: [...html.values()].reduce((s, h) => s + h.picture, 0),
    },
    interactions,
    risks,
    questions,
  });
  return { analysis, digest: createHash("sha256").update(JSON.stringify(analysis)).digest("hex") };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";
import { StoreError } from "@/server/store/errors";
import { DEFAULT_LIMITS, readArchive } from "@/server/wf03/archive";
import { opContext, processTemplate, replayOperations, type Recorded } from "@/server/templates";
import { compose } from "@/server/templates/composition";

// An editable working copy of a generated template, extracted from the
// stored website-template.zip (which itself never changes). Previews build
// and serve this copy; the brand and content editors write to it.
//
// The template's build.mjs is code that came inside a ZIP. It is only ever
// run if the template's runtime files are byte-for-byte the ones in the
// configured SaveAllResources installation (verifyRuntime) - a ZIP imported
// by hand could otherwise carry anything.

const JOB_ID = /^tpl_[A-Za-z0-9_-]{16,40}$/;
const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const FRAMEWORKS = ["next", "nuxt", "astro", "vite", "@sveltejs/kit", "gatsby", "react-scripts", "@remix-run/dev", "@angular/core"];

export type Strategy = "static-sar" | "framework" | "unknown";
export type Verification = { ok: true } | { ok: false; reason: string };
export type WorkspaceInfo = {
  strategy: Strategy;
  framework: string | null;
  verification: Verification;
  routes: { pageId: string; route: string; title: string }[];
  skipped: string[];
  createdAt: string;
};

export function workspacePaths(root: string, jobId: string) {
  if (!JOB_ID.test(jobId)) throw new StoreError("invalid", "Invalid template job.");
  const base = resolve(root);
  const dir = resolve(base, jobId);
  if (!dir.startsWith(base + sep)) throw new StoreError("invalid", "Invalid template job.");
  return {
    dir,
    template: join(dir, "template"),
    // The generator's manifests, inventories and captured stylesheets (not served).
    capture: join(dir, "capture"),
    reports: join(dir, "reports"),
    verifyDist: join(dir, "verify-dist"),
    meta: join(dir, "workspace.json"),
    state: join(dir, "preview-state.json"),
    heartbeat: join(dir, "heartbeat"),
    log: join(dir, "preview.log"),
  };
}

const writeJson = (file: string, data: unknown) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
};
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

// ------------------------------------------------------------------ runtime

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

// The runtime SaveAllResources ships in every template (build.mjs, serve.mjs,
// lib/, runtime/, package.json), as in the installation's template-runtime/.
export function verifyRuntime(templateDir: string, sarHome: string | null): Verification {
  if (!sarHome) return { ok: false, reason: "SaveAllResources is not configured (SAR_HOME), so the template's runtime cannot be verified and will not be run." };
  const reference = join(sarHome, "app", "processing", "template-runtime");
  if (!existsSync(reference)) return { ok: false, reason: "The SaveAllResources installation has no template runtime to verify against." };
  const expected = listFiles(reference).filter((f) => !/(^|\/)README\.md$/.test(f));
  for (const f of expected) {
    const mine = join(templateDir, f);
    if (!existsSync(mine)) return { ok: false, reason: `The template's runtime is incomplete (${f} is missing), so it will not be run.` };
    if (!readFileSync(mine).equals(readFileSync(join(reference, f)))) {
      return { ok: false, reason: `The template's runtime file ${f} differs from the SaveAllResources installation's, so it will not be run.` };
    }
  }
  return { ok: true };
}

export function detectStrategy(templateDir: string): { strategy: Strategy; framework: string | null } {
  try {
    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(templateDir, "package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const fw = FRAMEWORKS.find((f) => f in deps);
    if (fw) return { strategy: "framework", framework: fw };
  } catch {
    /* no package.json: decided below */
  }
  if (existsSync(join(templateDir, "build.mjs")) && existsSync(join(templateDir, "pages"))) return { strategy: "static-sar", framework: null };
  return { strategy: "unknown", framework: null };
}

function routesOf(templateDir: string): WorkspaceInfo["routes"] {
  const pagesDir = join(templateDir, "pages");
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => {
      try {
        const p = readJson<{ id?: string; route?: string }>(join(pagesDir, f));
        const id = p.id ?? f.replace(/\.json$/, "");
        let title = id;
        try {
          title = readJson<{ page?: { title?: string } }>(join(templateDir, "content", "pages", `${id}.json`)).page?.title ?? id;
        } catch {
          /* untitled */
        }
        return typeof p.route === "string" && PAGE_ID.test(id) ? [{ pageId: id, route: p.route.replace(/^\/+/, ""), title }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.route === "index.html" ? -1 : b.route === "index.html" ? 1 : a.route.localeCompare(b.route)));
}

// --------------------------------------------------------------- workspace

// What is extracted from the stored ZIP: the template, and the generator's
// manifests, inventories and captured stylesheets that Web's processing reads.
const CAPTURE_FILE = /^(manifest|page-inventory|section-inventory|verification-report)\.json$|^raw-capture\/resources\/.+\.css$/i;
const PROCESSING_VERSION = 1;

function extract(p: ReturnType<typeof workspacePaths>, zipBytes: Uint8Array, parts: { template: boolean; capture: boolean }) {
  const a = readArchive(zipBytes, { ...DEFAULT_LIMITS, maxFileBytes: MAX_CAPTURE_BYTES }, (path) => {
    const rel = path.replace(/^[^/]+\//, "");
    return (parts.template && (/^[^/]+\/template\//.test(path) || path.startsWith("template/"))) || (parts.capture && (CAPTURE_FILE.test(rel) || CAPTURE_FILE.test(path)));
  });
  let written = 0;
  for (const f of a.files) {
    let out: string;
    if (f.path.startsWith("template/")) {
      if (!parts.template) continue;
      const rel = f.path.slice("template/".length);
      if (!rel || rel === "dist" || rel.startsWith("dist/")) continue; // rebuilt by the preview
      out = resolve(p.template, rel);
      if (!out.startsWith(p.template + sep)) continue;
      written++;
    } else {
      if (!parts.capture || !CAPTURE_FILE.test(f.path)) continue;
      out = resolve(p.capture, f.path);
      if (!out.startsWith(p.capture + sep)) continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.bytes);
  }
  return { written, skipped: a.skipped.map((x) => `${x.path}: ${x.reason}`) };
}

export function createWorkspace(root: string, jobId: string, zipBytes: Uint8Array, sarHome: string | null): WorkspaceInfo {
  const p = workspacePaths(root, jobId);
  rmSync(p.dir, { recursive: true, force: true });
  mkdirSync(p.template, { recursive: true });
  // Only template/ and the generator's reports are extracted (the raw capture
  // stays in the artifact), through WF-03's archive reader: same path safety
  // and expansion limits.
  const { written, skipped } = extract(p, zipBytes, { template: true, capture: true });
  if (!written) {
    rmSync(p.dir, { recursive: true, force: true });
    throw new StoreError("invalid", "This ZIP has no template/ folder, so there is nothing to preview.");
  }
  const meta = { createdAt: new Date().toISOString(), skipped, processed: process_(p) };
  writeJson(p.meta, meta);
  return inspectWorkspace(root, jobId, sarHome)!;
}

// Web's processing (composition, design-token provenance, overrides log). A
// template the processing cannot handle stays previewable as generated.
function process_(p: ReturnType<typeof workspacePaths>): number | string {
  try {
    processTemplate(p.template, p.capture);
    return PROCESSING_VERSION;
  } catch (e) {
    return `failed: ${(e as Error).message}`;
  }
}

/** Workspaces made before Web's processing existed get it once (edits are kept). */
export function upgradeWorkspace(root: string, jobId: string, zipBytes: () => Uint8Array): boolean {
  const p = workspacePaths(root, jobId);
  if (!existsSync(/*turbopackIgnore: true*/ p.meta)) return false; // runtime data, not a build input
  const meta = readJson<{ processed?: number | string }>(p.meta);
  if (meta.processed !== undefined) return false;
  extract(p, zipBytes(), { template: false, capture: true });
  writeJson(p.meta, { ...meta, processed: process_(p) });
  return true;
}

type Snapshot = Map<string, Json>;
function snapshotEdits(t: string): Snapshot {
  const snap: Snapshot = new Map();
  for (const rel of ["site.config.json", ...(existsSync(join(t, "content")) ? listFiles(join(t, "content")).map((f) => `content/${f}`) : [])]) {
    if (rel.endsWith(".json") && existsSync(join(t, rel))) snap.set(rel, readJson<Json>(join(t, rel)));
  }
  return snap;
}
/** Puts edited values back wherever the same path still exists after a replay. */
function restoreEdits(t: string, snap: Snapshot): number {
  let restored = 0;
  const walk = (fresh: Json, old: Json): Json => {
    if (typeof fresh !== "object" || fresh === null || typeof old !== "object" || old === null || Array.isArray(fresh) !== Array.isArray(old)) {
      if (typeof fresh === typeof old && typeof fresh !== "object" && fresh !== old) {
        restored++;
        return old;
      }
      return fresh;
    }
    if (Array.isArray(fresh)) return fresh.map((v, i) => (i < (old as Json[]).length ? walk(v, (old as Json[])[i]) : v));
    const out: { [k: string]: Json } = { ...fresh };
    for (const k of Object.keys(fresh)) if (k in (old as object)) out[k] = walk((fresh as { [k: string]: Json })[k], (old as { [k: string]: Json })[k]);
    return out;
  };
  for (const [rel, old] of snap) {
    if (!existsSync(join(t, rel))) continue;
    const fresh = readJson<Json>(join(t, rel));
    const next = walk(fresh, old);
    if (JSON.stringify(next) !== JSON.stringify(fresh)) writeJson(join(t, rel), next);
  }
  return restored;
}

/**
 * Rebuilds the working copy from the stored ZIP and replays the given
 * overrides; brand and content edits are put back wherever their field still
 * exists. Used to undo an override and to reprocess.
 */
export function reprocessWorkspace(root: string, jobId: string, zipBytes: Uint8Array, ops: Recorded[]): { restored: number; failed: Recorded[] } {
  const p = workspacePaths(root, jobId);
  if (!existsSync(/*turbopackIgnore: true*/ p.template)) throw new StoreError("conflict", "Open the template first."); // runtime data
  const snap = snapshotEdits(p.template);
  rmSync(p.template, { recursive: true, force: true });
  rmSync(p.capture, { recursive: true, force: true });
  mkdirSync(p.template, { recursive: true });
  extract(p, zipBytes, { template: true, capture: true });
  processTemplate(p.template, p.capture);
  const replayed = replayOperations(p.template, ops, opContext(p.template, p.capture));
  const restored = restoreEdits(p.template, snap);
  compose(p.template);
  return { restored, failed: replayed.filter((r) => r.status === "failed") };
}

export function inspectWorkspace(root: string, jobId: string, sarHome: string | null): WorkspaceInfo | null {
  const p = workspacePaths(root, jobId);
  // Runtime data paths, not build inputs: excluded from output file tracing.
  if (!existsSync(/*turbopackIgnore: true*/ p.meta) || !existsSync(/*turbopackIgnore: true*/ p.template)) return null;
  const meta = readJson<{ createdAt: string; skipped: string[] }>(p.meta);
  const { strategy, framework } = detectStrategy(p.template);
  return {
    strategy,
    framework,
    verification: strategy === "static-sar" ? verifyRuntime(p.template, sarHome) : { ok: false, reason: strategy === "framework" ? `This is a ${framework} template. Previews of framework templates are not supported yet.` : "This template has no runtime Web can preview (no build.mjs and pages/)." },
    routes: routesOf(p.template),
    skipped: meta.skipped,
    createdAt: meta.createdAt,
  };
}

export const removeWorkspace = (root: string, jobId: string) => rmSync(workspacePaths(root, jobId).dir, { recursive: true, force: true });

// ----------------------------------------------------------- editable data

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Field = { path: string; value: string; kind: "text" | "link" };
export type Editable = {
  brand: { name: string };
  colors: { key: string; value: string }[];
  fonts: { key: string; family: string }[];
  pages: { pageId: string; route: string; title: string; description: string; sections: { id: string; fields: Field[] }[] }[];
};

const NOT_EDITABLE = new Set(["src", "srcset", "poster"]); // assets stay as captured
function fieldsOf(value: Json, prefix: string, out: Field[] = []): Field[] {
  if (typeof value === "string") {
    const key = prefix.split(".").pop()!;
    if (!NOT_EDITABLE.has(key)) out.push({ path: prefix, value, kind: key === "href" ? "link" : "text" });
  } else if (Array.isArray(value)) value.forEach((v, i) => fieldsOf(v, `${prefix}.${i}`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) fieldsOf(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export function readEditable(templateDir: string): Editable {
  const config = readJson<{ brand?: { name?: string }; colors?: Record<string, { value?: string }>; fonts?: Record<string, { family?: string }> }>(join(templateDir, "site.config.json"));
  return {
    brand: { name: config.brand?.name ?? "" },
    colors: Object.entries(config.colors ?? {}).flatMap(([key, c]) => (typeof c?.value === "string" ? [{ key, value: c.value }] : [])),
    fonts: Object.entries(config.fonts ?? {}).flatMap(([key, f]) => (typeof f?.family === "string" ? [{ key, family: f.family }] : [])),
    pages: routesOf(templateDir).map((r) => {
      let content: { page?: { title?: string; description?: string; frames?: Record<string, Json> }; sections?: Record<string, Json> } = {};
      try {
        content = readJson(join(templateDir, "content", "pages", `${r.pageId}.json`));
      } catch {
        /* no content file */
      }
      return {
        pageId: r.pageId,
        route: r.route,
        title: content.page?.title ?? "",
        description: content.page?.description ?? "",
        sections: [
          // The wrapper of a split section keeps its own text (content.page.frames).
          ...Object.entries((content.page as { frames?: Record<string, Json> } | undefined)?.frames ?? {}).map(([id, v]) => ({ id: `frame:${id}`, fields: fieldsOf(v, "") })),
          ...Object.entries(content.sections ?? {}).map(([id, v]) => ({ id, fields: fieldsOf(v, "") })),
        ],
      };
    }),
  };
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT = /^[A-Za-z0-9 ,"'.\-]{1,200}$/;
const SAFE_HREF = /^(\/(?!\/)|#|\.\/|\.\.\/|https?:\/\/|mailto:|tel:)/i;
const bad = (path: string, message: string) => new StoreError("invalid", message, [{ path, message }]);

export function saveBrand(templateDir: string, input: { name?: unknown; colors?: unknown; fonts?: unknown }) {
  const file = join(templateDir, "site.config.json");
  const config = readJson<Record<string, Json>>(file) as { brand?: Record<string, Json>; colors?: Record<string, Record<string, Json>>; fonts?: Record<string, Record<string, Json>> };
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) throw bad("name", "The brand name must be 1-120 characters.");
    config.brand = { ...(config.brand ?? {}), name: input.name.trim() };
  }
  for (const [key, value] of Object.entries((input.colors ?? {}) as Record<string, unknown>)) {
    if (!config.colors?.[key]) throw bad(`colors.${key}`, `This template has no colour "${key}".`);
    if (typeof value !== "string" || !HEX.test(value.trim())) throw bad(`colors.${key}`, "Colours are hex values such as #0b3d5c.");
    config.colors[key].value = value.trim();
  }
  for (const [key, value] of Object.entries((input.fonts ?? {}) as Record<string, unknown>)) {
    if (!config.fonts?.[key]) throw bad(`fonts.${key}`, `This template has no font "${key}".`);
    if (typeof value !== "string" || !FONT.test(value.trim())) throw bad(`fonts.${key}`, "Fonts are font-family lists, e.g. Georgia, serif.");
    config.fonts[key].family = value.trim();
  }
  writeJson(file, config);
}

export function savePageContent(templateDir: string, pageId: string, input: { title?: unknown; description?: unknown; fields?: unknown }) {
  if (!PAGE_ID.test(pageId)) throw bad("page", "Invalid page.");
  const file = join(templateDir, "content", "pages", `${pageId}.json`);
  if (!existsSync(file)) throw new StoreError("not_found", "This page has no editable content.");
  const content = readJson<{ page?: Record<string, Json>; sections?: Record<string, Json> }>(file);
  const text = (v: unknown, path: string, max: number) => {
    if (typeof v !== "string" || v.length > max) throw bad(path, `Text is limited to ${max} characters.`);
    return v;
  };
  if (input.title !== undefined) content.page = { ...(content.page ?? {}), title: text(input.title, "title", 300) };
  if (input.description !== undefined) content.page = { ...(content.page ?? {}), description: text(input.description, "description", 1000) };
  const frames = ((content.page ?? {}) as { frames?: Record<string, Json> }).frames ?? {};
  const existing = new Map([
    ...fieldsOf((content.sections ?? {}) as Json, "").map((f) => [f.path, f] as const),
    ...fieldsOf(frames as Json, "").map((f) => [`frame:${f.path}`, f] as const),
  ]);
  // Keys are "<sectionId>.<field path>" (or "frame:<id>.<field path>"), as readEditable lists them.
  for (const [path, value] of Object.entries((input.fields ?? {}) as Record<string, unknown>)) {
    const field = existing.get(path);
    // Only text that is already there can change: never structure, never assets.
    if (!field) throw bad(path, "This field is not editable in this template.");
    const v = text(value, path, 5000);
    if (field.kind === "link" && v && !SAFE_HREF.test(v)) throw bad(path, "Links must be site paths, #anchors, http(s), mailto: or tel:.");
    const keys = path.split(".");
    let node = content.sections as Record<string, Json>;
    if (keys[0].startsWith("frame:")) {
      keys[0] = keys[0].slice("frame:".length);
      node = frames as Record<string, Json>;
    }
    for (const k of keys.slice(0, -1)) node = (node as Record<string, Json>)[k] as Record<string, Json>;
    (node as Record<string, Json>)[keys[keys.length - 1]] = v;
  }
  writeJson(file, content);
}

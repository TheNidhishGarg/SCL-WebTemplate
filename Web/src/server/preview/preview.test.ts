import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/store/db";
import { createStore, StoreError, type Store } from "@/server/store/store";
import { createPreviewManager, type PreviewManager } from "./preview-manager";
import { readEditable, saveBrand, savePageContent } from "./workspace";

// Live previews against a STUB template runtime: a tiny build.mjs that bakes
// the brand colour, page title and section text into dist/, so every edit's
// effect is visible in the served HTML. The real SaveAllResources runtime is
// exercised by e2e/wf-02d-template-preview.spec.ts.

const HOST = join(process.cwd(), "scripts", "preview-host.mjs");
const RUNTIME: Record<string, string> = {
  "build.mjs": String.raw`
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const root = process.cwd();
const config = JSON.parse(readFileSync(join(root, "site.config.json"), "utf8"));
for (const f of readdirSync(join(root, "pages"))) {
  const page = JSON.parse(readFileSync(join(root, "pages", f), "utf8"));
  const content = JSON.parse(readFileSync(join(root, "content/pages", page.id + ".json"), "utf8"));
  const hero = content.sections["s01-hero"];
  const out = join(root, "dist", page.route);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "<!doctype html><title>" + content.page.title + "</title><style>:root{--sar-color-primary:" + config.colors.primary.value + "}</style><h1>" + hero.heading + "</h1><a href=\"" + hero.cta.href + "\">" + hero.cta.label + "</a><form action=\"https://example.invalid/submit\"><button>Send</button></form>");
}
`,
  "serve.mjs": "// stub\n",
  "lib/engine.mjs": "export const x = 1;\n",
  "runtime/sar-runtime.js": "/* guard */\n",
  "package.json": JSON.stringify({ name: "website-template", private: true, type: "module" }),
};

function templateZip(over: { runtime?: Partial<Record<string, string>>; packageJson?: object; noTemplate?: boolean } = {}) {
  const files: Record<string, Uint8Array> = { "website-template/manifest.json": strToU8("{}") };
  if (!over.noTemplate) {
    for (const [k, v] of Object.entries({ ...RUNTIME, ...over.runtime })) files[`website-template/template/${k}`] = strToU8(v!);
    if (over.packageJson) files["website-template/template/package.json"] = strToU8(JSON.stringify(over.packageJson));
    files["website-template/template/site.config.json"] = strToU8(JSON.stringify({ brand: { name: "Stub" }, colors: { primary: { value: "#0b3d5c", uses: 3 }, accent: { value: "#f2a541" } }, fonts: { body: { family: "Georgia, serif" } } }));
    files["website-template/template/pages/home.json"] = strToU8(JSON.stringify({ id: "home", route: "index.html" }));
    files["website-template/template/pages/about.json"] = strToU8(JSON.stringify({ id: "about", route: "about/index.html" }));
    for (const id of ["home", "about"]) {
      files[`website-template/template/content/pages/${id}.json`] = strToU8(
        JSON.stringify({ page: { title: `${id} title`, description: "" }, sections: { "s01-hero": { heading: `${id} heading`, cta: { href: "/about/", label: "More" }, image: { src: "/assets/a.png", alt: "A" } } } }),
      );
    }
    files["website-template/template/dist/index.html"] = strToU8("stale prebuilt dist");
  }
  files["website-template/raw-capture/pages/home/document.original.html"] = strToU8("<p>raw</p>");
  return zipSync(files);
}

let dir: string;
let sarHome: string;
let store: Store;
let managers: PreviewManager[] = [];
const jobIds: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-preview-"));
  sarHome = join(dir, "sar");
  for (const [k, v] of Object.entries({ ...RUNTIME, "README.md": "not shipped" })) {
    mkdirSync(join(sarHome, "app/processing/template-runtime", k, ".."), { recursive: true });
    writeFileSync(join(sarHome, "app/processing/template-runtime", k), v);
  }
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), { checkUrl: async () => { throw new Error("offline"); } });
});
afterEach(async () => {
  for (const m of managers) for (const id of jobIds.splice(0)) await m.stop(id).catch(() => {});
  managers = [];
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => undefined);

function manager(over: Partial<Parameters<typeof createPreviewManager>[0]> = {}) {
  const m = createPreviewManager(
    { mode: "local", root: join(dir, "workspaces"), hostScript: HOST, sarHome, portMin: 4410, portMax: 4430, maxRunning: 2, idleMs: 60_000, frameAncestors: "http://localhost:*", ...over },
    { registry: store.templatePreviews },
  );
  managers.push(m);
  return m;
}
function job() {
  const p = store.createProject({ name: "P", clientName: "P" });
  const j = store.templateJobs.createLocked(p.id, { sourceUrl: "https://stub.test/", authority: "client_owned", authorizedBy: "test", options: { maxPages: 1, maxDepth: 0, maxMinutes: 1 } });
  store.templateJobs.update(j.id, { run_lock: null });
  jobIds.push(j.id);
  return { projectId: p.id, jobId: j.id };
}
const get = async (url: string) => {
  const r = await fetch(url);
  return { status: r.status, text: await r.text(), headers: r.headers };
};
async function waitForBuild(m: PreviewManager, jobId: string, after: number) {
  for (let i = 0; i < 100; i++) {
    const s = m.status(jobId);
    if (s.buildId > after && s.state === "ready") return s;
    if (s.state === "error") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no rebuild");
}

describe("template workspace", () => {
  it("extracts only template/ (without the prebuilt dist), lists routes, and verifies the runtime against SaveAllResources", () => {
    const m = manager();
    const { jobId } = job();
    const ws = m.ensureWorkspace(jobId, () => templateZip());
    expect(ws).toMatchObject({ strategy: "static-sar", verification: { ok: true } });
    expect(ws.routes.map((r) => r.route)).toEqual(["index.html", "about/index.html"]);
    const t = join(dir, "workspaces", jobId, "template");
    expect(() => readFileSync(join(t, "dist/index.html"))).toThrow();
    expect(() => readFileSync(join(dir, "workspaces", jobId, "raw-capture"))).toThrow();
  });

  it("refuses to run a runtime that differs from the installation's, or that cannot be verified", () => {
    const m = manager();
    const a = job();
    expect(m.ensureWorkspace(a.jobId, () => templateZip({ runtime: { "build.mjs": "require('child_process').exec('rm -rf ~')" } })).verification).toMatchObject({ ok: false, reason: expect.stringMatching(/build\.mjs differs/) });
    const b = job();
    expect(manager({ sarHome: null }).ensureWorkspace(b.jobId, () => templateZip()).verification).toMatchObject({ ok: false, reason: expect.stringMatching(/SAR_HOME/) });
    const c = job();
    const fw = m.ensureWorkspace(c.jobId, () => templateZip({ packageJson: { dependencies: { next: "16.0.0" } } }));
    expect(fw).toMatchObject({ strategy: "framework", framework: "next", verification: { ok: false, reason: expect.stringMatching(/not supported yet/) } });
    const d = job();
    expect(() => m.ensureWorkspace(d.jobId, () => templateZip({ noTemplate: true }))).toThrow(/no template\/ folder/);
    return expect(m.start(a.jobId, "x")).rejects.toThrow(/differs/);
  });

  it("edits only existing brand values and text fields, with validation", () => {
    const m = manager();
    const { jobId } = job();
    m.ensureWorkspace(jobId, () => templateZip());
    const t = join(dir, "workspaces", jobId, "template");
    const e = readEditable(t);
    expect(e.colors).toEqual([{ key: "primary", value: "#0b3d5c" }, { key: "accent", value: "#f2a541" }]);
    expect(e.pages[0].sections[0].fields.map((f) => f.path)).toEqual(["heading", "cta.href", "cta.label", "image.alt"]); // image.src is not editable
    expect(() => saveBrand(t, { colors: { primary: "red; background:url(x)" } })).toThrow(StoreError);
    expect(() => saveBrand(t, { colors: { nope: "#000000" } })).toThrow(/no colour/);
    expect(() => saveBrand(t, { fonts: { body: "x</style>" } })).toThrow(StoreError);
    expect(() => savePageContent(t, "home", { fields: { "s01-hero.image.src": "https://evil.test/x.png" } })).toThrow(/not editable/);
    expect(() => savePageContent(t, "home", { fields: { "s01-hero.cta.href": "javascript:alert(1)" } })).toThrow(/Links must be/);
    expect(() => savePageContent(t, "../etc", { title: "x" })).toThrow(StoreError);
    savePageContent(t, "home", { title: "New title", fields: { "s01-hero.heading": "New heading", "s01-hero.cta.href": "/about/" } });
    expect(readEditable(t).pages[0]).toMatchObject({ title: "New title", sections: [{ fields: [{ path: "heading", value: "New heading" }, { path: "cta.href", value: "/about/" }, {}, {}] }] });
  });
});

describe("preview processes", () => {
  it("serves the built template in isolation, and each edit (section, brand colour, page content) rebuilds the preview", async () => {
    const m = manager();
    const { projectId, jobId } = job();
    m.ensureWorkspace(jobId, () => templateZip());
    const s = await m.start(jobId, projectId);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:44\d\d$/);
    const ready = await waitForBuild(m, jobId, 0);
    expect(ready.state).toBe("ready");
    const page = await get(`${s.url}/`);
    expect(page.text).toContain("<h1>home heading</h1>");
    expect((await get(`${s.url}/about/`)).text).toContain("<h1>about heading</h1>");
    // Isolation: no cookies, no form submissions, no outside requests, framed only by the dashboard, read-only.
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors http://localhost:*");
    expect(page.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${s.url}/`, { method: "POST" })).status).toBe(405);
    expect((await get(`${s.url}/../../scl.sqlite`)).status).not.toBe(200);

    // Editing a section.
    m.savePageContent(jobId, "home", { fields: { "s01-hero.heading": "Edited section heading" } });
    let b = await waitForBuild(m, jobId, ready.buildId);
    expect((await get(`${s.url}/`)).text).toContain("<h1>Edited section heading</h1>");
    // Changing a brand colour.
    m.saveBrand(jobId, { colors: { primary: "#ff0066" } });
    b = await waitForBuild(m, jobId, b.buildId);
    expect((await get(`${s.url}/`)).text).toContain("--sar-color-primary:#ff0066");
    // Updating page content.
    m.savePageContent(jobId, "home", { title: "Updated page title" });
    b = await waitForBuild(m, jobId, b.buildId);
    expect((await get(`${s.url}/`)).text).toContain("<title>Updated page title</title>");

    // A failing build is reported; the last good build keeps being served.
    writeFileSync(join(dir, "workspaces", jobId, "template", "site.config.json"), "{ not json");
    const failed = await waitForBuild(m, jobId, b.buildId);
    expect(failed).toMatchObject({ state: "error", error: expect.stringMatching(/build failed/) });
    expect((await get(`${s.url}/`)).text).toContain("Updated page title");

    // Stop and restart.
    await m.stop(jobId);
    expect(m.status(jobId).state).toBe("stopped");
    await expect(fetch(`${s.url}/`)).rejects.toThrow();
    // Reset brings back the generated template (and its working config).
    await m.reset(jobId, () => templateZip());
    const again = await m.restart(jobId, projectId);
    await waitForBuild(m, jobId, 0);
    expect((await get(`${again.url}/`)).text).toContain("<h1>home heading</h1>");
  }, 60_000);

  it("avoids ports in use, limits running previews, and cleans up abandoned ones", async () => {
    // Port 4410 is taken by something else.
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(4410, "127.0.0.1", () => r()));
    const m = manager();
    const a = job();
    const b = job();
    const c = job();
    for (const j of [a, b, c]) m.ensureWorkspace(j.jobId, () => templateZip());
    const sa = await m.start(a.jobId, a.projectId);
    expect(sa.port).toBe(4411);
    const sb = await m.start(b.jobId, b.projectId);
    expect(sb.port).toBe(4412);
    await expect(m.start(c.jobId, c.projectId)).rejects.toThrow(/2 previews are already running/);
    blocker.close();

    // A Web restart: a new manager finds the running processes through the registry.
    const after = manager();
    expect(after.status(a.jobId).state).not.toBe("stopped");
    // Nobody has looked at them for longer than the idle limit: cleaned up.
    const strict = manager({ idleMs: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await strict.cleanup()).toBe(2);
    expect(after.status(a.jobId).state).toBe("stopped");
    expect(after.status(b.jobId).state).toBe("stopped");
  }, 60_000);

  it("an abandoned preview process stops itself when the dashboard stops looking", async () => {
    const m = manager({ idleMs: 1500 });
    const { projectId, jobId } = job();
    m.ensureWorkspace(jobId, () => templateZip());
    const s = await m.start(jobId, projectId);
    await new Promise((r) => setTimeout(r, 4000)); // no status calls = no heartbeat
    await expect(fetch(`${s.url}/`)).rejects.toThrow();
    expect(m.status(jobId).state).toBe("stopped");
  }, 30_000);

  it("is unavailable in remote and off modes, saying why", () => {
    expect(manager({ mode: "remote" }).availability()).toMatchObject({ ok: false, reason: expect.stringMatching(/Remote previews .* not available yet/) });
    expect(manager({ mode: "off" }).availability()).toMatchObject({ ok: false, reason: expect.stringMatching(/turned off/) });
  });
});

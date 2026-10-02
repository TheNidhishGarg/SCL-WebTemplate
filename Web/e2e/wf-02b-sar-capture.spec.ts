import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { TemplateManifest } from "../src/domain/wf03";

// The ALTERNATIVE extension path, for real: Web → the SaveAllResources
// extension in the user's Chrome → upload back to Web → WF-02 capture → WF-03
// source → the existing analysis. (The primary path, Generate Website
// Template, is e2e/wf-02c-template-generation.spec.ts.) The extension is the automation build from the
// SaveAllResources repository, built for this origin into .sar-extension:
//   (in SaveAllResources) SAR_ALLOWED_APP_ORIGINS=http://localhost:3100 \
//     SAR_ALLOWED_UPLOAD_ORIGINS=http://localhost:3100 \
//     SAR_EXTENSION_OUT=<Web>/.sar-extension npm run build:extension
// The captured site is a TEST FIXTURE served by this test on 127.0.0.1.

test.describe.configure({ mode: "serial" });
const EXT_DIR = process.env.SAR_EXTENSION_DIR ?? join(process.cwd(), ".sar-extension");
const BASE = "http://localhost:3100";

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Fixture Studio</title>
<link rel="stylesheet" href="/css/site.css"></head>
<body><header class="site-header"><nav class="main-nav"><a href="/">Home</a> <a href="/about/">About</a> <a href="/work/">Work</a></nav></header>
<main>${body}</main><footer class="site-footer"><p>Fixture Studio</p></footer></body></html>`;
const SITE: Record<string, [string, string]> = {
  "/": ["text/html", page("Home", `<section class="hero"><h1>Buildings in timber</h1><img src="/img/hero.svg" alt="A timber house"></section>`)],
  "/about/": ["text/html", page("About", `<section><h1>About us</h1><p>A small studio.</p></section>`)],
  "/work/": ["text/html", page("Work", `<section><h1>Work</h1><ul><li>Library</li><li>House</li></ul></section>`)],
  "/css/site.css": ["text/css", `:root { --brand: #7a1fa2; --space: 8px; }\nbody { font-family: Georgia, serif; color: #111; }\n.hero { padding: calc(var(--space) * 4); }\n`],
  "/img/hero.svg": ["image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#7a1fa2"/></svg>`],
};

let server: Server;
let siteUrl = "";
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const hit = SITE[(req.url ?? "/").split("?")[0]];
    if (!hit) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": hit[0] }).end(hit[1]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  siteUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function newProject(page: Page, name: string) {
  await page.goto(`${BASE}/projects/new`);
  await page.getByLabel("Client or business name").fill(name);
  await page.getByLabel("Project name").fill(`${name} project`);
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  return page.url().replace(/\/brief$/, "");
}

test.describe("with the SaveAllResources extension", () => {
  test.skip(!existsSync(join(EXT_DIR, "manifest.json")), `no extension build at ${EXT_DIR} (see the comment at the top of this file)`);
  let context: BrowserContext;
  let userDir: string;
  test.beforeAll(async () => {
    userDir = mkdtempSync(join(tmpdir(), "scl-sar-chrome-"));
    context = await chromium.launchPersistentContext(userDir, {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, "--no-first-run"],
    });
    if (!context.serviceWorkers().some((w) => w.url().startsWith("chrome-extension://jfpfjjalojpaffneaemkcjbdnmbaognl/"))) await context.waitForEvent("serviceworker", { timeout: 20_000 });
  });
  test.afterAll(async () => {
    await context?.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  test("URL → Capture with the extension → extension captures in Chrome → WF-02 capture → WF-03 source → analysis", async ({ request }) => {
    test.setTimeout(240_000);
    const page = await context.newPage();
    const projectUrl = await newProject(page, "Capture Client");
    const projectId = projectUrl.split("/").pop()!;
    await page.goto(`${projectUrl}/references`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/SaveAllResources extension found/)).toBeVisible({ timeout: 10_000 });

    await page.getByLabel(/^Website URL/).fill(siteUrl);
    await page.getByLabel("Pages to capture (at most)").fill("3");
    await page.getByRole("button", { name: "Capture with the extension" }).click();
    const status = page.getByTestId("capture-status");
    await expect(status).toHaveAttribute("data-status", /^completed/, { timeout: 180_000 });
    await expect(status).toContainText("Captured and registered.");

    // WF-02: the reference and its capture, recorded as SaveAllResources.
    await status.getByRole("link", { name: "View the reference" }).click();
    await expect(page.getByText(/^SaveAllResources · captured \d{4}-\d{2}-\d{2}/)).toBeVisible();
    await expect(page.getByText(/SaveAllResources capture sent to SCL Web/)).toBeVisible();

    // WF-03: the normal source page, study only, and the existing analysis.
    // The job is kept on the server: the references page lists it after navigating away.
    await page.goto(`${projectUrl}/references`);
    const recent = page.getByRole("list", { name: "Recent extension captures" }).getByRole("listitem").first();
    await expect(recent).toHaveAttribute("data-status", /^completed/);
    await recent.getByRole("link", { name: "WF-03 source" }).click();
    await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}$/);
    const sourceId = page.url().split("/").pop()!;
    await expect(page.getByText(/Study only/).first()).toBeVisible();
    await page.getByRole("button", { name: "Run analysis" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Analysis complete\. Digest [0-9a-f]{12}/ })).toBeVisible({ timeout: 60_000 });

    // The analysed archive is the packaged capture: every captured page, its original HTML, and the page packages as uploaded.
    const archive = await request.get(`${BASE}/api/projects/${projectId}/sources/${sourceId}/archive`);
    expect(archive.ok()).toBe(true);
    const { unzipSync } = await import("fflate");
    const names = Object.keys(unzipSync(new Uint8Array(await archive.body())));
    for (const id of ["home", "about", "work"]) {
      expect(names).toContain(`website-template/raw-capture/sar-page-zips/${id}.zip`);
      expect(names).toContain(`website-template/raw-capture/pages/${id}/document.original.html`);
    }
    expect(names).toContain("website-template/manifest.json");

    // WF-04/WF-05 read WF-03's template manifest; the source is in it, unchanged in shape.
    const manifest = TemplateManifest.parse(await (await request.get(`${BASE}/api/projects/${projectId}/templates/manifest`)).json());
    expect(manifest.sources.find((s) => s.id === sourceId)).toMatchObject({ authorization: { basis: "study_only" }, origin: { kind: "reference_capture", url: siteUrl } });
    expect(manifest.sources.find((s) => s.id === sourceId)!.origin.ref).toMatch(/^saveallresources:job=sar_[A-Za-z0-9_-]+;manifest=1\.0\.0$/);
  });

  test("an invalid URL is refused by Web before the extension is asked", async () => {
    const page = await context.newPage();
    const projectUrl = await newProject(page, "Refused Client");
    await page.goto(`${projectUrl}/references`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/SaveAllResources extension found/)).toBeVisible({ timeout: 10_000 });
    // The extension refuses non-http(s) targets; Web refuses them first.
    await page.getByLabel(/^Website URL/).fill("ftp://example.com/");
    await page.getByRole("button", { name: "Capture with the extension" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Enter a full http(s) URL" })).toBeVisible();
  });
});

test("without the extension: a clear message, and ZIP import still works as the fallback", async ({ page }) => {
  const projectUrl = await newProject(page, "Fallback Client");
  await page.goto(`${projectUrl}/references`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/The SaveAllResources extension is not available in this browser/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Capture with the extension" })).toBeDisabled();

  // TEST FIXTURE: an export laid out as the SaveAllResources app writes it.
  const manifest = { manifestVersion: "1.0.0", generator: "sar-website-template", jobId: "job_fallback01", createdAt: "2026-10-01T10:05:00.000Z", entryUrl: "https://fallback.example/", capture: { status: "completed", startedAt: 1790000000000, finishedAt: 1790000100000 }, pages: [{ id: "home", status: "captured" }] };
  const zip = zipSync({
    "website-template/manifest.json": strToU8(JSON.stringify(manifest)),
    "website-template/raw-capture/pages/home/document.original.html": strToU8("<!doctype html><html lang=en><title>x</title><h1>Fallback</h1></html>"),
  });
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Manual fallback: import a SaveAllResources ZIP" }) });
  await form.getByLabel(/^Export ZIP/).setInputFiles({ name: "job_fallback01-website-template.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await form.getByRole("button", { name: "Import ZIP" }).click();
  await expect(form.getByRole("status")).toContainText("Imported job job_fallback01 (https://fallback.example/)");
  await form.getByRole("link", { name: "Open the source to run the analysis" }).click();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Analysis complete\. Digest/ })).toBeVisible();
});

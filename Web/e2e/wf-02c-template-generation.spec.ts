import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { E2E_SAR_HOME } from "../playwright.config";

// The primary flow, for real: a URL entered in Web → the actual
// SaveAllResources CLI (separate process, its own Chrome for Testing and
// extension) → website-template.zip → Web artifact → WF-02 → WF-03 → WF-04/
// WF-05 gates. No terminal, no download, no upload. The captured site is a
// small TEST FIXTURE served by this test on 127.0.0.1.

test.describe.configure({ mode: "serial" });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const DATA = resolve(process.cwd(), ".e2e-data");

const html = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Fixture Bakery</title><link rel="stylesheet" href="/css/site.css"></head>
<body><header class="site-header"><nav><a href="/">Home</a> <a href="/menu/">Menu</a></nav></header>
<main>${body}</main><footer class="site-footer"><p>Fixture Bakery</p></footer></body></html>`;
const SITE: Record<string, [string, string]> = {
  "/": ["text/html", html("Home", `<section class="hero"><h1>Fresh bread daily</h1><p>Sourdough and rye.</p></section>`)],
  "/menu/": ["text/html", html("Menu", `<section><h1>Menu</h1><ul><li>Sourdough</li><li>Rye</li></ul></section>`)],
  "/css/site.css": ["text/css", `:root { --brand: #b45309; --space: 8px; }\nbody { font-family: Georgia, serif; color: #1f2937; }\n.hero { padding: calc(var(--space) * 4); }\n`],
};

// Large, incompressible "images" (each under SaveAllResources' 8 MB media limit).
// SaveAllResources stores each several times (raw capture, page package,
// template assets), about 29 MB of ZIP per image: 5 images make a realistic
// 100-200 MB template, 10 make one over the 200 MB limit.
const BIG = Array.from({ length: 10 }, (_, n) => {
  const b = Buffer.alloc(7 * 1024 * 1024);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE(((i + n * 7919) * 2654435761) >>> 0, i);
  return b;
});
const gallery = (n: number) => `<section><h1>Gallery</h1>${BIG.slice(0, n).map((_, i) => `<img src="/img/large-${i}.png" alt="Loaf ${i}">`).join("")}</section>`;
SITE["/gallery/"] = ["text/html", html("Gallery", gallery(10))];
SITE["/medium/"] = ["text/html", html("Medium gallery", gallery(5))];

let server: Server;
let siteUrl = "";
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const big = /^\/img\/large-(\d+)\.png$/.exec(path);
    if (big && BIG[Number(big[1])]) return res.writeHead(200, { "Content-Type": "image/png" }).end(BIG[Number(big[1])]);
    const hit = SITE[path];
    if (!hit) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": hit[0] }).end(hit[1]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  siteUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function newProject(page: Page, name: string) {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill(name);
  await page.getByLabel("Project name").fill(`${name} project`);
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  return page.url().replace(/\/brief$/, "");
}
const stage = (page: Page, key: string) => page.getByTestId("template-pipeline").locator(`[data-stage="${key}"]`);

test("Generate Website Template: URL → SaveAllResources → ZIP → WF-02 → WF-03, stopping at the WF-04/WF-05 gates", async ({ page, request }) => {
  test.skip(!E2E_SAR_HOME, "SaveAllResources is not installed next to Web (set SAR_HOME)");
  test.setTimeout(420_000);
  const projectUrl = await newProject(page, "Template Client");
  const projectId = projectUrl.split("/").pop()!;
  await page.goto(projectUrl);
  await page.waitForLoadState("networkidle");

  // One obvious primary action on the project page.
  await expect(page.getByRole("heading", { name: "Generate Website Template", level: 2 })).toBeVisible();
  await page.getByLabel(/^Website URL/).fill(siteUrl);
  await page.getByText("Capture settings").click();
  await page.getByLabel("Max pages").fill("2");
  await page.getByRole("button", { name: "Generate Website Template" }).click();

  const panel = page.getByTestId("template-pipeline");
  await expect(panel).toHaveAttribute("data-status", "running", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Generate Website Template" })).toBeDisabled(); // one at a time
  await expect(panel).toHaveAttribute("data-status", "waiting", { timeout: 360_000 });
  for (const [k, s] of [["sar", "done"], ["artifact", "done"], ["wf02", "done"], ["wf03", "done"], ["wf04", "waiting"], ["wf05", "waiting"]]) {
    await expect(stage(page, k)).toHaveAttribute("data-stage-status", s);
  }
  await expect(stage(page, "wf04")).toContainText("Waiting for client-owned authority");
  await expect(stage(page, "wf05")).toContainText("Waiting for brief approval");

  // The artifact: what Web shows, what Web serves, and what SaveAllResources wrote are the same bytes.
  const shown = (await page.getByTestId("artifact-sha").textContent())!.trim();
  const link = panel.getByRole("link", { name: "Download website-template.zip" });
  const href = (await link.getAttribute("href"))!;
  const jobId = href.split("/")[5];
  const served = new Uint8Array(await (await request.get(href)).body());
  expect(sha(served)).toBe(shown);
  const outDir = join(DATA, "sar-runs", jobId, "out");
  const sarZip = readdirSync(outDir).find((f) => f.endsWith("-website-template.zip"))!;
  expect(sha(new Uint8Array(readFileSync(join(outDir, sarZip))))).toBe(shown);
  // It is the real SaveAllResources export: reconstructed template plus raw capture.
  const names = Object.keys(unzipSync(served));
  expect(names).toContain("website-template/manifest.json");
  expect(names.some((n) => n.startsWith("website-template/template/"))).toBe(true);
  expect(names.some((n) => n.startsWith("website-template/raw-capture/pages/"))).toBe(true);
  // SaveAllResources' bulky working data was removed after storing; the log stays for debugging.
  expect(existsSync(join(DATA, "sar-runs", jobId, "sar-data"))).toBe(false);
  expect(existsSync(join(DATA, "sar-runs", jobId, "sar.log"))).toBe(true);

  // WF-02: one reference with one SaveAllResources capture of those bytes.
  await page.goto(`${projectUrl}/references`);
  await expect(page.getByRole("heading", { name: siteUrl }).or(page.getByRole("link", { name: siteUrl })).first()).toBeVisible();
  const refLink = page.getByRole("link", { name: new RegExp(siteUrl.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")) }).first();
  await refLink.click();
  await expect(page.getByText(/^SaveAllResources · captured \d{4}-\d{2}-\d{2}/)).toHaveCount(1);
  await expect(page.getByText(new RegExp(`sha256 ${shown.slice(0, 12)}`))).toBeVisible();

  // WF-03: the normal source page, study only, analysed by the existing scanner.
  await page.goto(projectUrl);
  await stage(page, "wf03").getByRole("link", { name: "source and analysis" }).click();
  await expect(page.getByText(/Study only/).first()).toBeVisible();
  await page.goto(projectUrl);
  const wf03 = (await stage(page, "wf03").textContent())!;
  const digest12 = /digest ([0-9a-f]{12})/.exec(wf03)![1];
  await page.goto(`${projectUrl}/sources`);
  await expect(page.getByRole("link", { name: /SaveAllResources capture/ })).toHaveCount(1); // no duplicate source

  // The same ZIP imported by hand (fallback) analyses to the same digest.
  const other = await newProject(page, "Manual Client");
  await page.goto(`${other}/references`);
  await page.waitForLoadState("networkidle");
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Manual fallback: import a SaveAllResources ZIP" }) });
  await form.getByLabel(/^Export ZIP/).setInputFiles({ name: sarZip, mimeType: "application/zip", buffer: Buffer.from(served) });
  await form.getByRole("button", { name: "Import ZIP" }).click();
  await form.getByRole("link", { name: "Open the source to run the analysis" }).click();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Analysis complete. Digest ${digest12}` })).toBeVisible({ timeout: 60_000 });
  // Exactly one WF-02 capture and one WF-03 source in the generating project.
  const lib = await (await request.get(`/api/projects/${projectId}/references/library`)).json();
  expect(lib.references.flatMap((r: { evidence: { captures: unknown[] } }) => r.evidence.captures)).toHaveLength(1);
});

test("a realistic 100-200 MB SaveAllResources template passes WF-02 and WF-03 with the same bytes", async ({ page, request }) => {
  test.skip(!E2E_SAR_HOME, "SaveAllResources is not installed next to Web (set SAR_HOME)");
  test.setTimeout(600_000);
  const projectUrl = await newProject(page, "Large Template Client");
  await page.goto(projectUrl);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Maximum website template size: 200 MB")).toBeVisible();
  await page.getByLabel(/^Website URL/).fill(`${siteUrl}medium/`);
  await page.getByText("Capture settings").click();
  await page.getByLabel("Max pages").fill("1");
  await page.getByRole("button", { name: "Generate Website Template" }).click();
  const panel = page.getByTestId("template-pipeline");
  await expect(panel).toHaveAttribute("data-status", "waiting", { timeout: 540_000 });
  for (const k of ["sar", "artifact", "wf02", "wf03"]) await expect(stage(page, k)).toHaveAttribute("data-stage-status", "done");
  const size = Number(/\((\d+) bytes\)/.exec((await stage(page, "artifact").textContent())!)![1]);
  expect(size).toBeGreaterThan(100 * 1024 * 1024);
  expect(size).toBeLessThanOrEqual(200 * 1024 * 1024);
  const shown = (await page.getByTestId("artifact-sha").textContent())!.trim();
  const href = (await panel.getByRole("link", { name: "Download website-template.zip" }).getAttribute("href"))!;
  const outDir = join(DATA, "sar-runs", href.split("/")[5], "out");
  const sarZip = readdirSync(outDir).find((f) => f.endsWith("-website-template.zip"))!;
  expect(sha(new Uint8Array(readFileSync(join(outDir, sarZip))))).toBe(shown); // SaveAllResources output
  const served = new Uint8Array(await (await request.get(href)).body());
  expect(served.byteLength).toBe(size);
  expect(sha(served)).toBe(shown); // stored and served
});

test("a real SaveAllResources artifact over the WF-02 limit is kept, downloadable, and blocked from WF-02 with the exact size and limit", async ({ page, request }) => {
  test.skip(!E2E_SAR_HOME, "SaveAllResources is not installed next to Web (set SAR_HOME)");
  test.setTimeout(600_000);
  const projectUrl = await newProject(page, "Oversize Client");
  await page.goto(projectUrl);
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/^Website URL/).fill(`${siteUrl}gallery/`);
  await page.getByText("Capture settings").click();
  await page.getByLabel("Max pages").fill("1");
  await page.getByRole("button", { name: "Generate Website Template" }).click();
  const panel = page.getByTestId("template-pipeline");
  await expect(panel).toHaveAttribute("data-status", "blocked", { timeout: 540_000 });
  await expect(stage(page, "artifact")).toHaveAttribute("data-stage-status", "done");
  await expect(stage(page, "wf02")).toHaveAttribute("data-stage-status", "blocked");
  const text = (await stage(page, "wf02").textContent())!;
  const m = /Artifact too large for WF-02: [\d.]+ MB \((\d+) bytes\); WF-02 accepts captures up to 200\.0 MB \(209715200 bytes\)/.exec(text);
  expect(m).not.toBeNull();
  const size = Number(m![1]);
  expect(size).toBeGreaterThan(209715200);
  // Kept and downloadable, exactly; nothing registered.
  const href = (await panel.getByRole("link", { name: "Download website-template.zip" }).getAttribute("href"))!;
  const served = new Uint8Array(await (await request.get(href)).body());
  expect(served.byteLength).toBe(size);
  expect(sha(served)).toBe((await page.getByTestId("artifact-sha").textContent())!.trim());
  await page.goto(`${projectUrl}/sources`);
  await expect(page.getByRole("link", { name: /SaveAllResources capture/ })).toHaveCount(0);
});

test("the manual fallback refuses a ZIP over the WF-02 limit, stating the limit", async ({ page }) => {
  const projectUrl = await newProject(page, "Fallback Oversize");
  await page.goto(`${projectUrl}/references`);
  await page.waitForLoadState("networkidle");
  const file = join(tmpdir(), `scl-big-${Date.now()}.zip`);
  // 200 MB + 1 byte: one over the limit (the browser refuses it before uploading, as the server would).
  writeFileSync(file, Buffer.alloc(200 * 1024 * 1024 + 1));
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Manual fallback: import a SaveAllResources ZIP" }) });
  await form.getByLabel(/^Export ZIP/).setInputFiles(file);
  await form.getByRole("button", { name: "Import ZIP" }).click();
  await expect(form.getByRole("alert")).toContainText("Captures are limited to 200 MB.");
  rmSync(file, { force: true });
});

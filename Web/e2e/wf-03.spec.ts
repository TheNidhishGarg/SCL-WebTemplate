import { expect, test, type Page } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { TemplateManifest } from "../src/domain/wf03";
import { nextRepo, staticSite } from "../src/server/wf03/test-fixtures";

// WF-03 acceptance, end to end against a production build: register an
// authorised source, analyse it reproducibly, hand it to VS Code via the
// analysis kit, import findings that are checked against the source, extract
// templates only where permitted, and produce the manifest for WF-04/05.

test.describe.configure({ mode: "serial" });

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const section = (page: Page, title: string) => page.locator("section", { has: page.getByRole("heading", { name: startsWith(title), level: 2 }) });

let projectUrl = "";
let ownedUrl = "";
const projectId = () => projectUrl.split("/").pop()!;
const sourceId = () => ownedUrl.split("/").pop()!;

async function upload(page: Page, name: string, bytes: Uint8Array, basis: string, note = "") {
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Register a source archive" }) });
  await form.getByLabel(startsWith("Archive")).setInputFiles({ name: `${name}.zip`, mimeType: "application/zip", buffer: Buffer.from(bytes) });
  await form.getByLabel(startsWith("Name")).fill(name);
  await form.getByLabel("Authority to use this source").selectOption(basis);
  if (note) await form.getByLabel(startsWith("Who authorised it")).fill(note);
  await form.getByRole("button", { name: "Register source" }).click();
  return form;
}

test("register an authorised source; authority must be evidenced", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Source Client");
  await page.getByLabel("Project name").fill("Source project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  projectUrl = page.url().replace(/\/brief$/, "");

  await page.goto(projectUrl);
  await page.getByRole("link", { name: "Open source analysis" }).click();
  await expect(page.getByRole("heading", { name: "Source analysis", level: 1 })).toBeVisible();
  await expect(page.getByText("No sources yet.")).toBeVisible();

  let form = await upload(page, "Client site", staticSite(), "client_owned");
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByText("Record who authorised this, or where the licence is")).toBeVisible();
  await expect(form.getByLabel(startsWith("Name"))).toHaveValue("Client site");

  form = await upload(page, "Client site", staticSite(), "client_owned", "Client's own site files, supplied by their marketing lead on 2026-10-01.");
  await expect(form.getByRole("status")).toContainText("Source registered");
  await page.getByRole("link", { name: "Client site" }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}$/);
  ownedUrl = page.url();
  await expect(page.getByText("Owned or commissioned by the client").first()).toBeVisible();
});

test("analysis is reproducible and reports facts, inferences, risks and questions", async ({ page }) => {
  await page.goto(ownedUrl);
  await expect(page.getByText("Not analysed yet.")).toBeVisible();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Analysis complete." })).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(page.getByText("identical to the previous run")).toBeVisible();

  await expect(section(page, "Overview").getByText("None identified. See the open questions.")).toBeVisible();
  const risks = section(page, "Risks");
  await expect(risks.getByText("Possible Google API key in the source")).toBeVisible();
  await expect(risks.getByText("Form controls without a label")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("AIzaSyA1234567890abcdefghijklmnopqrstuv");
  await expect(section(page, "Unresolved questions").getByText(/No framework, generator or package.json found/)).toBeVisible();
  await expect(section(page, "Assets").getByText("images/missing.png", { exact: true })).toBeVisible();

  const nav = section(page, "Template candidates").getByRole("listitem").filter({ hasText: "header.site-header" });
  await expect(nav.getByText("Observed")).toBeVisible();
  await expect(nav.getByText("Identical markup on 2 pages.")).toBeVisible();
});

test("accept a candidate and extract it, with provenance", async ({ page, request }) => {
  await page.goto(ownedUrl);
  await page.getByRole("button", { name: "Add header.site-header to the template manifest" }).click();
  const manifest = section(page, "In the manifest");
  await expect(manifest.getByText("header.site-header")).toBeVisible();
  await manifest.getByRole("button", { name: "Extract header.site-header" }).click();
  await expect(manifest.getByRole("status")).toContainText("Extracted to workspace/header-site-header/");
  await expect(manifest.getByText(/extracted to workspace\/header-site-header\/ · No build step/)).toBeVisible();

  const ws = unzipSync(new Uint8Array(await (await request.get(`/api/projects/${projectId()}/templates/workspace`)).body()));
  const prov = JSON.parse(new TextDecoder().decode(ws["header-site-header/PROVENANCE.json"]));
  expect(prov.source.authorization.basis).toBe("client_owned");
  expect(prov.files.map((f: { sourcePath: string }) => f.sourcePath)).toEqual(["about.html", "css/site.css", "index.html"]);
  expect(new TextDecoder().decode(ws["header-site-header/snippet.html"])).toContain('<nav class="main-nav">');
});

test("the analysis kit carries instructions, schema, scan and source for VS Code", async ({ request }) => {
  const res = await request.get(`/api/projects/${projectId()}/sources/${sourceId()}/kit`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  const kit = unzipSync(new Uint8Array(await res.body()));
  expect(Object.keys(kit)).toEqual(expect.arrayContaining(["CLAUDE.md", "analysis.json", "findings.schema.json", "findings.example.json", "source/index.html"]));
  expect(new TextDecoder().decode(kit["CLAUDE.md"])).toContain("Never present an assumption as a fact.");
});

test("findings are checked against the source: invented citations reject the file", async ({ page, request }) => {
  const kit = unzipSync(new Uint8Array(await (await request.get(`/api/projects/${projectId()}/sources/${sourceId()}/kit`)).body()));
  const digest = JSON.parse(new TextDecoder().decode(kit["findings.example.json"])).scanDigest;
  const findings = (extra: object[] = []) => ({
    schema: "scl.wf-03.analyst-findings/v1",
    scanDigest: digest,
    findings: [
      { basis: "fact", topic: "styles", statement: "The brand colour is defined once as --brand.", evidence: [{ path: "css/site.css", line: 1 }] },
      { basis: "assumption", topic: "interaction", statement: "The hero probably fades in on load.", evidence: [] },
      ...extra,
    ],
    questions: [{ topic: "assets", text: "Where is images/missing.png served from?" }],
  });

  await page.goto(ownedUrl);
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Import findings from VS Code" }) });
  await form.getByLabel("findings.json").setInputFiles({
    name: "findings.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(findings([{ basis: "fact", topic: "components", statement: "Invented", evidence: [{ path: "src/Hero.tsx", line: 1 }] }]))),
  });
  await form.getByRole("button", { name: "Import" }).click();
  await expect(form.getByRole("alert")).toContainText("Nothing imported");
  await expect(form.getByRole("alert")).toContainText("src/Hero.tsx is not a file in the source");
  await expect(section(page, "Analyst findings").getByText("The brand colour is defined once")).toHaveCount(0);

  await form.getByLabel("findings.json").setInputFiles({ name: "findings.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(findings())) });
  await form.getByRole("button", { name: "Import" }).click();
  await expect(form.getByRole("status")).toHaveText("Imported 2 findings, 1 questions, 0 templates.");
  const f = section(page, "Analyst findings");
  await expect(f.getByText("The brand colour is defined once as --brand.")).toBeVisible();
  await expect(f.getByText("css/site.css:1")).toBeVisible();
  await expect(f.getByText("The hero probably fades in on load.")).toBeVisible();
});

test("questions can be answered and reopened", async ({ page }) => {
  await page.goto(ownedUrl);
  const q = section(page, "Unresolved questions");
  const item = q.getByRole("listitem").filter({ hasText: "Where is images/missing.png served from?" });
  await item.getByRole("textbox", { name: "Answer" }).fill("From the client's CDN; they will send the file.");
  await item.getByRole("button", { name: "Resolve" }).click();
  await expect(q.getByText("Where is images/missing.png served from?")).toBeHidden();
  await q.getByText(/\d+ resolved/).click();
  await expect(q.getByText("From the client's CDN; they will send the file.")).toBeVisible();
});

test("a study-only source is analysed but never extracted, and authority cannot be withdrawn under extracted files", async ({ page }) => {
  await page.goto(`${projectUrl}/sources`);
  const form = await upload(page, "Agency repo (study)", nextRepo(), "study_only");
  await expect(form.getByRole("status")).toContainText("Source registered");
  await page.getByRole("link", { name: "Agency repo (study)" }).click();
  await expect(page.getByText(/Study only\. This source is analysed/)).toBeVisible();
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Analysis complete." })).toBeVisible();
  await expect(section(page, "Overview").getByText("Next.js")).toBeVisible();
  await page.getByRole("button", { name: "Add Header to the template manifest" }).click();
  const manifest = section(page, "In the manifest");
  await expect(manifest.getByText("Not extractable: the source is study only.")).toBeVisible();
  await expect(manifest.getByRole("button", { name: /Extract/ })).toHaveCount(0);

  // The owned source has extracted files: it cannot be downgraded to study only.
  await page.goto(ownedUrl);
  const auth = section(page, "Authority");
  await auth.getByLabel("Authority to use this source").selectOption("study_only");
  await auth.getByRole("button", { name: "Save authority" }).click();
  await expect(auth.getByRole("alert")).toContainText("Templates have been extracted from this source");
});

test("a WF-02 capture can become a source, study only by default", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  const add = page.locator("form", { has: page.getByRole("heading", { name: "Add a reference" }) });
  await add.getByLabel(startsWith("Page URL")).fill("https://studio.example.invalid/");
  await add.getByLabel("Label").fill("Studio");
  await add.getByRole("button", { name: "Add reference" }).click();
  await page.getByRole("link", { name: "Studio" }).click();
  const up = page.locator("form", { has: page.getByRole("heading", { name: "Add a capture" }) });
  const capture = zipSync({ "studio.example.invalid/index.html": strToU8('<!doctype html><html lang="en"><title>Studio</title><body><h1>Studio</h1></body></html>') });
  await up.getByLabel(startsWith("File")).setInputFiles({ name: "studio-capture.zip", mimeType: "application/zip", buffer: Buffer.from(capture) });
  await up.getByRole("button", { name: "Upload capture" }).click();
  await expect(up.getByRole("status")).toContainText("Capture stored");

  await page.goto(`${projectUrl}/sources`);
  const captures = section(page, "From the reference library");
  await expect(captures.getByLabel("Authority to use this source")).toHaveValue("study_only");
  await captures.getByRole("button", { name: "Use as a source" }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}$/);
  await expect(page.getByText("WF-02 capture of https://studio.example.invalid/")).toBeVisible();
  await expect(page.locator(".page-head").getByText("Study only: analyse, never extract")).toBeVisible();
});

test("WF-04/05 receive a manifest that validates and keeps source tokens apart from brand", async ({ request }) => {
  const res = await request.get(`/api/projects/${projectId()}/templates/manifest`);
  expect(res.status()).toBe(200);
  const m = TemplateManifest.parse(await res.json());
  expect(m.sources.map((s) => [s.label, s.authorization.basis, s.authorization.extractionAllowed])).toEqual(
    expect.arrayContaining([
      ["Client site", "client_owned", true],
      ["Agency repo (study)", "study_only", false],
    ]),
  );
  const header = m.templates.find((t) => t.name === "header.site-header")!;
  expect(header.extraction.status).toBe("extracted");
  expect(header.files.every((f) => f.sha256)).toBe(true);
  expect(m.templates.find((t) => t.name === "Header")!.extraction.status).toBe("not_extracted");
  expect(m.sourceTokens.find((t) => t.sourceId === header.sourceId)!.customProperties.map((c) => c.name)).toEqual(["--brand", "--space-2"]);
  expect(m.notices.sourceTokens).toMatch(/WF-04 decides brand tokens/);
});

test("the source page fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(ownedUrl);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

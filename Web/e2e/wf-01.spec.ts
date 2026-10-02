import { expect, test, type Page } from "@playwright/test";
import { BriefHandoff } from "../src/domain/brief-handoff";

// The WF-01 acceptance criteria, end to end against a production build:
// create a project, save and edit its brief, attach asset references, reopen
// it, and pass the structured brief on. Specs run in order on one database.

test.describe.configure({ mode: "serial" });

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

let projectUrl = "";

// Required headings and labels carry a CSS " *" marker, which Chromium
// includes in the accessible name, so match from the start instead of exactly.
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const section = (page: Page, title: string) =>
  page.locator("section", { has: page.getByRole("heading", { name: startsWith(title), level: 2 }) });

test("an empty dashboard explains what to do", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
});

test("project creation validates required fields", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Check the highlighted fields" })).toBeVisible();
  await expect(page.getByText("Project name is required")).toBeVisible();
  await expect(page.getByLabel("Client or business name")).toHaveAttribute("aria-invalid", "true");

  // Fixing one field and resubmitting keeps what was already typed.
  await page.getByLabel("Client or business name").fill("Kept Client");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page.getByText("Project name is required")).toBeVisible();
  await expect(page.getByLabel("Client or business name")).toHaveValue("Kept Client");
});

test("create a project, save a partial brief, and find it again after reload", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Anaïs Events");
  await page.getByLabel("Project name").fill("Anaïs website 2026");
  await page.getByRole("button", { name: "Create project and start brief" }).click();

  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/brief$/);
  projectUrl = page.url().replace(/\/brief$/, "");
  await expect(page.getByRole("heading", { name: "Client brief" })).toBeVisible();

  await page.getByLabel(/Website \+ cinematic journey/).check();
  await page.getByLabel("Industry").fill("Wedding planning");
  await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Industry")).toHaveValue("Wedding planning");
  await expect(page.getByLabel(/Website \+ cinematic journey/)).toBeChecked();
});

test("an incomplete brief cannot be approved, and says why", async ({ page }) => {
  await page.goto(`${projectUrl}/brief`);
  await page.getByRole("button", { name: "Approve version 1" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "cannot be approved yet" });
  await expect(summary).toBeVisible();
  for (const s of ["Target audiences", "Business objectives", "Required pages", "Desired actions", "Cinematic journey"]) {
    await expect(summary.getByRole("link", { name: s })).toBeVisible();
  }
  // ...and marks the field itself.
  await expect(page.getByLabel(startsWith("Project summary"))).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Project summary is required", { exact: true })).toBeVisible();
  // Nothing was approved.
  await page.goto(projectUrl);
  await expect(page.getByText("Brief in progress")).toBeVisible();
});

test("complete and approve the brief", async ({ page }) => {
  await page.goto(`${projectUrl}/brief`);
  await page.getByLabel("Current website URL").fill("https://anais.example.com");
  await page.getByLabel("Project summary").fill("An editorial portfolio and enquiry site for a destination wedding studio.");

  const audiences = section(page, "Target audiences");
  await audiences.getByRole("button", { name: "Add audience" }).click();
  await audiences.getByRole("textbox", { name: "Audience 1", exact: true }).fill("Couples planning a destination wedding");
  await audiences.getByLabel("What they need").fill("Proof of taste and a quick way to enquire");

  const objectives = section(page, "Business objectives");
  await objectives.getByRole("button", { name: "Add objective" }).click();
  await objectives.getByRole("textbox", { name: "Objective 1", exact: true }).fill("30 qualified enquiries a month");

  const pages = section(page, "Required pages");
  await pages.getByRole("button", { name: "Add page" }).click();
  await pages.getByRole("textbox", { name: "Page 1 title", exact: true }).fill("Our Work");
  await pages.getByLabel("Purpose").fill("Show recent weddings");
  await pages.getByRole("textbox", { name: "Page 1 title", exact: true }).blur();
  await expect(pages.getByLabel("Slug")).toHaveValue("our-work");
  // An unused blank row must not block approval.
  await pages.getByRole("button", { name: "Add page" }).click();

  const actions = section(page, "Desired actions");
  await actions.getByRole("button", { name: "Add action" }).click();
  await actions.getByLabel("Details").fill("Enquiry form with date and guest count");

  const refs = section(page, "Reference websites");
  await refs.getByRole("button", { name: "Add reference" }).click();
  await refs.getByRole("textbox", { name: "Reference 1 URL", exact: true }).fill("https://www.example.org/journal");

  const cinematic = section(page, "Cinematic journey");
  await cinematic.getByLabel("Journey intent").fill("Arrive at the venue at dusk and choose a ceremony style.");
  await cinematic.getByLabel("Target runtime (seconds)").fill("90");
  await cinematic.getByLabel("Visitors choose between paths").check();

  await expect(page.getByRole("heading", { name: "Completeness · 100%" })).toBeVisible();
  await page.getByRole("button", { name: "Approve version 1" }).click();

  await expect(page.getByText("This version is approved and frozen")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start revision (version 2)" })).toBeVisible();
  await expect(page.getByText("/our-work")).toBeVisible();
});

test("attach asset references: an upload, a link, and a rejected file", async ({ page }) => {
  await page.goto(`${projectUrl}/assets`);
  await expect(page.getByText("Nothing recorded yet")).toBeVisible();

  const upload = page.locator("form", { has: page.getByRole("heading", { name: "Upload a file" }) });
  await upload.getByLabel(startsWith("File")).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await upload.getByLabel("Label").fill("Primary logo");
  await upload.getByRole("button", { name: "Upload" }).click();
  await expect(upload.getByRole("status")).toHaveText("File uploaded and added to the register.");
  await expect(page.getByRole("link", { name: /logo\.png/ })).toBeVisible();

  // A wrong file type is stopped in the form before uploading...
  await upload.getByLabel("Kind").selectOption("font");
  await upload.getByLabel(startsWith("File")).setInputFiles({ name: "font.exe", mimeType: "application/octet-stream", buffer: PNG });
  await upload.getByLabel("Label").fill("Not a font");
  await upload.getByRole("button", { name: "Upload" }).click();
  await expect(upload.getByRole("alert")).toContainText("must be one of");

  // ...and refused by the server when the form is bypassed.
  const projectId = projectUrl.split("/").pop();
  const direct = await page.request.post(`/api/projects/${projectId}/assets`, {
    multipart: { kind: "font", label: "Not a font", notes: "", file: { name: "font.exe", mimeType: "application/octet-stream", buffer: PNG } },
  });
  expect(direct.status()).toBe(422);
  expect((await direct.json()).error).toContain("must be one of");
  await page.reload();
  await expect(page.getByText("Not a font")).toHaveCount(0);

  const link = page.locator("form", { has: page.getByRole("heading", { name: "Record a link" }) });
  await link.getByLabel("Kind").selectOption("brand_guidelines");
  await link.getByLabel("URL").fill("not a url");
  await link.getByLabel("Label").fill("Brand book");
  await link.getByRole("button", { name: "Add link" }).click();
  await expect(link.getByRole("alert")).toBeVisible();
  await expect(link.getByText("Enter a full http(s) URL")).toBeVisible();
  // A failed submit keeps what was entered, including the kind.
  await expect(link.getByLabel("Kind")).toHaveValue("brand_guidelines");
  await expect(link.getByLabel("Label")).toHaveValue("Brand book");

  await link.getByLabel("URL").fill("https://drive.example.com/brand-book");
  await link.getByRole("button", { name: "Add link" }).click();
  await expect(link.getByRole("status")).toHaveText("Link added to the register.");
  const brandBook = page.getByRole("listitem").filter({ hasText: "Brand book" });
  await expect(brandBook.getByText("Brand guidelines", { exact: true })).toBeVisible();
  await expect(brandBook.getByRole("link", { name: "https://drive.example.com/brand-book" })).toBeVisible();

  // The uploaded file downloads byte-for-byte, as an attachment.
  const fileHref = await page.getByRole("link", { name: /logo\.png/ }).getAttribute("href");
  const res = await page.request.get(fileHref!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(Buffer.compare(await res.body(), PNG)).toBe(0);
});

test("reopen the project from the dashboard and hand the brief on", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("region", { name: "All projects" }).getByRole("link", { name: "Anaïs website 2026" }).click();
  await expect(page).toHaveURL(projectUrl);
  await expect(page.getByText("Brief approved").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "View handoff JSON" })).toBeVisible();

  const projectId = projectUrl.split("/").pop();
  const res = await page.request.get(`/api/projects/${projectId}/handoff`);
  expect(res.status()).toBe(200);
  const handoff = BriefHandoff.parse(await res.json());
  expect(handoff.brief.version).toBe(1);
  expect(handoff.project.clientName).toBe("Anaïs Events");
  expect(handoff.brief.content.deliveryMode).toBe("combined");
  expect(handoff.brief.content.requiredPages).toEqual([{ slug: "our-work", title: "Our Work", purpose: "Show recent weddings" }]);
  expect(handoff.brief.content.cinematic).toMatchObject({ targetRuntimeSeconds: 90, branching: true });
  expect(handoff.assets.map((a) => [a.label, a.kind]).sort()).toEqual([
    ["Brand book", "brand_guidelines"],
    ["Primary logo", "logo"],
  ]);
});

test("a revision keeps the approved version in force until it is approved", async ({ page }) => {
  await page.goto(`${projectUrl}/brief`);
  await page.getByRole("button", { name: "Start revision (version 2)" }).click();
  await expect(page.getByRole("button", { name: "Approve version 2" })).toBeVisible();
  await page.getByLabel("Industry").fill("Luxury destination weddings");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();

  const projectId = projectUrl.split("/").pop();
  const handoff = BriefHandoff.parse(await (await page.request.get(`/api/projects/${projectId}/handoff`)).json());
  expect(handoff.brief.version).toBe(1);
  expect(handoff.brief.content.industry).toBe("Wedding planning");
});

test("a stale editor is told its save failed, never that it succeeded", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await a.goto(`${projectUrl}/brief`);
  await b.goto(`${projectUrl}/brief`);

  // Tab A approves version 2.
  await a.getByRole("button", { name: "Approve version 2" }).click();
  await expect(a.getByText("This version is approved and frozen")).toBeVisible();

  // Tab B still shows the version 2 draft and tries to save over it.
  await b.getByLabel("Industry").fill("Edited in a stale tab");
  await b.getByRole("button", { name: "Save draft" }).click();
  await expect(b.getByRole("alert").filter({ hasText: "This brief changed since you opened it" })).toBeVisible();
  await expect(b.getByRole("status").filter({ hasText: "Not saved" })).toBeVisible();
  await expect(b.getByText("All changes saved")).toHaveCount(0);

  const projectId = projectUrl.split("/").pop();
  const handoff = BriefHandoff.parse(await (await b.request.get(`/api/projects/${projectId}/handoff`)).json());
  expect(handoff.brief.version).toBe(2);
  expect(handoff.brief.content.industry).toBe("Luxury destination weddings");
});

test("the handoff distinguishes a missing project from an unapproved brief", async ({ page, request }) => {
  expect((await request.get("/api/projects/00000000-0000-4000-8000-000000000000/handoff")).status()).toBe(404);
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Second Client");
  await page.getByLabel("Project name").fill("Draft only");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  const id = page.url().split("/").at(-2);
  const res = await request.get(`/api/projects/${id}/handoff`);
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toContain("No approved brief yet");
});

test("the dashboard fits a phone screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["/projects", projectUrl, `${projectUrl}/assets`]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Phone Client");
  await page.getByLabel("Project name").fill("Phone project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("an unknown project shows a not-found page", async ({ page }) => {
  // The page streams (it has a loading state), so Next.js has already sent a
  // 200 when notFound() runs and marks the page noindex instead - a soft 404,
  // documented in next/dist/docs loading.md "Status Codes". Machine consumers
  // use the handoff API, which returns a real 404 (tested above).
  await page.goto("/projects/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content="noindex"]').first()).toBeAttached();
});

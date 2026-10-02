import { expect, test, type Page } from "@playwright/test";
import { ReferenceLibrary } from "../src/domain/reference-library";

// WF-02 acceptance, end to end against a production build: add, organise,
// review and update references; failed acquisition is visible and
// recoverable; WF-03 gets a documented export.
//
// No test depends on the internet. The two URL checks here fail for real,
// deterministically: a private address the check refuses to contact, and a
// .invalid domain that can never resolve.

test.describe.configure({ mode: "serial" });

const PRIVATE_URL = "http://127.0.0.1:3100/projects";
const INVALID_URL = "https://portfolio.example.invalid/work";
const ZIP = Buffer.from("504b0304140000000800", "hex");

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const section = (page: Page, title: string) =>
  page.locator("section", { has: page.getByRole("heading", { name: startsWith(title), level: 2 }) });

let projectUrl = "";

async function createApprovedProject(page: Page) {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Reference Client");
  await page.getByLabel("Project name").fill("References project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  projectUrl = page.url().replace(/\/brief$/, "");

  await page.getByLabel(/Conventional website/).check();
  await page.getByLabel(startsWith("Industry")).fill("Architecture");
  await page.getByLabel(startsWith("Project summary")).fill("Portfolio site for an architecture practice.");
  const add = async (sectionTitle: string, button: string) => section(page, sectionTitle).getByRole("button", { name: button }).click();
  await add("Target audiences", "Add audience");
  await page.getByRole("textbox", { name: "Audience 1", exact: true }).fill("Developers");
  await page.getByLabel("What they need").fill("Evidence of delivery");
  await add("Business objectives", "Add objective");
  await page.getByRole("textbox", { name: "Objective 1", exact: true }).fill("Win two commissions a year");
  await add("Required pages", "Add page");
  await page.getByRole("textbox", { name: "Page 1 title", exact: true }).fill("Home");
  // Leaving the title suggests the slug; wait for it rather than racing it.
  await page.getByRole("textbox", { name: "Page 1 title", exact: true }).blur();
  await expect(page.getByLabel("Slug")).toHaveValue("home");
  await page.getByLabel("Purpose").fill("Introduce the practice");
  await add("Desired actions", "Add action");
  await page.getByLabel("Details").fill("Enquiry form");
  for (const [i, url] of [PRIVATE_URL, INVALID_URL].entries()) {
    await add("Reference websites", "Add reference");
    await page.getByRole("textbox", { name: `Reference ${i + 1} URL`, exact: true }).fill(url);
  }
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("This version is approved and frozen")).toBeVisible();
}

const projectId = () => projectUrl.split("/").pop()!;

test("an empty library explains itself and imports the brief's references", async ({ page }) => {
  await createApprovedProject(page);
  await page.goto(projectUrl);
  await page.getByRole("link", { name: "Start WF-02: build the reference library from the approved brief" }).click();
  await expect(page.getByRole("heading", { name: "Reference library" })).toBeVisible();
  await expect(page.getByText("No references yet.")).toBeVisible();
  await expect(page.getByText(/Research input only/).first()).toBeVisible();

  await page.getByRole("button", { name: "Import 2 URLs from brief v1" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 added from brief version 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "127.0.0.1", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "portfolio.example.invalid", level: 3 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Brief URLs already imported" })).toBeDisabled();
});

test("adding a reference by hand validates and refuses duplicates without losing input", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Add a reference" }) });
  await form.getByLabel("Label").fill("Studio grid");
  await form.getByLabel(startsWith("Page URL")).fill("ftp://nope");
  await form.getByRole("button", { name: "Add reference" }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByText("Enter a full http(s) URL without a username or password")).toBeVisible();
  await expect(form.getByLabel("Label")).toHaveValue("Studio grid");

  await form.getByLabel(startsWith("Page URL")).fill(`${INVALID_URL}#section?`);
  await form.getByRole("button", { name: "Add reference" }).click();
  await expect(form.getByRole("alert")).toContainText("already in the library");

  await form.getByLabel(startsWith("Page URL")).fill("https://studio.example.invalid/grid");
  await form.getByLabel("Page type").fill("Portfolio index");
  await form.getByRole("button", { name: "Add reference" }).click();
  await expect(form.getByRole("status")).toContainText("Reference added");
  await expect(page.getByRole("link", { name: "Studio grid" })).toBeVisible();
});

test("a failed check is recorded as evidence and shown with ways to recover", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByRole("link", { name: PRIVATE_URL }).click();
  await expect(page.locator(".page-head").getByText("Not yet acquired")).toBeVisible();

  await page.getByRole("button", { name: "Check URL now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Check recorded: Not checked: address not allowed" })).toBeVisible();
  const evidence = section(page, "Acquired evidence");
  await expect(evidence.getByText("System URL check")).toBeVisible();
  await expect(evidence.getByText(/127\.0\.0\.1 is a private or internal address/)).toBeVisible();
  await expect(page.getByText("Acquisition failed: Not checked: address not allowed.")).toBeVisible();
  await expect(page.getByText(/To recover:/)).toBeVisible();

  // A person's own failed attempt is recorded as theirs.
  const failForm = page.locator("form", { has: page.getByRole("heading", { name: "Record a failed capture" }) });
  await failForm.getByRole("button", { name: "Record attempt" }).click();
  await expect(failForm.getByText("Say what happened, so the next person knows")).toBeVisible();
  await failForm.getByLabel(startsWith("Details")).fill("SaveMyResources saved an empty archive on the first try.");
  await failForm.getByRole("button", { name: "Record attempt" }).click();
  await expect(failForm.getByRole("status")).toHaveText("Recorded in the attempt log.");
  await expect(evidence.getByText("Reported by a person")).toBeVisible();
});

test("recover by uploading a SaveMyResources capture; the failures stay on record", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByRole("link", { name: PRIVATE_URL }).click();

  const upload = page.locator("form", { has: page.getByRole("heading", { name: "Add a capture" }) });
  await expect(upload.getByLabel(startsWith("Tool"))).toHaveValue("SaveMyResources");
  await upload.getByLabel(startsWith("File")).setInputFiles({ name: "dashboard.zip", mimeType: "application/zip", buffer: ZIP });
  await upload.getByLabel("Notes").fill("Projects page, logged out");
  await upload.getByRole("button", { name: "Upload capture" }).click();
  await expect(upload.getByRole("status")).toHaveText("Capture stored and recorded as evidence.");

  await expect(page.locator(".page-head").getByText("Captured", { exact: true })).toBeVisible();
  const attempts = page.getByRole("list", { name: "Acquisition attempts, newest first" });
  await expect(attempts.getByRole("listitem")).toHaveCount(3);
  await expect(attempts.getByRole("listitem").first()).toContainText("Captured");
  await expect(attempts).toContainText("Not checked: address not allowed");
  await expect(attempts).toContainText("Capture failed");

  const href = await page.getByRole("link", { name: "dashboard.zip" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(Buffer.compare(await res.body(), ZIP)).toBe(0);
});

test("observations and inferences are recorded, kept apart, and editable", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByRole("link", { name: PRIVATE_URL }).click();
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Add an observation" }) });

  await form.getByLabel("Aspect").selectOption("layout");
  await form.getByLabel("Based on").selectOption({ label: "Capture: dashboard.zip" });
  await form.getByLabel(startsWith("Observation")).fill("Two-column card grid with a sticky sidebar");
  await form.getByRole("button", { name: "Add observation" }).click();
  await expect(form.getByRole("status")).toHaveText("Added.");

  await form.getByLabel("Aspect").selectOption("interaction");
  await form.getByLabel(/^Inferred/).check();
  await form.getByLabel(startsWith("Observation")).fill("Probably animates cards on scroll");
  await form.getByRole("button", { name: "Add observation" }).click();

  const observed = section(page, "Observations");
  const inferred = section(page, "Inferences");
  await expect(observed.getByText("Two-column card grid with a sticky sidebar")).toBeVisible();
  await expect(observed.getByText("From capture dashboard.zip")).toBeVisible();
  await expect(observed.getByText("Probably animates cards on scroll")).toHaveCount(0);
  await expect(inferred.getByText("Probably animates cards on scroll")).toBeVisible();

  await observed.getByRole("button", { name: "Edit" }).click();
  await observed.getByLabel(startsWith("Observation")).fill("Two-column card grid; one column on mobile");
  await observed.getByRole("button", { name: "Save" }).click();
  await expect(observed.getByText("Two-column card grid; one column on mobile")).toBeVisible();
});

test("organise a reference against the brief's pages", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByRole("link", { name: PRIVATE_URL }).click();
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Organise" }) });
  await form.getByLabel("Label").fill("Local dashboard");
  await form.getByLabel("Page type").fill("Project index");
  await form.getByLabel(/Home/).check();
  await form.getByLabel("Attribution").fill("© SCL");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
  await expect(page.getByRole("heading", { name: "Local dashboard", level: 1 })).toBeVisible();
});

test("an unreachable reference can be marked for manual observation, and cleared", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByRole("link", { name: INVALID_URL }).click();
  await page.getByRole("button", { name: "Check URL now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Check recorded: Could not connect" })).toBeVisible();
  await expect(page.getByText(/Could not reach the page/).first()).toBeVisible();

  const manual = page.locator("form", { has: page.getByRole("heading", { name: "Cannot be acquired?" }) });
  await manual.getByLabel(startsWith("Why")).fill("Domain does not resolve; the client described it from memory.");
  await manual.getByRole("button", { name: "Mark as manual observation only" }).click();
  await expect(page.locator(".page-head").getByText("Manual observations only")).toBeVisible();
  await page.getByRole("button", { name: "Clear, and try acquiring again" }).click();
  await expect(page.locator(".page-head").getByText("Acquisition failed")).toBeVisible();
  await page.getByLabel(startsWith("Why")).fill("Domain does not resolve; the client described it from memory.");
  await page.getByRole("button", { name: "Mark as manual observation only" }).click();
  await expect(page.locator(".page-head").getByText("Manual observations only")).toBeVisible();
});

test("filter the library by status, client page and aspect", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByLabel("Status").selectOption("captured");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("heading", { name: "Matching references (1)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Local dashboard" })).toBeVisible();

  await page.goto(`${projectUrl}/references?aspect=interaction`);
  await expect(page.getByRole("heading", { name: "Matching references (1)" })).toBeVisible();
  await page.goto(`${projectUrl}/references?page=home`);
  await expect(page.getByRole("link", { name: "Local dashboard" })).toBeVisible();
  await page.goto(`${projectUrl}/references?status=failed`);
  await expect(page.getByText("No references match these filters.")).toBeVisible();
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page.getByRole("heading", { name: "References by site" })).toBeVisible();
});

test("WF-03 receives a documented export that keeps evidence, observation and inference apart", async ({ request }) => {
  const res = await request.get(`/api/projects/${projectId()}/references/library`);
  expect(res.status()).toBe(200);
  const lib = ReferenceLibrary.parse(await res.json());
  expect(lib.summary).toMatchObject({ references: 3, sites: 3, byStatus: { captured: 1, manual: 1, pending: 1, failed: 0, checked: 0 } });
  expect(lib.brief).toMatchObject({ version: 1, requiredPageSlugs: ["home"] });

  const local = lib.references.find((r) => r.url === PRIVATE_URL)!;
  expect(local).toMatchObject({ label: "Local dashboard", pageType: "Project index", targetPages: ["home"], attribution: "© SCL", origin: "brief", status: "captured" });
  expect(local.evidence.attempts.map((a) => [a.outcome, a.recordedBy, a.succeeded])).toEqual([
    ["captured", "user", true],
    ["capture_failed", "user", false],
    ["blocked_by_policy", "system", false],
  ]);
  expect(local.evidence.captures[0]).toMatchObject({ tool: "SaveMyResources", filename: "dashboard.zip", notes: "Projects page, logged out" });
  expect(local.observed.map((o) => [o.aspect, o.text])).toEqual([["layout", "Two-column card grid; one column on mobile"]]);
  expect(local.observed[0].captureId).toBe(local.evidence.captures[0].id);
  expect(local.inferred.map((i) => [i.source, i.text])).toEqual([["person", "Probably animates cards on scroll"]]);

  const invalid = lib.references.find((r) => r.url === INVALID_URL)!;
  expect(invalid).toMatchObject({ status: "manual", manualReason: "Domain does not resolve; the client described it from memory." });
  expect(invalid.evidence.attempts[0]).toMatchObject({ outcome: "unreachable", recordedBy: "system", succeeded: false });

  // The capture download path in the export works.
  const file = await request.get(local.evidence.captures[0].downloadPath);
  expect(file.status()).toBe(200);
});

test("removing the only capture puts the failure back in view", async ({ page }) => {
  await page.goto(`${projectUrl}/references`);
  await page.getByRole("link", { name: "Local dashboard" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove capture dashboard.zip" }).click();
  await expect(page.locator(".page-head").getByText("Acquisition failed")).toBeVisible();
  // The explanation names the attempt the status rests on, not the deleted capture.
  await expect(page.getByText("Acquisition failed: Capture failed.")).toBeVisible();
  await expect(page.getByText(/Acquisition failed: Captured/)).toHaveCount(0);
  // The observation survives, without its link to the deleted file.
  await expect(section(page, "Observations").getByText("From the live page")).toBeVisible();

  await page.goto(projectUrl);
  await expect(page.getByRole("link", { name: "1 reference failed acquisition: recover or record manually" })).toBeVisible();
});

test("the reference pages fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${projectUrl}/references`);
  const libOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(libOverflow).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: "Local dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Local dashboard", level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

import { expect, type Page } from "@playwright/test";

// Builds, through the dashboard, what WF-08 needs: an approved brand,
// published Home and Contact pages, the sample journey (entered from Home)
// approved, and its production with takes approved or shots blocked.
// Footage is the TEST FIXTURE video from ./video.ts, uploaded as
// "E2E test fixture" - never presented as production media.

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

export async function publishedSite(page: Page, name: string, primary: string) {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill(name);
  await page.getByLabel("Project name").fill(`${name} site`);
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  const projectUrl = page.url().replace(/\/brief$/, "");
  const projectId = projectUrl.split("/").pop()!;

  await page.goto(`${projectUrl}/assets`);
  const up = page.locator("form", { has: page.getByRole("heading", { name: "Upload a file" }) });
  await up.getByLabel(/^File/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await up.getByLabel("Label").fill("Logo");
  await up.getByRole("button", { name: "Upload" }).click();
  await expect(up.getByRole("status")).toBeVisible();

  await page.goto(`${projectUrl}/brands`);
  await page.getByRole("button", { name: "Create brand" }).click();
  await expect(page).toHaveURL(/\/brands\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Primary", { exact: true }).fill(primary);
  await page.getByLabel("Heading font family", { exact: true }).fill("Georgia");
  await page.getByLabel("Body font family", { exact: true }).fill("Arial");
  await page.getByRole("button", { name: "Add logo" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("Version 1 is approved and frozen.")).toBeVisible();

  for (const [title, slug] of [["Contact", "contact"], ["Home", ""]]) {
    await page.goto(`${projectUrl}/pages`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel(/^Title/).fill(title);
    await page.getByLabel("Path").fill(slug);
    await page.getByRole("button", { name: "Create page" }).click();
    await expect(page).toHaveURL(/\/pages\/[0-9a-f-]{36}$/);
    await page.waitForLoadState("networkidle");
    await page.getByLabel(/^Meta description/).fill(`${title} page of ${name}, an architecture studio building in timber.`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for review." })).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Approved." })).toBeVisible();
    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
  }

  await page.goto(`${projectUrl}/journeys`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/^Name/).fill("Site visit");
  await page.getByLabel("Start from").selectOption("sample");
  await page.getByRole("button", { name: "Create journey" }).click();
  await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Entry point").selectOption({ label: "From page: Home" });
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("Version 1 is approved and frozen.")).toBeVisible();

  await page.goto(`${projectUrl}/production`);
  await page.getByRole("button", { name: "Start production: Site visit · v1" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]{36}$/);
  return { projectId, projectUrl, productionUrl: page.url() };
}

const scene = (page: Page, title: string) => page.getByRole("region", { name: new RegExp(`^\\d+\\. ${title}`) });

export async function approveTake(page: Page, title: string, video: Buffer) {
  await page.waitForLoadState("networkidle");
  const s = scene(page, title);
  await s.getByLabel(/^File/).setInputFiles({ name: "e2e-test-fixture.mp4", mimeType: "video/mp4", buffer: video });
  await s.getByLabel(/^Made with/).fill("E2E test fixture (not production media)");
  await s.getByRole("button", { name: "Upload take" }).click();
  await expect(s.getByText("Uploaded. Checks passed; review it below.")).toBeVisible();
  const take = s.getByRole("group", { name: "Take e2e-test-fixture.mp4" });
  for (const box of await take.getByRole("checkbox").all()) await box.check();
  await take.getByRole("button", { name: "Approve take" }).click();
  await expect(s.getByTestId("shot-status")).toHaveText("Approved");
}

export async function blockShot(page: Page, title: string) {
  await page.waitForLoadState("networkidle");
  const s = scene(page, title);
  await s.getByText("Can't be produced? Mark it blocked").click();
  await s.getByLabel(/^Why is this shot blocked\?/).fill("Client is supplying this footage");
  await s.getByRole("button", { name: "Mark blocked" }).click();
  await expect(s.getByTestId("shot-status")).toHaveText("Blocked");
}

export async function publishJourney(page: Page) {
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Ready to publish.")).toBeVisible();
  await page.getByRole("button", { name: "Publish to the website" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Release \d+ is live/ })).toBeVisible();
}

import { expect, test, type Page } from "@playwright/test";
import { JourneySpec, SceneManifest } from "../src/domain/journey-contract";

// WF-06 acceptance against a production build: a complete storyboard is
// reviewed and exported without generating any video, branches are
// structurally checked, and every scene carries what production needs.

test.describe.configure({ mode: "serial" });

let projectUrl = "";
let journeyUrl = "";
const ids = () => {
  const parts = new URL(journeyUrl).pathname.split("/");
  return { projectId: parts[2], journeyId: parts[4] };
};
const checks = (page: Page) => page.locator("aside[aria-label='Checks']");
const card = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^Scene ${title},`) });

test("start from the sample: the storyboard shows every scene, step by step", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Journey Client");
  await page.getByLabel("Project name").fill("Journey project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  projectUrl = page.url().replace(/\/brief$/, "");

  await page.goto(projectUrl);
  await page.getByRole("link", { name: /^Journeys \(/ }).click();
  await expect(page.getByText("No journeys yet.")).toBeVisible();
  await page.getByLabel(/^Name/).fill("Site visit");
  await page.getByLabel("Start from").selectOption("sample");
  await page.getByRole("button", { name: "Create journey" }).click();
  await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);
  journeyUrl = page.url();

  const board = page.getByRole("list", { name: "Scenes by step from the opening" });
  await expect(board.getByRole("listitem")).toHaveCount(5); // 5 steps: opening, choice, two paths, invitation, closing
  await expect(board.getByRole("listitem", { name: "Step 3" }).getByRole("button")).toHaveCount(2);
  await expect(card(page, "Choose a building")).toContainText("“Homes” → Homes");
  await expect(card(page, "Start a conversation")).toContainText("CTA: Talk to the studio");
  await expect(checks(page).getByText("0 item(s) block approval.")).toBeVisible();
});

test("structural problems are caught: unreachable branches, orphans, invalid transitions", async ({ page }) => {
  await page.goto(journeyUrl);
  await card(page, "Choose a building").click();
  await page.getByLabel("Choice 2 leads to").selectOption({ label: "Closing (Ending)" });
  await expect(checks(page).getByText('Unreachable: no path from the opening leads to "Public buildings"')).toBeVisible();
  await expect(checks(page).getByText('Warning: Branch "Public buildings" of "Choose a building" never reaches a conversion scene')).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Not connected" })).toContainText("Public buildings");
  await page.getByLabel("Choice 2 leads to").selectOption({ label: "Public buildings (Information)" });
  await expect(page.getByRole("listitem", { name: "Not connected" })).toHaveCount(0);

  await card(page, "Homes").click();
  await page.getByLabel("Next scene").selectOption({ label: "Arrival at dusk (Opening)" });
  await expect(checks(page).getByText('Invalid transition: "Homes" leads back to the opening scene')).toBeVisible();
  await page.getByLabel("Next scene").selectOption({ label: "Start a conversation (Conversion)" });

  await page.getByLabel("New scene type").selectOption("information");
  await page.getByRole("button", { name: "Add scene" }).click();
  await expect(checks(page).getByText('Unreachable: no path from the opening leads to "New information"')).toBeVisible();
  await expect(checks(page).getByText('"New information": visual description is missing')).toBeVisible();
  await page.getByRole("button", { name: "Delete scene" }).click();
  await expect(checks(page).getByText("0 item(s) block approval.")).toBeVisible();
});

test("interface text stays out of footage", async ({ page }) => {
  await page.goto(journeyUrl);
  await card(page, "Start a conversation").click();
  const prompt = page.getByLabel(/^Prompt/);
  const original = await prompt.inputValue();
  await prompt.fill(`${original}, with a caption reading Book now`);
  await expect(checks(page).getByText(/mentions "caption"/)).toBeVisible();
  await prompt.fill(original);
  await expect(checks(page).getByText(/mentions "caption"/)).toHaveCount(0);
});

test("approve and export the scene manifest and journey spec, with no video", async ({ page, request }) => {
  await page.goto(journeyUrl);
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("Version 1 is approved and frozen.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Scenes in playback order" }).getByRole("listitem")).toHaveCount(6);

  const { projectId, journeyId } = ids();
  const manifest = SceneManifest.parse(await (await request.get(`/api/projects/${projectId}/journeys/${journeyId}/scene-manifest`)).json());
  const spec = JourneySpec.parse(await (await request.get(`/api/projects/${projectId}/journeys/${journeyId}/journey-spec`)).json());
  expect(manifest.version).toMatchObject({ number: 1, status: "approved" });
  expect(manifest.scenes.every((s) => s.purpose && s.visual.description && s.visual.lighting && s.prompt.positive && s.assetSlots.length > 0)).toBe(true);
  expect(manifest.scenes.every((s) => /no on-screen text/.test(s.prompt.negative))).toBe(true);
  expect(spec.scenes.map((s) => s.id)).toEqual(manifest.scenes.map((s) => s.id));
  expect(spec.startSceneId).toBe(manifest.scenes[0].id);
  const decision = spec.scenes.find((s) => s.type === "decision")!;
  expect(decision.choice?.branches.map((b) => b.label)).toEqual(["Homes", "Public buildings"]);
  expect(manifest.scenes.find((s) => s.id === decision.id)!.overlays.map((o) => o.kind)).toEqual(["choice", "choice"]);
});

test("a template journey cannot be approved until it is complete", async ({ page }) => {
  await page.goto(`${projectUrl}/journeys`);
  await page.getByLabel(/^Name/).fill("Draft journey");
  await page.getByLabel("Start from").selectOption("linear");
  await page.getByRole("button", { name: "Create journey" }).click();
  await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("list", { name: "Scenes by step from the opening" }).getByRole("listitem")).toHaveCount(4);
  await page.getByRole("button", { name: "Approve version 1" }).click();
  const alert = page.getByRole("alert").filter({ hasText: /Not approved: \d+ item\(s\) to fix\./ });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('"Opening": generation prompt is missing');
});

test("the storyboard fits a phone screen; the board scrolls on its own", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${projectUrl}/journeys`);
  await page.getByRole("link", { name: "Draft journey" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

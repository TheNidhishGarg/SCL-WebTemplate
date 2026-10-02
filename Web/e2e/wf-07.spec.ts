import { expect, test, type Page } from "@playwright/test";
import { AssetManifest } from "../src/domain/production";
import { synthMp4 } from "../src/server/production/media";

// WF-07 acceptance against a production build with no provider credentials
// (none exist for this project yet): providers say so and refuse, and every
// shot ends approved via manual upload or explicitly blocked. Generation
// against Runway/Veo is covered by unit tests with documented responses.

test.describe.configure({ mode: "serial" });

let productionUrl = "";
const mp4 = (name: string, durationSeconds: number, width = 1280, height = 720) => ({ name, mimeType: "video/mp4", buffer: Buffer.from(synthMp4({ durationSeconds, width, height })) });
const scene = (page: Page, title: string) => page.getByRole("region", { name: new RegExp(`^\\d+\\. ${title}`) });
const alert = (page: Page, text: string | RegExp) => page.getByRole("alert").filter({ hasText: text });

test("start a production from an approved journey; unconfigured providers say so", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Production Client");
  await page.getByLabel("Project name").fill("Production project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  const projectUrl = page.url().replace(/\/brief$/, "");

  await page.goto(`${projectUrl}/production`);
  await expect(page.getByText("Approve a journey first.")).toBeVisible();
  await expect(page.getByText("Not configured: RUNWAYML_API_SECRET")).toBeVisible();
  await expect(page.getByText("Not configured: GEMINI_API_KEY")).toBeVisible();

  await page.goto(`${projectUrl}/journeys`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/^Name/).fill("Site visit");
  await page.getByLabel("Start from").selectOption("sample");
  await page.getByRole("button", { name: "Create journey" }).click();
  await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("Version 1 is approved and frozen.")).toBeVisible();

  await page.goto(projectUrl);
  await page.getByRole("link", { name: /^Production \(0\)/ }).click();
  await page.getByRole("button", { name: "Start production: Site visit · v1" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]{36}$/);
  productionUrl = page.url();
  await expect(page.getByTestId("shot-status")).toHaveCount(6);
  await expect(page.getByTestId("shot-status").filter({ hasText: "Not started" })).toHaveCount(6);

  // Nothing can be sent without credentials, and the request a provider
  // cannot fulfil is refused with the reason before anything is sent.
  const opening = scene(page, "Arrival at dusk");
  await expect(opening.getByText("Not configured on this server: set RUNWAYML_API_SECRET")).toBeVisible();
  await expect(opening.getByRole("button", { name: "Generate with Runway" })).toBeDisabled();
  await opening.getByRole("button", { name: "Preview request" }).click();
  await expect(opening.getByText("Runway generates 2–10 seconds; this shot needs 12s.", { exact: false })).toBeVisible();
});

test("manual upload: the file is checked, and approval needs the reviewer's confirmations", async ({ page }) => {
  await page.goto(productionUrl);
  await page.waitForLoadState("networkidle");
  const choice = scene(page, "Choose a building");

  await choice.getByLabel(/^File/).setInputFiles(mp4("portrait.mp4", 6, 720, 1280));
  await choice.getByRole("button", { name: "Upload take" }).click();
  await expect(choice.getByText("Uploaded, but it fails its checks.")).toBeVisible();
  const bad = choice.getByRole("group", { name: "Take portrait.mp4" });
  await expect(bad.getByText("Fails its checks, so it cannot be approved.")).toBeVisible();
  await expect(bad.getByRole("button", { name: "Approve take" })).toHaveCount(0);
  await bad.getByRole("button", { name: "Reject take" }).click();
  await expect(alert(page, "Say why it was rejected")).toBeVisible();
  await bad.getByLabel("Review note").fill("Portrait; the journey is 16:9");
  await bad.getByRole("button", { name: "Reject take" }).click();
  await expect(choice.getByText("Rejected takes (1)")).toBeVisible();

  await choice.getByLabel(/^File/).setInputFiles(mp4("flow-loop.mp4", 6));
  await choice.getByLabel(/^Made with/).fill("Flow");
  await choice.getByRole("button", { name: "Upload take" }).click();
  await expect(choice.getByText("Uploaded. Checks passed; review it below.")).toBeVisible();
  const good = choice.getByRole("group", { name: "Take flow-loop.mp4" });
  await expect(good.getByText("Uploaded · Flow")).toBeVisible();
  await good.getByRole("button", { name: "Approve take" }).click();
  await expect(alert(page, "Confirm before approving")).toBeVisible();
  await good.getByLabel("I played the whole take and it plays correctly").check();
  await good.getByLabel("There is no text, caption, logo or interface element in the frame").check();
  await good.getByLabel("The loop is seamless").check();
  await good.getByRole("button", { name: "Approve take" }).click();
  await expect(choice.getByTestId("shot-status")).toHaveText("Approved");
  await expect(choice.getByRole("button", { name: "Upload take" })).toHaveCount(0);
});

test("every other shot is explicitly blocked; the manifest for WF-08 says exactly that", async ({ page, request }) => {
  await page.goto(productionUrl);
  await page.waitForLoadState("networkidle");
  for (const title of ["Arrival at dusk", "Homes", "Public buildings", "Start a conversation", "Closing"]) {
    const s = scene(page, title);
    await s.getByText("Can't be produced? Mark it blocked").click();
    await s.getByLabel(/^Why is this shot blocked\?/).fill("Client is supplying drone footage");
    await s.getByRole("button", { name: "Mark blocked" }).click();
    await expect(s.getByTestId("shot-status")).toHaveText("Blocked");
  }
  await expect(page.getByText("Every shot needs an approved take")).toHaveCount(0);

  const [, , projectId, , productionId] = new URL(productionUrl).pathname.split("/");
  const m = AssetManifest.parse(await (await request.get(`/api/projects/${projectId}/production/${productionId}/asset-manifest`)).json());
  expect(m).toMatchObject({ complete: false, counts: { slots: 6, approved: 1, blocked: 5, missing: 0 } });
  const approved = m.scenes.flatMap((s) => s.slots).find((s) => s.status === "approved")!;
  expect(approved.asset).toMatchObject({ source: "manual_upload", provider: "manual", mimeType: "video/mp4", durationSeconds: 6, width: 1280, height: 720 });

  // The approved original is served for playback, with ranges for seeking.
  const full = await request.get(approved.asset!.url);
  expect(full.headers()).toMatchObject({ "content-type": "video/mp4", "x-content-type-options": "nosniff", "accept-ranges": "bytes" });
  expect((await full.body()).byteLength).toBe(approved.asset!.sizeBytes);
  const part = await request.get(approved.asset!.url, { headers: { Range: "bytes=0-7" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBe(`bytes 0-7/${approved.asset!.sizeBytes}`);
  expect((await part.body()).subarray(4, 8).toString()).toBe("ftyp");
});

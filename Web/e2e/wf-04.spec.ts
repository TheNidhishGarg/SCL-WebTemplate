import { expect, test, type Page } from "@playwright/test";
import { BrandExport } from "../src/domain/brand-contract";

// WF-04 acceptance against a production build: token edits update the
// preview, invalid values produce actionable errors, exported CSS matches the
// saved configuration, and projects stay isolated.

test.describe.configure({ mode: "serial" });

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
let projectUrl = "";
let brandUrl = "";
const ids = () => {
  const [, , projectId, , brandId] = new URL(brandUrl).pathname.split("/");
  return { projectId, brandId };
};
const input = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

test("create a brand: it starts from defaults, marked undecided, with what blocks approval", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Brand Client");
  await page.getByLabel("Project name").fill("Brand project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  projectUrl = page.url().replace(/\/brief$/, "");

  await page.goto(`${projectUrl}/assets`);
  const upload = page.locator("form", { has: page.getByRole("heading", { name: "Upload a file" }) });
  await upload.getByLabel(/^File/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await upload.getByLabel("Label").fill("Primary logo");
  await upload.getByRole("button", { name: "Upload" }).click();
  await expect(upload.getByRole("status")).toBeVisible();

  await page.goto(projectUrl);
  await page.getByRole("link", { name: "Open brand configuration" }).click();
  await expect(page.getByLabel(/^Brand name/)).toHaveValue("Brand Client");
  await page.getByRole("button", { name: "Create brand" }).click();
  await expect(page).toHaveURL(/\/brands\/[0-9a-f-]{36}$/);
  brandUrl = page.url();

  await expect(page.getByText(/0 confirmed, 0 inferred, \d+ default, 3 missing/)).toBeVisible();
  const checks = page.locator("section", { has: page.getByRole("heading", { name: "Checks" }) });
  await expect(checks.getByText("Missing: typography.heading.family needs a value before approval.")).toBeVisible();
  await expect(checks.getByText("Add the primary logo before approval.")).toBeVisible();
});

test("changing a token updates the preview; invalid values say how to fix them", async ({ page }) => {
  await page.goto(brandUrl);
  const button = page.getByTestId("preview-button");
  await expect(button).toHaveCSS("background-color", rgb("#1d4ed8"));

  const primary = input(page, "Primary");
  await primary.fill("#7a1fa2");
  await expect(button).toHaveCSS("background-color", rgb("#7a1fa2"));
  await expect(page.getByLabel("Primary status", { exact: true })).toHaveValue("confirmed");

  await primary.fill("purple");
  await expect(page.getByText("Use a 6-digit hex colour, e.g. #1A2B3C").first()).toBeVisible();
  await expect(input(page, "Primary")).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Some values are not valid" })).toContainText("colors.primary.value");

  await primary.fill("#7a1fa2");
  await input(page, "Base size (px)").fill("30");
  await expect(page.getByText("Must be at most 24px")).toBeVisible();
  await input(page, "Base size (px)").fill("18");
  // 3xl = 18 × 1.25⁴ / 16 = 2.7466rem as exported (4 dp) = 43.9456px.
  await expect(page.getByTestId("preview-heading")).toHaveCSS("font-size", "43.9456px");
});

test("contrast failures block approval with a concrete fix", async ({ page }) => {
  await page.goto(brandUrl);
  await input(page, "Text").fill("#bbbbbb");
  const checks = page.locator("section", { has: page.getByRole("heading", { name: "Checks" }) });
  await expect(checks.getByText(/^Text on background is 1\.92:1; body text need 4\.5:1\. Darken text or lighten background\.$/)).toBeVisible();
  await input(page, "Text").fill("#1a1a1a");
  await expect(checks.getByText(/^Text on background is/)).toHaveCount(0);
});

test("complete, save and approve; exported CSS matches the saved configuration", async ({ page, request }) => {
  await page.goto(brandUrl);
  await input(page, "Primary").fill("#7a1fa2");
  await input(page, "Heading font family").fill("Playfair Display");
  await input(page, "Body font family").fill("Inter");
  await page.getByRole("button", { name: "Add logo" }).click();
  await expect(page.getByLabel("Logo 1: variant")).toHaveValue("primary");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("Version 1 is approved and frozen.")).toBeVisible();

  const { projectId, brandId } = ids();
  const json = BrandExport.parse(await (await request.get(`/api/projects/${projectId}/brands/${brandId}/config`)).json());
  expect(json.version).toMatchObject({ number: 1, status: "approved" });
  expect(json.cssVariables["--scl-color-primary"]).toBe("#7a1fa2");
  expect(json.provenance.confirmed).toEqual(expect.arrayContaining(["colors.primary", "typography.heading.family"]));
  expect(json.provenance.default).toContain("colors.secondary");
  expect(json.assets[0].location.kind).toBe("asset");

  const cssRes = await request.get(`/api/projects/${projectId}/brands/${brandId}/css`);
  expect(cssRes.headers()["content-type"]).toContain("text/css");
  const css = await cssRes.text();
  const main = css.slice(0, css.indexOf("@media"));
  const vars = Object.fromEntries([...main.matchAll(/(--scl-[a-z0-9-]+): ([^;]+);/g)].map((m) => [m[1], m[2]]));
  expect(vars).toEqual({ ...json.cssVariables, "--scl-motion-enabled": "1" });
  const scoped = await (await request.get(`/api/projects/${projectId}/brands/${brandId}/css?scope=brand`)).text();
  expect(scoped).toContain(`[data-scl-brand="${json.brand.key}"] {`);
});

test("history and revision: the approved version stays the handoff while v2 is edited", async ({ page, request }) => {
  await page.goto(brandUrl);
  await page.getByRole("button", { name: "Start revision (version 2)" }).click();
  await expect(page.getByRole("button", { name: "Approve version 2" })).toBeVisible();
  await input(page, "Primary").fill("#0b6e4f");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const history = page.locator("section", { has: page.getByRole("heading", { name: "Version history" }) });
  await expect(history.getByText("v2")).toBeVisible();
  await expect(history.getByText(/approved \d/)).toBeVisible();
  const { projectId, brandId } = ids();
  const approved = await (await request.get(`/api/projects/${projectId}/brands/${brandId}/config`)).json();
  expect(approved.cssVariables["--scl-color-primary"]).toBe("#7a1fa2");
  const latest = await (await request.get(`/api/projects/${projectId}/brands/${brandId}/config?version=latest`)).json();
  expect(latest.cssVariables["--scl-color-primary"]).toBe("#0b6e4f");
});

test("projects stay isolated: the brand styles only its preview, and other projects cannot reach it", async ({ page, request }) => {
  await page.goto(brandUrl);
  // The dashboard itself is untouched by the brand's variables.
  const bodyHasBrandVar = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--scl-color-primary"));
  expect(bodyHasBrandVar).toBe("");
  await expect(page.getByTestId("brand-preview")).toHaveAttribute("data-scl-brand", /.+/);

  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Other Client");
  await page.getByLabel("Project name").fill("Other project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  const otherId = page.url().split("/").at(-2);
  const { brandId } = ids();
  expect((await request.get(`/api/projects/${otherId}/brands/${brandId}/css`)).status()).toBe(404);
  expect((await request.get(`/api/projects/${otherId}/brands/${brandId}/config?version=latest`)).status()).toBe(404);
  const res = await page.goto(`/projects/${otherId}/brands/${brandId}`);
  expect(res?.status()).toBeLessThan(500);
  await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
});

test("the brand editor fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(brandUrl);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

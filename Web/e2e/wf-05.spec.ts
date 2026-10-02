import { expect, test, type Page } from "@playwright/test";
import { ContentManifest } from "../src/domain/content-manifest";

// WF-05 acceptance against a production build: drafts generated from the
// brief need review before publication; published pages render saved content
// with brand tokens, on mobile and desktop, with accessible structure and
// stable ids; edits never require touching shared components.

test.describe.configure({ mode: "serial" });

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const startsWith = (t: string) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const section = (page: Page, title: string) => page.locator("section", { has: page.getByRole("heading", { name: startsWith(title), level: 2 }) });
let projectUrl = "";
const projectId = () => projectUrl.split("/").pop()!;

async function approvedProjectWithBrand(page: Page) {
  await page.goto("/projects/new");
  await page.getByLabel("Client or business name").fill("Pages Client");
  await page.getByLabel("Project name").fill("Pages project");
  await page.getByRole("button", { name: "Create project and start brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  projectUrl = page.url().replace(/\/brief$/, "");

  await page.getByLabel(/Conventional website/).check();
  await page.getByLabel(startsWith("Industry")).fill("Architecture");
  await page.getByLabel(startsWith("Project summary")).fill("Portfolio site for an architecture practice.");
  const add = (t: string, b: string) => section(page, t).getByRole("button", { name: b }).click();
  await add("Target audiences", "Add audience");
  await page.getByRole("textbox", { name: "Audience 1", exact: true }).fill("Developers");
  await page.getByLabel("What they need").fill("Evidence of delivery");
  await add("Business objectives", "Add objective");
  await page.getByRole("textbox", { name: "Objective 1", exact: true }).fill("Win commissions");
  for (const [i, [title, slug, purpose]] of [["Home", "home", "Introduce the practice"], ["Contact", "contact", "Take enquiries"]].entries()) {
    await add("Required pages", "Add page");
    await page.getByRole("textbox", { name: `Page ${i + 1} title`, exact: true }).fill(title);
    await page.getByRole("textbox", { name: `Page ${i + 1} title`, exact: true }).blur();
    await expect(page.getByLabel("Slug").nth(i)).toHaveValue(slug);
    await page.getByLabel("Purpose").nth(i).fill(purpose);
  }
  await add("Desired actions", "Add action");
  await page.getByLabel("Details").fill("Enquiry form");
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("This version is approved and frozen")).toBeVisible();

  await page.goto(`${projectUrl}/assets`);
  const up = page.locator("form", { has: page.getByRole("heading", { name: "Upload a file" }) });
  await up.getByLabel(/^File/).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await up.getByLabel("Label").fill("Logo");
  await up.getByRole("button", { name: "Upload" }).click();
  await expect(up.getByRole("status")).toBeVisible();

  await page.goto(`${projectUrl}/brands`);
  await page.getByRole("button", { name: "Create brand" }).click();
  await expect(page).toHaveURL(/\/brands\/[0-9a-f-]{36}$/);
  await page.getByLabel("Primary", { exact: true }).fill("#7a1fa2");
  await page.getByLabel("Heading font family", { exact: true }).fill("Georgia");
  await page.getByLabel("Body font family", { exact: true }).fill("Arial");
  await page.getByRole("button", { name: "Add logo" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.getByRole("button", { name: "Approve version 1" }).click();
  await expect(page.getByText("Version 1 is approved and frozen.")).toBeVisible();
}

// Replaces every [Write: …] prompt on the editor page, as a writer would.
async function writeAll(page: Page, text: string) {
  // Typing before hydration is lost when React takes over the inputs.
  await page.waitForLoadState("networkidle");
  const fields = page.locator("input[type=text], textarea");
  const n = await fields.count();
  for (let i = 0; i < n; i++) {
    const f = fields.nth(i);
    if ((await f.inputValue()).includes("[Write:")) await f.fill(text);
  }
}

test("generate the sitemap and drafts from the brief; drafts cannot be submitted with placeholders", async ({ page }) => {
  await approvedProjectWithBrand(page);
  await page.goto(projectUrl);
  await page.getByRole("link", { name: /^Pages \(/ }).click();
  await expect(page.getByText("No pages yet.")).toBeVisible();
  await page.getByRole("button", { name: "Generate sitemap and drafts from the brief" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 page draft(s) created" })).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();

  const checks = page.locator("aside");
  await expect(checks.getByText(/Replace the placeholder \[Write: home page headline/)).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not submitted: fix these first." })).toBeVisible();
});

test("write the pages, review, approve and publish them", async ({ page }) => {
  await page.goto(`${projectUrl}/pages`);
  // Contact first: home links to it, and links to unpublished pages block publishing.
  await page.getByRole("link", { name: "Contact", exact: true }).click();
  await writeAll(page, "Write to us and we reply within two working days.");
  await page.getByLabel("Email", { exact: true }).fill("studio@example.com");
  await page.getByLabel("Meta description").fill("Contact the practice to discuss a new building or renovation.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Submitted for review." })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved." })).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();

  await page.goto(`${projectUrl}/pages`);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await writeAll(page, "Buildings that last, designed with people.");
  const hero = section(page, "1. Hero");
  await hero.getByRole("button", { name: "Add image" }).click();
  await hero.getByLabel(startsWith("Image description")).fill("A timber house on a hillside at dusk");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // Warnings (e.g. a short description) are allowed; nothing may block review.
  await expect(page.locator("aside").getByText(/item\(s\) block/)).toHaveCount(0);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved." })).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
});

test("published pages render saved content with the brand, accessibly, on desktop and mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto(`/site/${projectId()}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Buildings that last, designed with people.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Contact" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("img", { name: "A timber house on a hillside at dusk" })).toBeVisible();
  // Brand tokens applied: the primary button is the brand's primary colour.
  const cta = page.locator("a.scl-button--primary").first();
  await expect(cta).toHaveCSS("background-color", "rgb(122, 31, 162)");
  await expect(page.locator("[data-scl-page-id]")).toHaveAttribute("data-scl-brand", /.+/);
  await expect(page.locator("[data-scl-section-id]").first()).toHaveAttribute("id", /^s-/);
  // The CTA goes to the published contact page.
  await cta.click();
  await expect(page).toHaveURL(new RegExp(`/site/${projectId()}/contact$`));
  await expect(page.getByRole("link", { name: "studio@example.com" })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["", "/contact"]) {
    await page.goto(`/site/${projectId()}${path}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path || "/").toBeLessThanOrEqual(0);
  }
});

test("site settings drive canonical URLs; previews are never indexed", async ({ page }) => {
  await page.goto(`${projectUrl}/pages`);
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Site" }) });
  await form.getByLabel("Site address (for canonical URLs)").fill("https://pages.example");
  await form.getByRole("button", { name: "Save site settings" }).click();
  await expect(form.getByRole("status")).toHaveText("Site settings saved.");
  await page.goto(`/site/${projectId()}/contact`);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://pages.example/contact");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "Contact the practice to discuss a new building or renovation.");
  await page.goto(`/preview/${projectId()}/contact`);
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
  await expect(page.getByRole("note")).toContainText("Preview of revision");
});

test("editing content changes the preview, not the live page, until it is republished", async ({ page }) => {
  await page.goto(`${projectUrl}/pages`);
  await page.getByRole("link", { name: "Contact", exact: true }).click();
  const heading = section(page, "1. Hero").getByLabel(startsWith("Heading"));
  await heading.fill("Talk to the studio");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.goto(`/preview/${projectId()}/contact`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Talk to the studio");
  await page.goto(`/site/${projectId()}/contact`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Contact");
});

test("WF-08 receives a manifest of stable page, section, media and CTA ids", async ({ request }) => {
  const m = ContentManifest.parse(await (await request.get(`/api/projects/${projectId()}/content/manifest`)).json());
  expect(m.pages.map((p) => [p.path, p.status])).toEqual([
    ["/", "published"],
    ["/contact", "draft"],
  ]);
  const home = m.pages[0];
  expect(home.canonicalUrl).toBe("https://pages.example/");
  expect(home.media[0]).toMatchObject({ alt: "A timber house on a hillside at dusk", decorative: false });
  expect(home.ctas[0].actionKind).toBe("lead_form");
  expect(m.site.brand?.version).toBe(1);
  // The rendered page carries the same ids.
  const html = await (await request.get(`/site/${projectId()}`)).text();
  expect(html).toContain(`data-scl-page-id="${home.id}"`);
  for (const s of home.sections) expect(html).toContain(`data-scl-section-id="${s.id}"`);
  expect(html).toContain(`data-scl-media-id="${home.media[0].id}"`);
  expect(html).toContain(`data-scl-cta-id="${home.ctas[0].id}"`);
});

test("paths without a published page return 404", async ({ request }) => {
  expect((await request.get(`/site/${projectId()}/nope`)).status()).toBe(404);
  expect((await request.get(`/preview/${projectId()}/nope`)).status()).toBe(404);
});

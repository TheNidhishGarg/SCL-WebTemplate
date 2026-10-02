import { expect, test, type Page } from "@playwright/test";
import { approveTake, blockShot, publishedSite, publishJourney } from "./fixtures/site";
import { makeFixtureVideo } from "./fixtures/video";

// WF-08 acceptance against a production build. Footage is a labelled TEST
// FIXTURE (real, playable H.264 stamped "TEST FIXTURE"), uploaded and
// approved through WF-07 like any take. Covers: the conventional site and the
// journey in one shell, a full branch on desktop and keyboard, CTAs,
// playback failure, reduced motion, mobile, a second project on the same
// engine, and the fallbacks when a journey is unavailable.

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let a = { projectId: "", projectUrl: "", productionUrl: "" };
let b = { projectId: "", projectUrl: "", productionUrl: "" };
let journeyUrl = "";
let homeUrl = "";

const player = (page: Page) => page.locator("section.scl-journey");
const heading = (page: Page) => player(page).locator("#scl-journey-heading");
// Jumps playback to just before the end, so 'ended' fires naturally.
const nearEnd = (page: Page) =>
  player(page)
    .locator("video")
    .evaluate(
      (v: HTMLVideoElement) =>
        new Promise<void>((resolve) => {
          const go = () => {
            v.currentTime = Math.max(0, v.duration - 0.3);
            resolve();
          };
          if (v.readyState >= 1) go();
          else v.addEventListener("loadedmetadata", go, { once: true });
        }),
    );
const seek = (page: Page, t: number) => player(page).locator("video").evaluate((v: HTMLVideoElement, t) => void (v.currentTime = t), t);

test("assemble: approved pages, journey and media are published as one release", async ({ page, browser }) => {
  const footage = await makeFixtureVideo(browser, { seconds: 15, label: "WF-08" });
  a = await publishedSite(page, "Timber Studio", "#7a1fa2");
  for (const title of ["Arrival at dusk", "Choose a building", "Homes", "Start a conversation", "Closing"]) await approveTake(page, title, footage);
  // Nothing planned or produced is lost silently: a blocked shot is a title card.
  await blockShot(page, "Public buildings");
  await expect(page.getByText('"Public buildings" has no footage (Blocked in production: Client is supplying this footage). It plays as a title card.')).toBeVisible();
  await publishJourney(page);
  journeyUrl = `/site/${a.projectId}/journeys/site-visit`;
  homeUrl = `/site/${a.projectId}`;
});

test("desktop: from the home page through a full branch to the website, with keyboard and real HTML controls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(homeUrl);
  // Same shell: the site's header and navigation are on the page and the journey.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Contact" })).toBeVisible();
  await page.getByRole("link", { name: "Start the journey" }).click();
  await expect(page).toHaveURL(new RegExp(`${journeyUrl}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Site visit" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Contact" })).toBeVisible();
  await expect(player(page).getByRole("link", { name: "Skip the film: Continue to Home" })).toHaveAttribute("href", homeUrl);

  await page.getByRole("button", { name: "Start the journey" }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  await expect(heading(page)).toContainText("Arrival at dusk");
  await expect(heading(page)).toBeFocused();
  await expect(player(page).locator("video")).toHaveAttribute("aria-hidden", "true");

  // Pause and resume.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "paused");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "playing");

  // The opening ends by itself and the decision appears: choices are buttons.
  await nearEnd(page);
  await expect(heading(page)).toContainText("Choose a building");
  const choices = player(page).getByRole("group", { name: "Choose a building" });
  await expect(choices.getByRole("button")).toHaveText(["Homes", "Public buildings"]);
  await expect(player(page).getByText(/Continuing with “Homes” in \d+ s\./)).toBeVisible();
  await expect(page.getByRole("button", { name: "Next scene" })).toHaveCount(0); // a decision must be made

  // Keyboard: choose with Enter; focus moves to the new scene's heading.
  await choices.getByRole("button", { name: "Public buildings" }).focus();
  await page.keyboard.press("Enter");
  await expect(heading(page)).toContainText("Public buildings");
  await expect(heading(page)).toBeFocused();
  await expect(player(page)).toHaveAttribute("data-phase", "still"); // blocked shot: title card
  await page.getByRole("button", { name: "Next scene" }).click();

  // The conversion scene: the CTA is a real link, shown at its time.
  await expect(heading(page)).toContainText("Start a conversation");
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  const cta = player(page).getByRole("link", { name: "Talk to the studio" });
  await expect(cta).toHaveCount(0);
  await seek(page, 4.5);
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "mailto:studio@example.com");
  await expect(cta).toHaveAttribute("data-scl-action", /.+/);

  await nearEnd(page);
  await expect(heading(page)).toContainText("Closing");
  await expect(page.getByRole("list", { name: "Your path so far" }).getByRole("listitem")).toHaveText(["Arrival at dusk", "Choose a building", "Public buildings", "Start a conversation", "Closing"]);
  await page.getByRole("button", { name: "Previous scene" }).click();
  await expect(heading(page)).toContainText("Start a conversation");
  await page.getByRole("button", { name: "Next scene" }).click();
  await expect(heading(page)).toContainText("Closing");
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  await nearEnd(page);
  await expect(player(page)).toHaveAttribute("data-status", "finished");
  await expect(page.getByRole("button", { name: "Watch again" }).first()).toBeVisible();
  await player(page).getByRole("link", { name: "Continue to Home" }).click();
  await expect(page).toHaveURL(new RegExp(`${homeUrl}$`));
});

test("playback failure: the scene falls back to a title card and every control keeps working", async ({ page }) => {
  // The media server is unreachable for this visit.
  await page.route("**/takes/*/file", (route) => route.abort("failed"));
  await page.goto(journeyUrl);
  await page.getByRole("button", { name: "Start the journey" }).click();
  const alert = player(page).getByRole("alert");
  await expect(alert).toContainText("This scene couldn't play.");
  await expect(player(page)).toHaveAttribute("data-phase", "failed");
  // Try again (still failing), then carry on.
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(player(page).getByRole("alert")).toContainText("This scene couldn't play.");
  await page.getByRole("button", { name: "Next scene" }).click();
  // The decision is still offered even though its loop cannot play.
  await expect(heading(page)).toContainText("Choose a building");
  await player(page).getByRole("button", { name: "Homes" }).click();
  await expect(heading(page)).toContainText("Homes");
  await expect(player(page).getByRole("alert")).toBeVisible();
  // Media back: "Try again" recovers the scene.
  await page.unroute("**/takes/*/file");
  await player(page).getByRole("button", { name: "Try again" }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  // The way out to the conventional site is always there.
  await expect(page.getByRole("link", { name: "Leave the journey" })).toHaveAttribute("href", homeUrl);
});

test("progress is kept for the tab: resume where you left off", async ({ page }) => {
  await page.goto(journeyUrl);
  await page.getByRole("button", { name: "Start the journey" }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  await page.getByRole("button", { name: "Next scene" }).click();
  await expect(heading(page)).toContainText("Choose a building");
  await page.reload();
  await page.getByRole("button", { name: "Resume where you left off" }).click();
  await expect(heading(page)).toContainText("Choose a building");
  await expect(page.getByRole("button", { name: "Previous scene" })).toBeEnabled();
});

test("reduced motion: no animated transitions, loops wait for Play, choices still work", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(journeyUrl);
  await expect(player(page)).toHaveAttribute("data-motion", "reduced");
  await expect(player(page).getByText(/Reduced motion is on/)).toBeVisible();
  await page.getByRole("button", { name: "Start the journey" }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  // GSAP never touched the stage: no inline animation styles.
  await expect(player(page).locator(".scl-journey-media")).not.toHaveAttribute("style", /.+/);
  await page.getByRole("button", { name: "Next scene" }).click();
  await expect(heading(page)).toContainText("Choose a building");
  await expect(player(page)).toHaveAttribute("data-phase", "paused");
  await expect(player(page).locator("video")).not.toHaveAttribute("loop");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await player(page).getByRole("button", { name: "Homes" }).click();
  await expect(heading(page)).toContainText("Homes");
  await expect(player(page).locator(".scl-journey-media")).not.toHaveAttribute("style", /.+/);
});

test("mobile: controls sit below the footage, nothing overflows, the branch completes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(homeUrl);
  await page.getByRole("link", { name: "Start the journey" }).click();
  await page.getByRole("button", { name: "Start the journey" }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "playing");
  const [stage, ui] = await Promise.all([player(page).locator(".scl-journey-stage").boundingBox(), player(page).locator(".scl-journey-ui").boundingBox()]);
  expect(ui!.y).toBeGreaterThanOrEqual(stage!.y + stage!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await nearEnd(page);
  const homes = player(page).getByRole("button", { name: "Homes" });
  const box = await homes.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await homes.click();
  await expect(heading(page)).toContainText("Homes");
});

test("a second project runs on the same engine through its own data; unavailable journeys fall back to the site", async ({ page }) => {
  b = await publishedSite(page, "Stone Works", "#0f766e");
  // No footage at all: every shot blocked. The same engine plays it as title cards.
  for (const title of ["Arrival at dusk", "Choose a building", "Homes", "Public buildings", "Start a conversation", "Closing"]) await blockShot(page, title);
  await publishJourney(page);

  const url = `/site/${b.projectId}/journeys/site-visit`;
  await page.goto(url);
  await expect(page.locator(".scl-site")).toHaveAttribute("style", /--scl-color-primary:\s*#0f766e/i);
  await page.getByRole("button", { name: "Start the journey" }).click();
  await expect(player(page)).toHaveAttribute("data-phase", "still");
  await expect(player(page).locator("video")).toHaveCount(0);
  await page.getByRole("button", { name: "Next scene" }).click();
  await player(page).getByRole("button", { name: "Homes" }).click();
  await expect(heading(page)).toContainText("Homes");
  // Project A is untouched by project B.
  const resA = await page.request.get(journeyUrl);
  expect(await resA.text()).toContain(a.projectId);

  // Withdraw: the journey URL still renders the site and points to the pages.
  await page.goto(b.productionUrl);
  await page.getByRole("button", { name: "Withdraw from the website" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Withdrawn." })).toBeVisible();
  await page.goto(url);
  await expect(page.getByText("This journey isn't available right now.")).toBeVisible();
  await page.getByRole("link", { name: "Continue to the website" }).click();
  await expect(page).toHaveURL(new RegExp(`/site/${b.projectId}$`));
  await expect(page.getByRole("link", { name: "Start the journey" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");

  // Preview of the approved journey is always available to editors, never indexed.
  await page.goto(`/preview/${b.projectId}/journeys/site-visit`);
  await expect(page.getByRole("note")).toContainText("Preview of the approved journey");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

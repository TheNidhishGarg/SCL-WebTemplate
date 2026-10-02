import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLACEHOLDER, type PageContent } from "@/domain/content";
import { ContentManifest } from "@/domain/content-manifest";
import { completeConventionalDraft } from "@/domain/test-fixtures";
import { SitePage } from "@/site/render";
import { openDatabase } from "./db";
import { createStore, StoreError, type Store } from "./store";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-content-"));
  store = createStore(openDatabase(join(dir, "scl.sqlite")), join(dir, "uploads"), { checkUrl: async () => { throw new Error("offline"); } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const err = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe(code);
    return e as StoreError;
  }
  throw new Error("expected StoreError");
};

// A project with an approved brief (home + contact pages) and an approved brand.
function setup() {
  const p = store.createProject({ name: "Anaïs", clientName: "Anaïs Events" });
  const v1 = store.getProject(p.id)!.latest;
  store.saveDraft(p.id, v1.id, completeConventionalDraft());
  store.approveBrief(p.id, v1.id);
  const logo = store.addAssetUpload(p.id, { kind: "logo", label: "Logo", notes: "" }, { filename: "logo.png", mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50]) });
  const brand = store.brands.create(p.id, { name: "Anaïs" });
  const b = store.brands.get(p.id, brand.id).latest;
  const c = structuredClone(b.content);
  c.typography.heading.family = { value: "Inter", status: "confirmed", note: "" };
  c.typography.body.family = { value: "Inter", status: "confirmed", note: "" };
  c.colors.primary = { value: "#7a1fa2", status: "confirmed", note: "" };
  c.assets.logos = [{ variant: "primary", ref: { kind: "asset", assetId: logo.id }, background: "any", minWidthPx: null, status: "confirmed", note: "" }];
  store.brands.saveDraft(p.id, brand.id, b.id, c);
  store.brands.approve(p.id, brand.id, b.id);
  return { p, logo, brand };
}

// Replaces every placeholder with real copy, as a writer would.
function write(c: PageContent): PageContent {
  return JSON.parse(JSON.stringify(c, (_, v) => (typeof v === "string" && PLACEHOLDER.test(v) ? "Written copy for this field." : v)));
}

describe("generation from the brief", () => {
  it("drafts one page per required page, with placeholders that block review", () => {
    const { p } = setup();
    expect(store.content.generateFromBrief(p.id)).toEqual({ created: 2, skipped: 0 });
    expect(store.content.generateFromBrief(p.id)).toEqual({ created: 0, skipped: 2 });
    const [home, contact] = store.content.pages(p.id);
    expect(home.content.slug).toBe("");
    expect(home.origin).toBe("generated");
    expect(contact.content.sections.map((s) => s.type)).toEqual(["hero", "contact"]);
    // The home page CTA points at the contact page and carries the brief's desired action.
    const hero = home.content.sections[0];
    expect(hero.type === "hero" && hero.ctas[0]).toMatchObject({ target: { kind: "page", pageId: contact.id }, actionKind: "lead_form" });
    const e = err(() => store.content.transition(p.id, home.id, "submit"), "invalid");
    expect(e.issues.some((i) => /Replace the placeholder \[Write:/.test(i.message))).toBe(true);
  });

  it("refuses to generate without an approved brief", () => {
    const p = store.createProject({ name: "X", clientName: "X" });
    err(() => store.content.generateFromBrief(p.id), "conflict");
  });
});

describe("workflow", () => {
  it("goes draft → review → approved → published, and keeps the published snapshot live while editing", () => {
    const { p } = setup();
    store.content.generateFromBrief(p.id);
    const [home, contact] = store.content.pages(p.id);
    // Publishing a page that links to an unpublished page is refused.
    const page = store.content.getPage(p.id, home.id);
    store.content.savePage(p.id, home.id, page.revision, write(page.content));
    store.content.transition(p.id, home.id, "submit");
    store.content.transition(p.id, home.id, "approve");
    const e = err(() => store.content.transition(p.id, home.id, "publish"), "invalid");
    expect(e.issues.map((i) => i.message)).toContain('Links to "Contact", which is not published');

    // The contact section needs a way to get in touch; write() filled text only.
    const cp = store.content.getPage(p.id, contact.id);
    const cc = write(cp.content);
    const cs = cc.sections[1];
    if (cs.type === "contact") cs.email = "hello@anais.example";
    store.content.savePage(p.id, contact.id, cp.revision, cc);
    store.content.transition(p.id, contact.id, "submit");
    store.content.transition(p.id, contact.id, "approve");
    expect(store.content.transition(p.id, contact.id, "publish").status).toBe("published");
    expect(store.content.transition(p.id, home.id, "publish").status).toBe("published");

    // Editing a published page sends it back to draft; the live snapshot is unchanged.
    const live = store.content.getPage(p.id, home.id);
    const edited = structuredClone(live.content);
    edited.title = "Home (new)";
    const saved = store.content.savePage(p.id, home.id, live.revision, edited);
    expect(saved.status).toBe("draft");
    expect(saved.published?.content.title).toBe("Home");
    expect(store.content.resolve(p.id, "/", "published")?.page.content.title).toBe("Home");
    expect(store.content.resolve(p.id, "/", "preview")?.page.content.title).toBe("Home (new)");
    err(() => store.content.savePage(p.id, home.id, live.revision, edited), "conflict"); // stale revision
  });

  it("only publishes with an approved brand applied", () => {
    const p = store.createProject({ name: "P", clientName: "P" });
    const pg = store.content.createPage(p.id, { title: "Home", slug: "" });
    const c = structuredClone(pg.content);
    c.seo.description = "A description long enough to be useful in search results here.";
    store.content.savePage(p.id, pg.id, pg.revision, c);
    store.content.transition(p.id, pg.id, "submit");
    store.content.transition(p.id, pg.id, "approve");
    const e = err(() => store.content.transition(p.id, pg.id, "publish"), "invalid");
    expect(e.issues.map((i) => i.message)).toContain("Choose the site's brand (WF-04) before publishing");
  });
});

describe("validation", () => {
  it("reports broken links, missing assets, missing alt text and duplicate paths", () => {
    const { p, logo } = setup();
    const other = store.createProject({ name: "Other", clientName: "Other" });
    const foreign = store.addAssetUpload(other.id, { kind: "logo", label: "X", notes: "" }, { filename: "x.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    const a = store.content.createPage(p.id, { title: "About", slug: "about" });
    const c = structuredClone(a.content);
    c.sections.push(
      { id: crypto.randomUUID(), type: "gallery", heading: "", images: [{ id: crypto.randomUUID(), source: { kind: "asset", assetId: foreign.id }, alt: "x", decorative: false }, { id: crypto.randomUUID(), source: { kind: "asset", assetId: logo.id }, alt: "", decorative: false }] },
      { id: crypto.randomUUID(), type: "cta", heading: "Go", body: "", ctas: [{ id: crypto.randomUUID(), label: "Go", style: "primary", target: { kind: "page", pageId: crypto.randomUUID() }, actionKind: null }] },
    );
    store.content.savePage(p.id, a.id, a.revision, c);
    const msgs = store.content.issues(p.id, a.id).map((i) => i.message);
    expect(msgs).toEqual(expect.arrayContaining(["Missing asset: the image is not in this project's asset register", "Describe the image (alt text), or mark it decorative", "Broken link: the target page no longer exists", "Add a meta description"]));
    err(() => store.content.createPage(p.id, { title: "Again", slug: "about" }), "conflict");
  });
});

describe("reusable blocks", () => {
  it("renders the block wherever it is placed, and refuses to delete one in use", () => {
    const { p } = setup();
    const pg = store.content.createPage(p.id, { title: "About", slug: "about" });
    const blockId = store.content.saveBlock(p.id, null, { name: "Newsletter", section: { id: crypto.randomUUID(), type: "text", heading: "Stay in touch", body: "Monthly notes." } });
    const c = structuredClone(pg.content);
    const placed = crypto.randomUUID();
    c.sections.push({ id: placed, type: "block", blockId });
    store.content.savePage(p.id, pg.id, pg.revision, c);
    store.content.saveBlock(p.id, blockId, { name: "Newsletter", section: { id: crypto.randomUUID(), type: "text", heading: "Stay in touch", body: "Fortnightly notes." } });
    const r = store.content.resolve(p.id, "/about", "preview")!;
    const html = renderToStaticMarkup(SitePage({ r: { ...r, projectId: p.id, root: `/preview/${p.id}`, preview: true } }));
    expect(html).toContain("Fortnightly notes.");
    expect(html).toContain(`data-scl-section-id="${placed}"`);
    expect(html).toContain(`data-scl-block-id="${blockId}"`);
    err(() => store.content.deleteBlock(p.id, blockId), "conflict");
  });
});

describe("rendering and manifest", () => {
  it("renders saved content with brand variables, one h1, landmarks and stable ids", () => {
    const { p, logo } = setup();
    store.content.generateFromBrief(p.id);
    const home = store.content.pages(p.id)[0];
    const c = write(home.content);
    const hero = c.sections[0];
    if (hero.type === "hero") hero.media = { id: crypto.randomUUID(), source: { kind: "asset", assetId: logo.id }, alt: "The studio at dusk", decorative: false };
    store.content.savePage(p.id, home.id, home.revision, c);
    const r = store.content.resolve(p.id, "/", "preview")!;
    const html = renderToStaticMarkup(SitePage({ r: { ...r, projectId: p.id, root: `/preview/${p.id}`, preview: true } }));
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("--scl-color-primary:#7a1fa2");
    expect(html).toContain(`data-scl-page-id="${home.id}"`);
    expect(html).toContain(`id="s-${c.sections[0].id}"`);
    expect(html).toContain('alt="The studio at dusk"');
    expect(html).toContain(`src="/api/projects/${p.id}/media/${logo.id}"`);
    expect(html).toMatch(/<nav aria-label="Main">/);
    expect(html).toContain("<main");
    expect(html).toContain("Preview of revision");
    // Content is text, never markup.
    const x = structuredClone(c);
    if (x.sections[0].type === "hero") x.sections[0].heading = "<script>alert(1)</script>";
    store.content.savePage(p.id, home.id, store.content.getPage(p.id, home.id).revision, x);
    const html2 = renderToStaticMarkup(SitePage({ r: { ...store.content.resolve(p.id, "/", "preview")!, projectId: p.id, root: "/preview/x", preview: true } }));
    expect(html2).not.toContain("<script>alert(1)</script>");
  });

  it("exposes page, section, media and CTA ids in a manifest that validates", () => {
    const { p, brand } = setup();
    store.content.generateFromBrief(p.id);
    store.content.updateSite(p.id, { siteName: "Anaïs", baseUrl: "https://anais.example", brandId: brand.id, locale: "en-IN" });
    const m = ContentManifest.parse(store.content.manifest(p.id));
    expect(m.site.brand).toMatchObject({ id: brand.id, version: 1 });
    expect(m.navigation.primary.map((n) => n.path)).toEqual(["/", "/contact"]);
    const home = m.pages[0];
    expect(home.canonicalUrl).toBe("https://anais.example/");
    expect(home.sections.every((s) => s.anchor === `s-${s.id}`)).toBe(true);
    expect(home.ctas[0]).toMatchObject({ actionKind: "lead_form" });
    expect(home.issues.length).toBeGreaterThan(0);
    // Another project's brand cannot be applied.
    const other = store.createProject({ name: "O", clientName: "O" });
    err(() => store.content.updateSite(other.id, { siteName: "O", baseUrl: "", brandId: brand.id, locale: "en" }), "invalid");
  });
});

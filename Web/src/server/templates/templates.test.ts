import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reprocessWorkspace, savePageContent, saveBrand, createWorkspace, workspacePaths, readEditable } from "@/server/preview/workspace";
import { applyOperation, buildExport, opContext, processTemplate, structureView, verifyTemplate } from ".";
import { compose, compositionFromLayout } from "./composition";
import { idsIn, parseMarkup, parseSelector, select, suffixIds, tokenKeys } from "./markup";
import { readComposition, readContent, readPage, renderOrder } from "./model";
import { readOverrides } from "./operations";
import { coverage, sourceEdits } from "./reports";
import { readTokenMap } from "./tokens";

// Web's deterministic template processing, on a template in the generator's
// format (a TEST FIXTURE written here, modelled on real generated output).
// Building uses the real template runtime of the SaveAllResources
// installation (copied at test time, never stored in Web); those tests are
// skipped when it is not installed.

const SAR_HOME = process.env.SAR_HOME ?? resolve(process.cwd(), "../SaveAllResources");
const RUNTIME = join(SAR_HOME, "app", "processing", "template-runtime");
const hasRuntime = existsSync(join(RUNTIME, "build.mjs"));

const layout = (page: string, body: string) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
{{@head-start}}
<title>{{@ page.title}}</title><link rel="stylesheet" href="{{@root}}assets/site/css/site.css">{{@head-end}}
</head>
<body>{{@section ${page}/s01-navigation}}
${body}{{@section ${page}/s09-footer}}</body></html>`;

const PROCESSED_CSS = `:root { --brand: #b45309; }
body { font-family: var(--sar-font-body); color: #1f2937; }
h1 { color: var(--sar-color-primary); }
.button { background: var(--sar-color-primary); color: #ffffff; }
.card { border: 1px solid var(--sar-color-primary); }
`;
const RAW_CSS = `:root { --brand: #b45309; }
body { font-family: Georgia, serif; color: #1f2937; }
h1 { color: #B45309; }
.button { background: rgb(180, 83, 9); color: #ffffff; }
.card { border: 1px solid #b45309; }
`;
const CONFIG = { brand: { name: "Test Bakery" }, colors: { primary: { value: "#b45309", uses: 4 } }, fonts: { body: { family: "Georgia, serif", uses: 1 } }, typography: {}, images: {}, integrations: { allowedOrigins: [], blockedEndpoints: [], analytics: { enabled: false, headHtml: "" }, forms: { "home-form-1": { action: "", method: "post", page: "home" } } } };

const section = (page: string, local: string, type: string, component: string, content = "page") => ({ id: `${page}/${local}`, localId: local, type, component, content });
const FILES: Record<string, string> = {
  "manifest.json": JSON.stringify({ resources: [{ url: "https://bakery.test/css/site.css", localPath: "raw-capture/resources/bakery.test/css/site.css", templatePath: "assets/site/css/site.css" }] }),
  "raw-capture/resources/bakery.test/css/site.css": RAW_CSS,
  "page-inventory.json": JSON.stringify({
    pages: [
      { id: "home", finalUrl: "https://bakery.test/", route: "index.html", captureStatus: "captured", templateStatus: "templatised", warnings: [] },
      { id: "about", finalUrl: "https://bakery.test/about/", route: "about/index.html", captureStatus: "captured", templateStatus: "templatised", warnings: [] },
      { id: "blog", finalUrl: "https://bakery.test/blog/", captureStatus: "failed", httpStatus: 500, reason: "server error" },
    ],
    skippedUrls: [{ url: "https://bakery.test/admin/", reason: "disallowed by robots.txt" }],
    limits: { reached: ["maxPages"], remainingUrls: ["https://bakery.test/shop/"] },
    discovery: { complete: false, notes: [] },
  }),
  "section-inventory.json": JSON.stringify({
    sections: [
      { sectionId: "home/s01-navigation", page: "home", type: "navigation", sourceSelector: "header.site-header", processingStatus: "templatised", verificationStatus: "rendered", interactionDependencies: [], unsupported: [] },
      { sectionId: "home/s02-hero", page: "home", type: "hero", sourceSelector: "section.hero", processingStatus: "templatised", verificationStatus: "rendered", interactionDependencies: [], unsupported: [] },
      { sectionId: "home/s03-cards", page: "home", type: "cards", sourceSelector: "section.features", processingStatus: "templatised", verificationStatus: "rendered", interactionDependencies: [], unsupported: [] },
      { sectionId: "home/s04-contact", page: "home", type: "form", sourceSelector: "section.contact", processingStatus: "templatised", verificationStatus: "rendered", interactionDependencies: ["form (submission disabled until configured)"], unsupported: [] },
      { sectionId: "home/s09-footer", page: "home", type: "footer", processingStatus: "templatised", verificationStatus: "rendered", interactionDependencies: [], unsupported: [] },
      { sectionId: "about/s01-navigation", page: "about", type: "navigation", processingStatus: "templatised", verificationStatus: "rendered" },
      { sectionId: "about/s02-list", page: "about", type: "content", processingStatus: "templatised", verificationStatus: "rendered" },
      { sectionId: "about/s03-video", page: "about", type: "content", processingStatus: "needs_manual_review", verificationStatus: "missing_in_output", unsupported: ["canvas"] },
      { sectionId: "about/s09-footer", page: "about", type: "footer", processingStatus: "templatised", verificationStatus: "rendered" },
    ],
  }),
  "verification-report.json": JSON.stringify({ checks: { pages: [{ page: "home", checks: { load: { passed: true }, resources: { passed: false, localFailures: [{ url: "/favicon.ico", status: 404 }] } } }] } }),
  "template/site.config.json": JSON.stringify(CONFIG),
  "template/site.config.reference.json": JSON.stringify(CONFIG),
  "template/assets/site/css/site.css": PROCESSED_CSS,
  "template/assets/site/js/app.js": `document.getElementById("features").classList.add("ready");\n`,
  "template/pages/home.json": JSON.stringify({ id: "home", route: "index.html", layout: "layouts/home.html", sections: [section("home", "s01-navigation", "navigation", "shared/navigation", "shared:navigation"), section("home", "s02-hero", "hero", "pages/home/s02-hero"), section("home", "s03-cards", "cards", "pages/home/s03-cards"), section("home", "s04-contact", "form", "pages/home/s04-contact"), section("home", "s09-footer", "footer", "shared/footer", "shared:footer")] }),
  "template/pages/about.json": JSON.stringify({ id: "about", route: "about/index.html", layout: "layouts/about.html", sections: [section("about", "s01-navigation", "navigation", "shared/navigation", "shared:navigation"), section("about", "s02-list", "content", "pages/about/s02-list"), section("about", "s09-footer", "footer", "shared/footer", "shared:footer")] }),
  "template/layouts/home.html": layout("home", "<main>{{@section home/s02-hero}}{{@section home/s03-cards}}{{@section home/s04-contact}}</main>"),
  "template/layouts/about.html": layout("about", '<main class="content">\n  {{@section about/s02-list}}\n</main>'),
  "template/components/shared/navigation.html": `<header class="site-header" data-sar-section="{{@sectionid}}" data-sar-type="navigation"><nav>{{@html text}}</nav></header>`,
  "template/components/shared/footer.html": `<footer class="site-footer" data-sar-section="{{@sectionid}}" data-sar-type="footer"><p>{{@ text}}</p><div class="cookie-banner">We use cookies</div></footer>`,
  "template/components/pages/home/s02-hero.html": `<section class="hero" id="top" data-sar-section="{{@sectionid}}" data-sar-type="hero"><h1>{{@ heading}}</h1><p>{{@ text}}</p><a class="button" href="{{@url cta.href}}">{{@ cta.label}}</a><div class="promo">Limited offer</div></section>`,
  "template/components/pages/home/s03-cards.html": `<section class="features" id="features" data-sar-section="{{@sectionid}}" data-sar-type="cards"><h2 id="features-title">{{@ heading}}</h2><div class="grid" aria-labelledby="features-title"><article class="card"><h3>{{@ card1}}</h3></article><article class="card"><h3>{{@ card2}}</h3></article><article class="card"><h3>{{@ card3}}</h3></article></div></section>`,
  "template/components/pages/home/s04-contact.html": `<section class="contact" data-sar-section="{{@sectionid}}" data-sar-type="form"><h2>{{@ heading}}</h2><form data-sar-form="home-form-1"><label for="email">Email</label><input id="email" name="email"><button>{{@ button}}</button></form></section>`,
  "template/components/pages/about/s02-list.html": `<section class="menu" data-sar-section="{{@sectionid}}" data-sar-type="content"><h1>{{@ heading}}</h1><ul>{{@each items}}<li class="item">{{@ name}}</li>{{@end}}</ul></section>`,
  "template/content/shared.json": JSON.stringify({ navigation: { text: '<a href="/index.html">Home</a> <a href="/about/index.html">About</a>' }, footer: { text: "© {{brand.name}}" } }),
  "template/content/pages/home.json": JSON.stringify({ page: { title: "Home · {{brand.name}}", description: "" }, sections: { "s02-hero": { heading: "Fresh bread daily", text: "Baked every morning.", cta: { href: "/about/index.html", label: "About us" } }, "s03-cards": { heading: "Why us", card1: "Sourdough", card2: "Rye", card3: "Pastries" }, "s04-contact": { heading: "Order ahead", button: "Send" } } }),
  "template/content/pages/about.json": JSON.stringify({ page: { title: "About · {{brand.name}}", description: "" }, sections: { "s02-list": { heading: "Our menu", items: [{ name: "Sourdough" }, { name: "Rye" }] } } }),
};

function writeFixture(dir: string, withRuntime: boolean) {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (withRuntime) for (const f of ["build.mjs", "serve.mjs", "package.json", "lib", "runtime"]) cpSync(join(RUNTIME, f), join(dir, "template", f), { recursive: true });
}
function fixtureZip(withRuntime: boolean) {
  const files: Record<string, Uint8Array> = {};
  for (const [rel, text] of Object.entries(FILES)) files[`website-template/${rel}`] = strToU8(text);
  if (withRuntime) for (const f of ["build.mjs", "serve.mjs", "package.json", "lib/engine.mjs", "runtime/sar-runtime.js"]) files[`website-template/template/${f}`] = readFileSync(join(RUNTIME, f));
  return zipSync(files);
}

let dir: string;
let t: string;
let capture: string;
const ctx = () => opContext(t, capture);
const apply = (op: Record<string, unknown>) => applyOperation(t, op, ctx());
const order = (page: string) => renderOrder(readComposition(t, page)!, readFileSync(join(t, "composition", "skeletons", `${page}.html`), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scl-tpl-"));
  writeFixture(dir, hasRuntime);
  t = join(dir, "template");
  capture = dir; // the fixture's root has the manifests and raw capture
  processTemplate(t, capture);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("markup helpers", () => {
  it("parses the supported selector subset and refuses the rest", () => {
    const frag = parseMarkup(`<section class="a b"><div class="grid"><article class="card x" data-k="v1"></article><p class="card"></p></div></section>`);
    expect(select(frag, parseSelector(".grid > article.card")).map((e) => e.tagName)).toEqual(["article"]);
    expect(select(frag, parseSelector("section .card")).length).toBe(2);
    expect(select(frag, parseSelector('[data-k^="v"], p')).map((e) => e.tagName)).toEqual(["article", "p"]);
    expect(select(frag, parseSelector("section")).length).toBe(1);
    expect(() => parseSelector("a:hover")).toThrow(/Supported selectors/);
    expect(() => parseSelector("a + b")).toThrow(/Supported selectors/);
  });
  it("gives a copy's ids a suffix and updates references inside it", () => {
    const { text } = suffixIds(`<h2 id="t">x</h2><div aria-labelledby="t other"><a href="#t">x</a><label for="t">l</label><svg><rect fill="url(#t)"/></svg></div><a href="#elsewhere">y</a>`, "-copy1");
    expect(text).toContain('id="t-copy1"');
    expect(text).toContain('aria-labelledby="t-copy1 other"');
    expect(text).toContain('href="#t-copy1"');
    expect(text).toContain('for="t-copy1"');
    expect(text).toContain('fill="url(#t-copy1)"');
    expect(text).toContain('href="#elsewhere"');
    expect(idsIn(`<p id="{{@ id}}"></p>`).dynamic).toBe(true);
  });
  it("finds the content keys markup reads, outside repeated blocks", () => {
    expect([...tokenKeys("{{@ heading}} {{@url cta.href}} {{@each items}}{{@ name}}{{@end}} {{@brand brand.name}} {{@sectionid}}")]).toEqual(["heading", "cta", "items"]);
  });
});

describe("composition", () => {
  it("turns runs of sibling placeholders into regions and composes the layout back unchanged", () => {
    const { skeleton, composition } = compositionFromLayout("home", FILES["template/layouts/home.html"]);
    expect(Object.entries(composition.regions).map(([id, r]) => [id, r.parent, r.items.length])).toEqual([
      ["r1", "body", 1],
      ["r2", "main", 3],
      ["r3", "body", 1],
    ]);
    expect(skeleton).toContain("<main>{{@region r2}}</main>");
    // processTemplate composed the layouts: byte-for-byte what was generated.
    expect(readFileSync(join(t, "layouts", "home.html"), "utf8")).toBe(FILES["template/layouts/home.html"]);
    expect(readFileSync(join(t, "layouts", "about.html"), "utf8")).toBe(FILES["template/layouts/about.html"]);
    expect(existsSync(join(t, "compose.mjs"))).toBe(true);
    expect(readOverrides(t).operations).toEqual([]);
  });

  it("reorders, removes and restores sections within their region", () => {
    apply({ op: "move", page: "home", item: "home/s04-contact", to: 0 });
    expect(order("home")).toEqual(["home/s01-navigation", "home/s04-contact", "home/s02-hero", "home/s03-cards", "home/s09-footer"]);
    expect(readFileSync(join(t, "layouts", "home.html"), "utf8")).toContain("<main>{{@section home/s04-contact}}{{@section home/s02-hero}}{{@section home/s03-cards}}</main>");
    apply({ op: "remove", page: "home", item: "home/s02-hero" });
    expect(order("home")).not.toContain("home/s02-hero");
    apply({ op: "restore", page: "home", item: "home/s02-hero" });
    expect(order("home")).toContain("home/s02-hero");
    expect(readOverrides(t).operations.map((o) => o.op)).toEqual(["move", "remove", "restore"]);
  });

  it("duplicates a section as an independent copy with unique ids", () => {
    const rec = apply({ op: "duplicate", page: "home", item: "home/s02-hero" });
    expect(rec.as).toBe("s02-hero-copy1");
    expect(order("home").slice(1, 3)).toEqual(["home/s02-hero", "home/s02-hero-copy1"]);
    const copy = readFileSync(join(t, "components/pages/home/s02-hero-copy1.html"), "utf8");
    expect(copy).toContain('id="top-s02-hero-copy1"');
    expect(rec.warnings.join(" ")).toMatch(/1 id\(s\) renamed/);
    const content = readContent(t, "home").sections!;
    expect(content["s02-hero-copy1"]).toEqual(content["s02-hero"]);
    // Independent: editing the copy leaves the original alone.
    savePageContent(t, "home", { fields: { "s02-hero-copy1.heading": "Second hero" } });
    expect((readContent(t, "home").sections!["s02-hero"] as { heading: string }).heading).toBe("Fresh bread daily");
  });

  it("refuses to copy a section scripts depend on unless confirmed, and flags interactions", () => {
    expect(() => apply({ op: "duplicate", page: "home", item: "home/s03-cards" })).toThrow(/scripts refer to #features.*Confirm to copy it anyway/);
    expect(() => apply({ op: "duplicate", page: "home", item: "home/s04-contact" })).toThrow(/interactions \(form/);
    const rec = apply({ op: "duplicate", page: "home", item: "home/s03-cards", force: true });
    expect(rec.warnings.join(" ")).toMatch(/Copied although scripts refer to #features/);
    const copy = readFileSync(join(t, "components/pages/home/s03-cards-copy1.html"), "utf8");
    expect(copy).toContain('aria-labelledby="features-title-s03-cards-copy1"');
  });

  it("inserts a copy of another page's section into a region", () => {
    const rec = apply({ op: "insert", page: "about", from: { page: "home", section: "home/s02-hero" }, region: "r2", index: 0 });
    expect(rec.as).toBe("home-s02-hero-copy1");
    expect(order("about")).toEqual(["about/s01-navigation", "about/home-s02-hero-copy1", "about/s02-list", "about/s09-footer"]);
    expect(readPage(t, "about").sections.at(-1)).toMatchObject({ origin: "insert", derivedFrom: "home/s02-hero", component: "pages/about/home-s02-hero-copy1" });
    expect(() => apply({ op: "insert", page: "about", from: { page: "home", section: "home/s02-hero" }, region: "r9", index: 0 })).toThrow(/no region r9/);
  });

  it("merges adjacent sections into one unit and unmerges them", () => {
    const rec = apply({ op: "merge", page: "home", items: ["home/s02-hero", "home/s03-cards"] });
    expect(rec.as).toBe("home/merged-1");
    apply({ op: "move", page: "home", item: "home/merged-1", to: 1 });
    expect(order("home")).toEqual(["home/s01-navigation", "home/s04-contact", "home/s02-hero", "home/s03-cards", "home/s09-footer"]);
    expect(() => apply({ op: "merge", page: "home", items: ["home/s01-navigation", "home/s04-contact"] })).toThrow(/same region/);
    apply({ op: "unmerge", page: "home", item: "home/merged-1" });
    expect(readComposition(t, "home")!.regions.r2.items.map((i) => ("section" in i ? i.section : "?"))).toEqual(["home/s04-contact", "home/s02-hero", "home/s03-cards"]);
  });

  it("splits a section at a selector: the wrapper stays, each part becomes a section with its own content", () => {
    const rec = apply({ op: "split", page: "home", item: "home/s03-cards", selector: "article.card" });
    expect(rec.warnings[0]).toMatch(/split into 3 parts.*section#features › … › div\.grid/);
    expect(order("home")).toEqual(["home/s01-navigation", "home/s02-hero", "home/s03-cards", "home/s03-cards-p1", "home/s03-cards-p2", "home/s03-cards-p3", "home/s04-contact", "home/s09-footer"]);
    const content = readContent(t, "home");
    // The heading stays in the wrapper, with its text moved to the page's frame content.
    expect((content.page as { frames: Record<string, unknown> }).frames["s03-cards"]).toEqual({ heading: "Why us" });
    expect(content.sections!["s03-cards-p2"]).toEqual({ card2: "Rye" });
    expect(content.sections!["s03-cards"]).toBeUndefined();
    const frame = readFileSync(join(t, "composition/frames/home/s03-cards.html"), "utf8");
    expect(frame).toBe(`<section class="features" id="features" data-sar-section="home/s03-cards" data-sar-type="cards"><h2 id="features-title">{{@ page.frames.s03-cards.heading}}</h2><div class="grid" aria-labelledby="features-title">{{@region r4}}</div></section>`);
    expect(readFileSync(join(t, "components/pages/home/s03-cards-p1.html"), "utf8")).toBe(`<article data-sar-section="{{@sectionid}}" class="card"><h3>{{@ card1}}</h3></article>`);
    expect(readComposition(t, "home")!.regions.r4.parent).toBe("div.grid");
    // The wrapper's text is editable like any section's.
    const home = readEditable(t).pages.find((x) => x.pageId === "home")!;
    expect(home.sections.find((x) => x.id === "frame:s03-cards")!.fields).toEqual([{ path: "heading", value: "Why us", kind: "text" }]);
    savePageContent(t, "home", { fields: { "frame:s03-cards.heading": "Why choose us" } });
    expect(((readContent(t, "home").page as { frames: Record<string, { heading: string }> }).frames["s03-cards"]).heading).toBe("Why choose us");
  });

  it("refuses splits that would break repeated blocks or the wrapper", () => {
    expect(() => apply({ op: "split", page: "about", item: "about/s02-list", selector: "li.item" })).toThrow(/repeated from a list/);
    expect(() => apply({ op: "split", page: "home", item: "home/s02-hero", selector: ".nothing" })).toThrow(/matched nothing/);
    expect(() => apply({ op: "split", page: "home", item: "home/s03-cards", selector: "h2, h3" })).toThrow(/must be siblings/);
    expect(() => apply({ op: "split", page: "home", item: "home/s02-hero", selector: "h1" })).toThrow(/one piece/);
  });

  it("excludes elements by selector on one page, keeping other pages' shared markup", () => {
    const rec = apply({ op: "exclude", page: "home", selector: ".cookie-banner" });
    expect(rec.warnings.join(" ")).toMatch(/page-specific copy of its shared markup/);
    expect(readPage(t, "home").sections.find((s) => s.id === "home/s09-footer")!.component).toBe("pages/home/s09-footer");
    expect(readFileSync(join(t, "components/pages/home/s09-footer.html"), "utf8")).not.toContain("cookie");
    expect(readFileSync(join(t, "components/shared/footer.html"), "utf8")).toContain("cookie-banner"); // about keeps it
    apply({ op: "exclude", page: "home", selector: "section.contact" }); // a section's root: the section goes
    expect(order("home")).not.toContain("home/s04-contact");
    expect(readComposition(t, "home")!.removed.at(-1)).toMatchObject({ reason: "excluded", selector: "section.contact" });
    expect(() => apply({ op: "exclude", page: "home", selector: ".does-not-exist" })).toThrow(/matched nothing/);
  });
});

describe("design tokens", () => {
  it("adds captured values as fallbacks and maps every declaration to the captured one", () => {
    const css = readFileSync(join(t, "assets/site/css/site.css"), "utf8");
    expect(css).toContain("h1 { color: var(--sar-color-primary, #b45309); }");
    expect(css).toContain("font-family: var(--sar-font-body, Georgia, serif)");
    const map = readTokenMap(t)!;
    expect(map.unaligned).toEqual([]);
    const button = map.bindings.find((b) => b.selector === ".button")!;
    expect(button).toMatchObject({ property: "background", original: "rgb(180, 83, 9)", originalFrom: "raw-capture", rawFile: "raw-capture/resources/bakery.test/css/site.css", state: "bound" });
    expect(map.bindings.find((b) => b.selector === "h1")!.original).toBe("#B45309");
    expect(map.tokens.find((x) => x.name === "--sar-color-primary")!.uses).toBe(3);
  });

  it("detaches one declaration without touching other uses of the same colour, and re-attaches it", () => {
    const h1 = readTokenMap(t)!.bindings.find((b) => b.selector === "h1")!;
    apply({ op: "token-detach", entry: h1.id });
    let css = readFileSync(join(t, "assets/site/css/site.css"), "utf8");
    expect(css).toContain("h1 { color: #B45309; }");
    expect(css).toContain(".button { background: var(--sar-color-primary, #b45309);");
    apply({ op: "token-set", entry: h1.id, value: "#123456" });
    expect(readFileSync(join(t, "assets/site/css/site.css"), "utf8")).toContain("h1 { color: #123456; }");
    expect(() => apply({ op: "token-set", entry: h1.id, value: "red; } body { display:none" })).toThrow(/plain CSS value/);
    apply({ op: "token-attach", entry: h1.id });
    css = readFileSync(join(t, "assets/site/css/site.css"), "utf8");
    expect(css).toContain("h1 { color: var(--sar-color-primary, #b45309); }");
  });

  it("falls back to the configuration's captured value when the stylesheets do not line up", () => {
    rmSync(join(t, "tokens"), { recursive: true });
    writeFileSync(join(dir, "raw-capture/resources/bakery.test/css/site.css"), "h1 { color: #b45309 }");
    processTemplate(t, capture);
    const map = readTokenMap(t)!;
    expect(map.unaligned).toEqual(["assets/site/css/site.css"]);
    expect(map.bindings.find((b) => b.selector === "h1")).toMatchObject({ original: "#b45309", originalFrom: "reference-config" });
  });
});

describe("reports", () => {
  it("gives every page and section one of four states, with reasons", () => {
    const c = coverage(t, capture, null);
    const page = (id: string | null, url?: string) => c.pages.find((p) => p.id === id && (!url || p.url === url))!;
    expect(page("blog")).toMatchObject({ status: "inaccessible" });
    expect(page("blog").reasons[0]).toMatch(/HTTP 500/);
    expect(page(null, "https://bakery.test/admin/")).toMatchObject({ status: "inaccessible" });
    expect(page("home").status).toBe("processed_with_limitations"); // generation check failed (favicon)
    expect(page("home").reasons.join(" ")).toMatch(/resources" failed/);
    const sec = (id: string) => c.sections.find((s) => s.id === id)!;
    expect(sec("home/s02-hero").status).toBe("processed");
    expect(sec("home/s04-contact")).toMatchObject({ status: "processed_with_limitations" });
    expect(sec("home/s04-contact").reasons[0]).toMatch(/Interactions: form/);
    expect(sec("about/s02-list").reasons.join(" ")).toMatch(/Uncertain classification/);
    expect(sec("about/s03-video")).toMatchObject({ status: "requires_manual_work", included: true });
    expect(sec("about/s03-video").reasons.join(" ")).toMatch(/needs_manual_review\): canvas/);
    expect(c.discovery).toMatchObject({ complete: false, limitsReached: ["maxPages"], remainingUrls: 1 });
    expect(c.summary.pages.inaccessible).toBe(2);
  });

  it("lists values that need direct source edits", () => {
    const e = sourceEdits(t);
    expect(e.items).toContainEqual(expect.objectContaining({ kind: "colour", file: "assets/site/css/site.css", where: ":root { --brand }", value: "#b45309" }));
    expect(e.items).toContainEqual(expect.objectContaining({ kind: "text", file: "components/pages/home/s02-hero.html", value: "Limited offer" }));
    expect(e.items).toContainEqual(expect.objectContaining({ kind: "script", file: "assets/site/js/app.js" }));
    expect(e.items.some((x) => x.value.includes("var(--sar-color-primary"))).toBe(false); // tokens are not listed
  });
});

describe.skipIf(!hasRuntime)("building and checking with the real template runtime", () => {
  const verify = () => verifyTemplate(t, join(dir, "verify-dist"), join(dir, "reports", "verification.json"));

  it("builds the generated template and passes Web's checks", () => {
    const v = verify();
    expect(v.build).toEqual({ ok: true, error: null });
    const home = v.pages.find((p) => p.page === "home")!;
    expect(home.sections).toMatchObject({ passed: true, rendered: ["home/s01-navigation", "home/s02-hero", "home/s03-cards", "home/s04-contact", "home/s09-footer"] });
    expect(home.content.checked).toBeGreaterThan(5);
    expect(home.content.missing).toEqual([]);
    expect(home.missingAssets).toEqual([]);
    expect(home.duplicateIds).toEqual([]);
    expect(v.summary).toEqual({ pages: 2, passed: 2, failed: 0 });
  });

  it("verifies section insertion, removal, reordering, duplication, splitting and content and token changes in the built pages", () => {
    apply({ op: "duplicate", page: "home", item: "home/s02-hero" });
    apply({ op: "move", page: "home", item: "home/s04-contact", to: 0 });
    apply({ op: "remove", page: "home", item: "home/s03-cards" });
    apply({ op: "insert", page: "about", from: { page: "home", section: "home/s04-contact" }, region: "r2", index: 1, force: true });
    apply({ op: "split", page: "home", item: "home/s02-hero", selector: "a.button" });
    savePageContent(t, "home", { fields: { "s02-hero-copy1.heading": "Second hero" } });
    saveBrand(t, { colors: { primary: "#ff0066" } });
    const v = verify();
    expect(v.summary.failed).toBe(0);
    const home = v.pages.find((p) => p.page === "home")!;
    expect(home.sections.rendered).toEqual(["home/s01-navigation", "home/s04-contact", "home/s02-hero", "home/s02-hero-p1", "home/s02-hero-p2", "home/s02-hero-copy1", "home/s09-footer"]);
    expect(home.duplicateIds).toEqual([]);
    const html = readFileSync(join(dir, "verify-dist", "index.html"), "utf8");
    expect(html).toContain("Second hero");
    expect(html).toContain('id="top-s02-hero-copy1"');
    expect(html).not.toContain("Why us"); // removed
    expect(readFileSync(join(dir, "verify-dist", "brand", "brand.css"), "utf8")).toContain("--sar-color-primary: #ff0066");
    const about = v.pages.find((p) => p.page === "about")!;
    expect(about.sections.rendered).toEqual(["about/s01-navigation", "about/s02-list", "about/home-s04-contact-copy1", "about/s09-footer"]);
    expect(readFileSync(join(dir, "verify-dist", "about", "index.html"), "utf8")).toContain('<label for="email-home-s04-contact-copy1">');
  });

  it("reports missing assets and duplicate ids", () => {
    writeFileSync(join(t, "components/pages/home/s02-hero.html"), FILES["template/components/pages/home/s02-hero.html"].replace("<h1>", '<img src="{{@root}}assets/missing.png"><h1 id="features">'));
    const v = verify();
    const home = v.pages.find((p) => p.page === "home")!;
    expect(home.missingAssets).toEqual([{ ref: "./assets/missing.png", from: "index.html" }]);
    expect(home.duplicateIds).toEqual(["features"]);
    expect(home.passed).toBe(false);
  });
});

describe.skipIf(!hasRuntime)("workspace: replaying overrides and exporting", () => {
  let root: string;
  const jobId = "tpl_TemplatesTest000001";
  beforeEach(() => {
    root = join(dir, "workspaces");
    createWorkspace(root, jobId, fixtureZip(true), SAR_HOME);
  });

  it("undoing an override replays the others on a fresh copy and keeps edits", () => {
    const p = workspacePaths(root, jobId);
    const c = opContext(p.template, p.capture);
    applyOperation(p.template, { op: "move", page: "home", item: "home/s04-contact", to: 0 }, c);
    applyOperation(p.template, { op: "duplicate", page: "home", item: "home/s02-hero" }, c);
    savePageContent(p.template, "home", { fields: { "s02-hero.heading": "Edited hero", "s02-hero-copy1.heading": "Copy heading" } });
    saveBrand(p.template, { name: "Renamed Bakery" });
    const ops = readOverrides(p.template).operations;
    const r = reprocessWorkspace(root, jobId, fixtureZip(true), ops.filter((o) => o.op !== "move"));
    expect(r.failed).toEqual([]);
    const t2 = p.template;
    expect(renderOrder(readComposition(t2, "home")!, readFileSync(join(t2, "composition/skeletons/home.html"), "utf8"))).toEqual(["home/s01-navigation", "home/s02-hero", "home/s02-hero-copy1", "home/s03-cards", "home/s04-contact", "home/s09-footer"]);
    expect(readEditable(t2).pages.find((x) => x.pageId === "home")!.sections.find((s) => s.id === "s02-hero")!.fields.find((f) => f.path === "heading")!.value).toBe("Edited hero");
    expect((readContent(t2, "home").sections!["s02-hero-copy1"] as { heading: string }).heading).toBe("Copy heading");
    expect(readEditable(t2).brand.name).toBe("Renamed Bakery");
    expect(readOverrides(t2).operations.map((o) => o.op)).toEqual(["duplicate"]);
  });

  it("exports raw capture, the edited template, composition, overrides, tokens, reports and the editing guide", () => {
    const p = workspacePaths(root, jobId);
    applyOperation(p.template, { op: "remove", page: "home", item: "home/s02-hero" }, opContext(p.template, p.capture));
    const files = unzipSync(buildExport(p.template, p.capture, p.reports, fixtureZip(true)));
    const names = Object.keys(files);
    for (const n of ["raw-capture/resources/bakery.test/css/site.css", "section-inventory.json", "template/compose.mjs", "template/composition/home.json", "template/composition/skeletons/home.html", "template/overrides.json", "template/tokens/token-map.json", "template/build.mjs", "reports/coverage.json", "reports/source-edits.json", "EDITING.md"]) {
      expect(names).toContain(`website-template/${n}`);
    }
    expect(names.some((n) => n.includes("/dist/"))).toBe(false);
    expect(new TextDecoder().decode(files["website-template/template/layouts/home.html"])).not.toContain("s02-hero");
    const view = structureView(p.template, p.capture, p.reports);
    expect(view.pages.find((x) => x.pageId === "home")!.removed.map((r) => r.id)).toEqual(["home/s02-hero"]);
  });

  it("the exported template builds by itself after its composition is edited by hand", () => {
    const p = workspacePaths(root, jobId);
    const out = join(dir, "exported");
    const files = unzipSync(buildExport(p.template, p.capture, p.reports, fixtureZip(true)));
    for (const [n, b] of Object.entries(files)) {
      mkdirSync(dirname(join(out, n)), { recursive: true });
      writeFileSync(join(out, n), b);
    }
    const tpl = join(out, "website-template", "template");
    const comp = JSON.parse(readFileSync(join(tpl, "composition/home.json"), "utf8"));
    comp.regions.r2.items.reverse();
    writeFileSync(join(tpl, "composition/home.json"), JSON.stringify(comp));
    compose(tpl); // the same script as `node compose.mjs`
    expect(readFileSync(join(tpl, "layouts/home.html"), "utf8")).toContain("<main>{{@section home/s04-contact}}{{@section home/s03-cards}}{{@section home/s02-hero}}</main>");
  });
});

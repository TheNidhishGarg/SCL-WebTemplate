import { PLACEHOLDER, type LinkTarget, type MediaRef, type PageContent, type PageStatus, type Section } from "./content";

// Checks a site's pages for what would make them wrong to publish: incomplete
// required content, placeholders, broken internal links, missing assets,
// images without descriptions, duplicate paths. Errors block review and
// publication; warnings are listed.

export type ContentIssue = { pageId: string | null; sectionId: string | null; path: string; level: "error" | "warning"; message: string };

export type ValidationContext = {
  pages: { id: string; status: PageStatus; published: boolean; content: PageContent }[];
  blocks: Map<string, Section>;
  assetIds: Set<string>;
  baseUrl: string;
  brand: { selected: boolean; approved: boolean };
};

const blank = (s: string) => s.trim() === "";

function walkStrings(o: unknown, path: string, out: (path: string, s: string) => void) {
  if (typeof o === "string") out(path, o);
  else if (Array.isArray(o)) o.forEach((x, i) => walkStrings(x, `${path}.${i}`, out));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walkStrings(v, path ? `${path}.${k}` : k, out);
}

// The page's issues; `publishing` adds the checks that only matter when it goes live.
export function validatePage(pageId: string, ctx: ValidationContext, publishing = false): ContentIssue[] {
  const page = ctx.pages.find((p) => p.id === pageId);
  if (!page) return [];
  const c = page.content;
  const issues: ContentIssue[] = [];
  const add = (level: "error" | "warning", path: string, message: string, sectionId: string | null = null) => issues.push({ pageId, sectionId, path, level, message });

  walkStrings(c, "", (path, s) => {
    const m = PLACEHOLDER.exec(s);
    if (m) add("error", path, `Replace the placeholder ${m[0].slice(0, 80)}${m[0].length > 80 ? "…" : ""}`, sectionAt(c, path));
  });
  if (ctx.pages.some((p) => p.id !== pageId && p.content.slug === c.slug)) add("error", "slug", `Another page already uses the path /${c.slug}`);
  // /journeys/<key> is where WF-08 plays cinematic journeys on the site.
  if (/^journeys(\/|$)/.test(c.slug)) add("error", "slug", "The path /journeys is reserved for cinematic journeys");
  if (blank(c.seo.title)) add("error", "seo.title", "Add an SEO title");
  else if (c.seo.title.length > 60) add("warning", "seo.title", `SEO title is ${c.seo.title.length} characters; search results show about 60`);
  if (blank(c.seo.description)) add("error", "seo.description", "Add a meta description");
  else if (c.seo.description.length < 50) add("warning", "seo.description", "Meta description is short; aim for 50–160 characters");
  if (c.inNav && blank(c.navLabel)) add("error", "navLabel", "Pages in the navigation need a navigation label");
  if (c.sections.length === 0) add("error", "sections", "Add at least one section");
  checkMedia(c.seo.ogImage, "seo.ogImage", null, ctx, add);

  const heroes = c.sections.filter((s) => s.type === "hero");
  if (heroes.length > 1) add("warning", "sections", "More than one hero: only the first heading becomes the page's main heading (h1)");

  c.sections.forEach((raw, i) => {
    const at = `sections.${i}`;
    let s: Section = raw;
    if (raw.type === "block") {
      const b = ctx.blocks.get(raw.blockId);
      if (!b) return add("error", at, "This reusable block no longer exists", raw.id);
      s = b;
    }
    const need = (cond: boolean, path: string, msg: string) => cond || add("error", `${at}.${path}`, msg, raw.id);
    switch (s.type) {
      case "hero":
        need(!blank(s.heading), "heading", "The hero needs a heading");
        break;
      case "text":
        need(!blank(s.body), "body", "The text section is empty");
        break;
      case "features":
        need(s.items.length > 0, "items", "Add at least one feature");
        s.items.forEach((it, j) => need(!blank(it.title), `items.${j}.title`, `Feature ${j + 1} needs a title`));
        break;
      case "gallery":
        need(s.images.length > 0, "images", "Add at least one image");
        break;
      case "faq":
        need(s.items.length > 0, "items", "Add at least one question");
        s.items.forEach((it, j) => need(!blank(it.question) && !blank(it.answer), `items.${j}`, `Question ${j + 1} needs both a question and an answer`));
        break;
      case "cta":
        need(!blank(s.heading), "heading", "The call to action needs a heading");
        need(s.ctas.length > 0, "ctas", "Add at least one button");
        break;
      case "contact":
        need(!blank(s.heading), "heading", "The contact section needs a heading");
        need(!blank(s.email) || !blank(s.phone) || s.actionKind !== null, "email", "Give an email, a phone number or a form action");
        break;
    }
    for (const [path, m] of mediaIn(s)) checkMedia(m, `${at}.${path}`, raw.id, ctx, add);
    for (const [path, cta] of ctasIn(s)) {
      if (blank(cta.label)) add("error", `${at}.${path}.label`, "Every button needs a label", raw.id);
      checkLink(cta.target, `${at}.${path}.target`, raw.id, pageId, ctx, publishing, add);
    }
  });

  if (publishing) {
    if (!ctx.brand.selected) add("error", "site.brandId", "Choose the site's brand (WF-04) before publishing");
    else if (!ctx.brand.approved) add("error", "site.brandId", "The site's brand has no approved version yet");
    if (!ctx.baseUrl) add("warning", "site.baseUrl", "Set the site address so canonical URLs are absolute");
  }
  return issues;
}

function sectionAt(c: PageContent, path: string): string | null {
  const m = /^sections\.(\d+)/.exec(path);
  return m ? c.sections[Number(m[1])]?.id ?? null : null;
}

function mediaIn(s: Section): [string, MediaRef][] {
  switch (s.type) {
    case "hero":
      return [["media", s.media]];
    case "features":
      return s.items.map((it, j) => [`items.${j}.media`, it.media] as [string, MediaRef]);
    case "gallery":
      return s.images.map((m, j) => [`images.${j}`, m] as [string, MediaRef]);
    default:
      return [];
  }
}

function ctasIn(s: Section) {
  return s.type === "hero" || s.type === "cta" ? s.ctas.map((c, j) => [`ctas.${j}`, c] as const) : [];
}

function checkMedia(m: MediaRef, path: string, sectionId: string | null, ctx: ValidationContext, add: (l: "error" | "warning", p: string, msg: string, s?: string | null) => void) {
  if (!m) return;
  if (m.source.kind === "asset" && !ctx.assetIds.has(m.source.assetId)) add("error", path, "Missing asset: the image is not in this project's asset register", sectionId);
  if (!m.decorative && blank(m.alt)) add("error", `${path}.alt`, "Describe the image (alt text), or mark it decorative", sectionId);
}

function checkLink(t: LinkTarget, path: string, sectionId: string, fromPage: string, ctx: ValidationContext, publishing: boolean, add: (l: "error" | "warning", p: string, msg: string, s?: string | null) => void) {
  if (t.kind === "url") return;
  const target = ctx.pages.find((p) => p.id === t.pageId);
  if (!target) return add("error", path, "Broken link: the target page no longer exists", sectionId);
  if (t.kind === "section" && !target.content.sections.some((s) => s.id === t.sectionId)) add("error", path, `Broken link: the section no longer exists on "${target.content.title}"`, sectionId);
  if (publishing && t.pageId !== fromPage && !target.published) add("error", path, `Links to "${target.content.title}", which is not published`, sectionId);
}

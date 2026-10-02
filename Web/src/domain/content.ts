import { z } from "zod";

// WF-05 content model. Content is data only: no markup, no classes, no
// styling. Shared presentation components (src/site/) decide how each section
// type looks, and the brand (WF-04) supplies every colour, font and spacing.
// Editing content never requires touching a component.
//
// Every page, section, media item and CTA has a stable id (a UUID assigned
// once and kept across edits), exposed in the rendered HTML and in the
// content manifest for WF-08.

export const PageId = z.uuid().brand<"PageId">();
export type PageId = z.infer<typeof PageId>;

// Text a generator wrote as a prompt for a person. It is incomplete content:
// a page containing it cannot be submitted or published.
export const PLACEHOLDER = /\[Write:[^\]]*\]/;
export const placeholder = (what: string) => `[Write: ${what}]`;

const Text = (max: number) => z.string().trim().max(max);
const Id = z.uuid();

export const MediaRef = z
  .object({
    id: Id,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("asset"), assetId: z.uuid() }),
      z.object({ kind: z.literal("url"), url: z.url({ protocol: /^https$/, error: "Use an https image URL" }) }),
    ]),
    alt: Text(300),
    // Decorative images get empty alt; anything else needs a description.
    decorative: z.boolean(),
  })
  .nullable();
export type MediaRef = z.infer<typeof MediaRef>;

export const LinkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), pageId: Id }),
  z.object({ kind: z.literal("section"), pageId: Id, sectionId: Id }),
  z.object({ kind: z.literal("url"), url: z.url({ protocol: /^(https?|mailto|tel)$/, error: "Use https://, mailto: or tel:" }) }),
]);
export type LinkTarget = z.infer<typeof LinkTarget>;

export const Cta = z.object({
  id: Id,
  label: Text(60),
  target: LinkTarget,
  style: z.enum(["primary", "secondary"]),
  // The WF-01 desired action it serves, for WF-09 tracking.
  actionKind: z.string().max(40).nullable(),
});
export type Cta = z.infer<typeof Cta>;

const Item = z.object({ id: Id, title: Text(120), body: Text(1000), media: MediaRef });

export const Section = z.discriminatedUnion("type", [
  z.object({ id: Id, type: z.literal("hero"), eyebrow: Text(80), heading: Text(160), body: Text(600), media: MediaRef, ctas: z.array(Cta).max(3) }),
  z.object({ id: Id, type: z.literal("text"), heading: Text(160), body: Text(8000) }),
  z.object({ id: Id, type: z.literal("features"), heading: Text(160), intro: Text(600), items: z.array(Item).max(12) }),
  z.object({ id: Id, type: z.literal("gallery"), heading: Text(160), images: z.array(MediaRef.unwrap()).max(24) }),
  z.object({ id: Id, type: z.literal("faq"), heading: Text(160), items: z.array(z.object({ id: Id, question: Text(300), answer: Text(2000) })).max(30) }),
  z.object({ id: Id, type: z.literal("cta"), heading: Text(160), body: Text(600), ctas: z.array(Cta).max(3) }),
  z.object({ id: Id, type: z.literal("contact"), heading: Text(160), body: Text(1000), email: z.union([z.literal(""), z.email("Enter a valid email address")]), phone: Text(40), actionKind: z.string().max(40).nullable() }),
  // A reusable block, placed by reference: editing the block updates every page using it.
  z.object({ id: Id, type: z.literal("block"), blockId: Id }),
]);
export type Section = z.infer<typeof Section>;
export type SectionType = Section["type"];
export const SECTION_LABELS: Record<SectionType, string> = {
  hero: "Hero",
  text: "Text",
  features: "Features",
  gallery: "Gallery",
  faq: "FAQ",
  cta: "Call to action",
  contact: "Contact",
  block: "Reusable block",
};

export const PageLayout = z.enum(["standard", "landing", "article"]);

const SlugPath = z
  .string()
  .trim()
  .max(120)
  .regex(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/, "Lowercase words and hyphens, e.g. our-work or work/case-studies; empty for the home page");

export const PageContent = z
  .object({
    slug: SlugPath,
    title: Text(120).min(1, "Give the page a title"),
    navLabel: Text(40),
    inNav: z.boolean(),
    inFooter: z.boolean(),
    layout: PageLayout,
    // A WF-03 manifest template this page follows, if any (by id).
    templateRef: z.uuid().nullable(),
    seo: z.object({
      title: Text(70),
      description: Text(170),
      // Overrides the canonical path, e.g. when the same content lives elsewhere.
      canonicalPath: z.string().trim().max(200).regex(/^$|^\/[^\s?#]*$/, "Start with / and leave out the domain, e.g. /work"),
      noindex: z.boolean(),
      ogImage: MediaRef,
    }),
    sections: z.array(Section).max(40),
  })
  .strict();
export type PageContent = z.infer<typeof PageContent>;

export const PageStatus = z.enum(["draft", "in_review", "approved", "published"]);
export type PageStatus = z.infer<typeof PageStatus>;

export const SiteSettings = z.object({
  baseUrl: z.union([z.literal(""), z.url({ protocol: /^https$/, error: "Use the https address the site will live at" })]),
  brandId: z.uuid().nullable(),
  siteName: Text(80),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "A language tag, e.g. en-IN"),
});
export type SiteSettings = z.infer<typeof SiteSettings>;

export const BlockContent = z.object({ name: Text(80).min(1, "Name the block"), section: Section });

// Where a page lives. The home page has the empty slug.
export const pagePath = (slug: string) => (slug ? `/${slug}` : "/");
export const sectionAnchor = (sectionId: string) => `s-${sectionId}`;

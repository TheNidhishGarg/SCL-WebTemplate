import type { ClientBriefContent } from "./client-brief";
import { DESIRED_ACTION_LABELS } from "./client-brief";
import { placeholder, type Cta, type PageContent, type Section } from "./content";

// First drafts of the sitemap and pages, from an approved WF-01 brief.
// It uses only what the brief says - page titles, purposes, desired actions -
// and writes [Write: …] prompts wherever copy is needed. Those prompts are
// incomplete content: nothing generated can be published until a person has
// replaced them and approved the page.

const CONTACT = /(^|-)(contact|enquir|inquir|book|get-in-touch)/;

export type GeneratedPage = { id: string; content: PageContent };

export function generateSitemap(brief: ClientBriefContent, existingSlugs: Set<string>, clientName: string): GeneratedPage[] {
  const pages = brief.requiredPages.map((p) => ({ id: crypto.randomUUID(), slug: p.slug === "home" || p.slug === "index" ? "" : p.slug, title: p.title, purpose: p.purpose }));
  const contact = pages.find((p) => CONTACT.test(p.slug));
  const primaryAction = brief.desiredActions[0];
  const actionCta = (): Cta[] =>
    contact && primaryAction
      ? [{ id: crypto.randomUUID(), label: placeholder(`button: ${DESIRED_ACTION_LABELS[primaryAction.kind].toLowerCase()}`).slice(0, 60), target: { kind: "page", pageId: contact.id }, style: "primary", actionKind: primaryAction.kind }]
      : [];

  return pages
    .filter((p) => !existingSlugs.has(p.slug))
    .map((p) => {
      const isHome = p.slug === "";
      const isContact = p === contact;
      const sections: Section[] = [
        {
          id: crypto.randomUUID(),
          type: "hero",
          eyebrow: "",
          heading: isHome ? placeholder(`home page headline for ${clientName}`) : p.title,
          body: placeholder(`introduction. Page purpose: ${p.purpose}`),
          media: null,
          ctas: isContact ? [] : actionCta(),
        },
      ];
      if (isHome) {
        const others = pages.filter((o) => o !== p).slice(0, 6);
        if (others.length) {
          sections.push({
            id: crypto.randomUUID(),
            type: "features",
            heading: placeholder("heading introducing what the site offers"),
            intro: "",
            items: others.map((o) => ({ id: crypto.randomUUID(), title: o.title, body: placeholder(`one or two sentences on: ${o.purpose}`), media: null })),
          });
        }
      } else if (isContact) {
        sections.push({ id: crypto.randomUUID(), type: "contact", heading: p.title, body: placeholder("how and when to get in touch"), email: "", phone: "", actionKind: primaryAction?.kind ?? null });
      } else {
        sections.push({ id: crypto.randomUUID(), type: "text", heading: placeholder("section heading"), body: placeholder(`page content. Purpose: ${p.purpose}. Audiences: ${brief.audiences.map((a) => a.name).join(", ")}`) });
      }
      if (!isContact && actionCta().length) {
        sections.push({ id: crypto.randomUUID(), type: "cta", heading: placeholder("closing call to action"), body: "", ctas: actionCta() });
      }
      return {
        id: p.id,
        content: {
          slug: p.slug,
          title: p.title,
          navLabel: isHome ? "Home" : p.title.slice(0, 40),
          inNav: true,
          inFooter: isContact,
          layout: isHome ? "landing" : "standard",
          templateRef: null,
          seo: { title: `${p.title} | ${clientName}`.slice(0, 70), description: placeholder(`one-sentence search summary: ${p.purpose}`).slice(0, 170), canonicalPath: "", noindex: false, ogImage: null },
          sections,
        },
      } satisfies GeneratedPage;
    });
}

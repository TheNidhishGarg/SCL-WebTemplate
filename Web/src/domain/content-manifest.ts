import { z } from "zod";
import { PageContent, PageLayout, PageStatus, Section } from "./content";
import { ProjectId } from "./ids";

// The WF-05 handoff to WF-08 (assembly) and WF-09 (conversion): the site's
// pages, sections, media and CTAs with their stable ids, where each renders,
// and the content itself. Ids never change once assigned; the rendered HTML
// carries the same ids as data attributes and section anchors.

export const CONTENT_MANIFEST_SCHEMA = "scl.wf-05.content-manifest/v1";

const Issue = z.object({ pageId: z.string().nullable(), sectionId: z.string().nullable(), path: z.string(), level: z.enum(["error", "warning"]), message: z.string() });

export const ContentManifest = z.object({
  schema: z.literal(CONTENT_MANIFEST_SCHEMA),
  generatedAt: z.iso.datetime(),
  project: z.object({ id: ProjectId, slug: z.string() }),
  site: z.object({
    siteName: z.string(),
    baseUrl: z.string(),
    locale: z.string(),
    brand: z.object({ id: z.string(), version: z.int().nullable(), configPath: z.string(), cssPath: z.string() }).nullable(),
    publishedRoot: z.string(),
    previewRoot: z.string(),
  }),
  navigation: z.object({
    primary: z.array(z.object({ pageId: z.string(), label: z.string(), path: z.string() })),
    footer: z.array(z.object({ pageId: z.string(), label: z.string(), path: z.string() })),
  }),
  pages: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      canonicalUrl: z.string().nullable(),
      title: z.string(),
      layout: PageLayout,
      templateRef: z.string().nullable(),
      status: PageStatus,
      revision: z.int(),
      published: z.object({ revision: z.int(), at: z.iso.datetime() }).nullable(),
      sections: z.array(z.object({ id: z.string(), type: z.string(), anchor: z.string(), blockId: z.string().nullable() })),
      media: z.array(z.object({ id: z.string(), sectionId: z.string().nullable(), source: z.unknown(), alt: z.string(), decorative: z.boolean() })),
      ctas: z.array(z.object({ id: z.string(), sectionId: z.string(), label: z.string(), actionKind: z.string().nullable(), target: z.unknown() })),
      // The editable content of the latest revision.
      content: PageContent,
      issues: z.array(Issue),
    }),
  ),
  blocks: z.array(z.object({ id: z.string(), name: z.string(), section: Section, usedBy: z.array(z.string()) })),
});
export type ContentManifest = z.infer<typeof ContentManifest>;

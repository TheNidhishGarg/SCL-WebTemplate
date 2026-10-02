import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pagePath } from "@/domain/content";
import { getDashboardStore } from "@/server/store";
import { SitePage, type RenderInput } from "./render";

// Shared by the published route (/site/...) and the preview route
// (/preview/...): resolve the page for a path, then render it.

export async function resolveFor(params: Promise<{ projectId: string; slug?: string[] }>, mode: "preview" | "published"): Promise<RenderInput | null> {
  const { projectId, slug } = await params;
  const store = getDashboardStore();
  if (!store.getProject(projectId)) return null;
  const path = pagePath((slug ?? []).map((s) => decodeURIComponent(s)).join("/"));
  const r = store.content.resolve(projectId, path, mode);
  if (!r) return null;
  // WF-08 journeys entered from this page. A failure here must never take the page down.
  let journeys: RenderInput["journeys"] = [];
  try {
    journeys = store.experience.launchers(projectId, mode).filter((j) => j.pageId === r.page.id);
  } catch (e) {
    console.error("journey launchers unavailable", e);
  }
  return { projectId, root: `/${mode === "preview" ? "preview" : "site"}/${projectId}`, preview: mode === "preview", journeys, ...r };
}

export function metadataFor(r: RenderInput | null, mode: "preview" | "published"): Metadata {
  if (!r) return { title: "Not found", robots: { index: false } };
  const c = r.page.content;
  const canonicalPath = c.seo.canonicalPath || pagePath(c.slug);
  const og = c.seo.ogImage;
  const ogUrl = og ? (og.source.kind === "url" ? og.source.url : r.site.baseUrl ? `${r.site.baseUrl}/media/${og.source.assetId}` : undefined) : undefined;
  return {
    title: c.seo.title || c.title,
    description: c.seo.description || undefined,
    alternates: r.site.baseUrl ? { canonical: `${r.site.baseUrl}${canonicalPath}` } : undefined,
    // A preview is never indexed, whatever the page says.
    robots: mode === "preview" || c.seo.noindex ? { index: false, follow: false } : undefined,
    openGraph: { title: c.seo.title || c.title, description: c.seo.description || undefined, siteName: r.site.siteName, images: ogUrl ? [{ url: ogUrl, alt: og?.alt }] : undefined },
  };
}

export function Rendered({ r }: { r: RenderInput | null }) {
  if (!r) notFound();
  return <SitePage r={r} />;
}

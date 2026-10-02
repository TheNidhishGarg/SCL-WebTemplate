import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/content/page-editor";
import { pagePath } from "@/domain/content";
import { getDashboardStore } from "@/server/store";
import { pickerData } from "../data";

export const metadata: Metadata = { title: "Edit page · SCL Web" };

export default async function EditPage({ params }: PageProps<"/projects/[projectId]/pages/[pageId]">) {
  const { projectId, pageId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const all = store.content.pages(projectId);
  const page = all.find((p) => p.id === pageId);
  if (!page) notFound();
  const site = store.content.site(projectId);
  const blocks = store.content.blocks(projectId);
  const brandApproved = site.brandId ? store.brands.list(projectId).some((b) => b.brand.id === site.brandId && b.approved) : false;
  const templates = store.sources.manifest(projectId).templates.map((t) => ({ id: t.id, name: `${t.name} (${t.kind.replace("_", " ")})` }));

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link> / <Link href={`/projects/${projectId}/pages`}>Pages</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>{page.content.title}</h1>
          <p className="muted small">
            <code>{pagePath(page.content.slug)}</code> · page id <code>{page.id}</code> · {page.origin === "generated" ? "generated from the brief" : "created by hand"}
            {page.published && ` · live: revision ${page.published.revision}`}
          </p>
        </div>
        <div className="actions">
          <a className="button" href={`/preview/${projectId}${pagePath(page.content.slug) === "/" ? "" : pagePath(page.content.slug)}`} target="_blank" rel="noreferrer">
            Preview
          </a>
          {page.published && (
            <a className="button" href={`/site/${projectId}${pagePath(page.published.content.slug) === "/" ? "" : pagePath(page.published.content.slug)}`} target="_blank" rel="noreferrer">
              Published
            </a>
          )}
        </div>
      </div>
      <PageEditor
        // Keyed on the page only: a save bumps the revision, and remounting would drop the editor's state and its result message.
        key={page.id}
        projectId={projectId}
        pageId={page.id}
        revision={page.revision}
        status={page.status}
        published={page.published !== null}
        initial={page.content}
        ctx={{
          pages: all.map((p) => ({ id: p.id, status: p.status, published: p.published !== null, content: p.content })),
          blocks: blocks.map((b) => [b.id, b.section]),
          assetIds: detail.assets.map((a) => a.id),
          baseUrl: site.baseUrl,
          brand: { selected: site.brandId !== null, approved: brandApproved },
        }}
        data={pickerData(store, projectId)}
        blocks={blocks.map((b) => ({ id: b.id, name: b.name }))}
        templates={templates}
      />
    </>
  );
}

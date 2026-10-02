import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlockEditor, GenerateButton, NewPageForm, PageRowActions, SiteSettingsForm } from "@/components/content/pages-forms";
import { formatDateTime } from "@/components/format";
import { CONTENT_MANIFEST_SCHEMA } from "@/domain/content-manifest";
import { pagePath, SECTION_LABELS } from "@/domain/content";
import { getDashboardStore } from "@/server/store";
import { pickerData } from "./data";

export const metadata: Metadata = { title: "Pages · SCL Web" };

const TONE: Record<string, string> = { draft: "warn", in_review: "warn", approved: "", published: "ok" };

export default async function PagesPage({ params }: PageProps<"/projects/[projectId]/pages">) {
  const { projectId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const manifest = store.content.manifest(projectId);
  const site = store.content.site(projectId);
  const blocks = store.content.blocks(projectId);
  const data = pickerData(store, projectId);
  const brands = store.brands.list(projectId).map((b) => ({ id: b.brand.id, name: b.brand.name }));
  const hasPages = manifest.pages.length > 0;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Pages</h1>
          <p className="muted">WF-05: the conventional website. Content is edited here and rendered by shared components with the WF-04 brand.</p>
        </div>
        <div className="actions">
          <a className="button" href={`/preview/${projectId}`} target="_blank" rel="noreferrer">
            Preview site
          </a>
          <a className="button" href={`/api/projects/${projectId}/content/manifest`} target="_blank" rel="noreferrer">
            Content manifest
          </a>
        </div>
      </div>

      <div className="grid grid-main-side">
        <div className="stack">
          <section className="card" aria-labelledby="sitemap-heading">
            <h2 id="sitemap-heading">Sitemap ({manifest.pages.length})</h2>
            {!hasPages ? (
              <div className="empty">
                <p className="muted">No pages yet. Generate the sitemap and first drafts from the approved brief, or create pages by hand.</p>
              </div>
            ) : (
              <ol className="log">
                {manifest.pages.map((p, i) => {
                  const errors = p.issues.filter((x) => x.level === "error").length;
                  return (
                    <li key={p.id}>
                      <div className="actions" style={{ justifyContent: "space-between" }}>
                        <span>
                          <Link href={`/projects/${projectId}/pages/${p.id}`} style={{ fontWeight: 600 }}>
                            {p.title}
                          </Link>{" "}
                          <code className="small">{p.path}</code>
                        </span>
                        <span className="actions">
                          <span className={`badge ${TONE[p.status]}`}>{p.status.replace("_", " ")}</span>
                          {p.published && p.status !== "published" && <span className="badge ok">live: rev {p.published.revision}</span>}
                          <PageRowActions projectId={projectId} pageId={p.id} title={p.title} first={i === 0} last={i === manifest.pages.length - 1} />
                        </span>
                      </div>
                      <div className="small muted">
                        {p.sections.map((s) => SECTION_LABELS[s.type as keyof typeof SECTION_LABELS] ?? s.type).join(" · ")}
                        {errors > 0 && <span style={{ color: "var(--color-danger)" }}> · {errors} item(s) to complete</span>}
                        {p.published && ` · published ${formatDateTime(p.published.at)}`}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <div style={{ marginTop: "1rem" }}>
              <GenerateButton projectId={projectId} disabled={!detail.approved} />
              {!detail.approved && <p className="small muted">Approve the client brief first to generate pages from it.</p>}
            </div>
          </section>

          <section className="card" aria-labelledby="blocks-heading">
            <h2 id="blocks-heading">Reusable blocks ({blocks.length})</h2>
            {blocks.length === 0 && <p className="small muted">None. Use &ldquo;Save as block&rdquo; on any section to reuse it across pages.</p>}
            {blocks.map((b) => (
              <details key={b.id} className="card" style={{ marginTop: "0.5rem" }}>
                <summary>
                  {b.name} <span className="muted small">({SECTION_LABELS[b.section.type]}, used on {manifest.blocks.find((x) => x.id === b.id)?.usedBy.length ?? 0} page(s))</span>
                </summary>
                <BlockEditor projectId={projectId} block={b} data={data} issues={new Map()} />
              </details>
            ))}
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <SiteSettingsForm projectId={projectId} initial={site} brands={brands} />
          </section>
          <section className="card">
            <NewPageForm projectId={projectId} />
          </section>
          <p className="small muted">
            WF-08 reads <code>{CONTENT_MANIFEST_SCHEMA}</code>. Published pages live at <code>/site/{projectId}{pagePath("")}</code>.
          </p>
        </div>
      </div>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssetLinkForm, AssetUploadForm, RemoveAssetButton } from "@/components/asset-forms";
import { formatBytes, formatDateTime } from "@/components/format";
import { ASSET_KIND_LABELS } from "@/domain/asset";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Assets · SCL Web" };

export default async function AssetsPage({ params }: PageProps<"/projects/[projectId]/assets">) {
  const { projectId } = await params;
  const detail = getDashboardStore().getProject(projectId);
  if (!detail) notFound();
  const { project, assets } = detail;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${project.id}`}>{project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Asset register</h1>
          <p className="muted">
            What {project.clientName} already has: logos, fonts, guidelines, photography and video. Included in the brief
            handoff.
          </p>
        </div>
      </div>

      <div className="grid grid-main-side">
        <section className="card" aria-labelledby="register-heading">
          <h2 id="register-heading">Recorded assets ({assets.length})</h2>
          {assets.length === 0 ? (
            <div className="empty">
              <p className="muted">
                Nothing recorded yet. Start with the logo; WF-04 builds the brand configuration from what is here.
              </p>
            </div>
          ) : (
            <ul className="feed">
              {assets.map((a) => (
                <li key={a.id}>
                  <div className="actions" style={{ justifyContent: "space-between" }}>
                    <span>
                      <span className="badge">{ASSET_KIND_LABELS[a.kind]}</span> <strong>{a.label}</strong>
                    </span>
                    <RemoveAssetButton projectId={project.id} assetId={a.id} label={a.label} />
                  </div>
                  {a.source.type === "url" ? (
                    <a href={a.source.url} target="_blank" rel="noreferrer noopener" style={{ overflowWrap: "anywhere" }}>
                      {a.source.url}
                    </a>
                  ) : (
                    <a href={`/api/projects/${project.id}/assets/${a.id}/file`}>
                      {a.source.file.filename} ({formatBytes(a.source.file.sizeBytes)})
                    </a>
                  )}
                  {a.notes && <div className="small muted">{a.notes}</div>}
                  <time dateTime={a.createdAt}>Added {formatDateTime(a.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="stack">
          <section className="card">
            <AssetUploadForm projectId={project.id} />
          </section>
          <section className="card">
            <AssetLinkForm projectId={project.id} />
          </section>
        </div>
      </div>
    </>
  );
}

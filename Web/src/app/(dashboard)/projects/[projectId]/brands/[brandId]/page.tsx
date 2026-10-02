import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrandEditor } from "@/components/brand/brand-editor";
import { ReviseBrandButton } from "@/components/brand/brand-forms";
import { formatDateTime } from "@/components/format";
import { listTokens } from "@/domain/brand";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Brand · SCL Web" };

export default async function BrandPage({ params }: PageProps<"/projects/[projectId]/brands/[brandId]">) {
  const { projectId, brandId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  if (!store.brands.list(projectId).some((x) => x.brand.id === brandId)) notFound();
  const { brand, versions, latest, approved } = store.brands.get(projectId, brandId);
  const assets = detail.assets.map((a) => ({ id: a.id, label: a.label, kind: a.kind }));
  // WF-02 input: what people noted about visual style in the references.
  const styleNotes = store.references
    .list(projectId)
    .flatMap((v) => v.observations.filter((o) => o.aspect === "visual_style").map((o) => ({ ref: v.reference.label || v.reference.host, ...o })));
  const counts = listTokens(latest.content).reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {});
  const api = `/api/projects/${projectId}/brands/${brand.id}`;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link> / <Link href={`/projects/${projectId}/brands`}>Brands</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>{brand.name}</h1>
          <p className="muted small">
            <code>{brand.key}</code> · version {latest.version} ({latest.status}) · {counts.confirmed ?? 0} confirmed, {counts.inferred ?? 0} inferred, {counts.default ?? 0} default, {counts.missing ?? 0} missing
          </p>
        </div>
        <div className="actions">
          <a className="button" href={`${api}/config?version=latest`} target="_blank" rel="noreferrer">
            JSON (this version)
          </a>
          <a className="button" href={`${api}/css?version=latest`} target="_blank" rel="noreferrer">
            CSS (this version)
          </a>
        </div>
      </div>

      {latest.status === "draft" ? (
        <BrandEditor key={latest.id} projectId={projectId} brandId={brand.id} brandKey={brand.key} versionId={latest.id} version={latest.version} initial={latest.content} assets={assets} />
      ) : (
        <div className="card">
          <p className="alert success" role="status">
            Version {latest.version} is approved and frozen. WF-05 to WF-08 read it from <code>{api}/config</code>.
          </p>
          <ReviseBrandButton projectId={projectId} brandId={brand.id} nextVersion={latest.version + 1} />
        </div>
      )}

      <div className="grid grid-main-side" style={{ marginTop: "1rem" }}>
        <section className="card" aria-labelledby="history-heading">
          <h2 id="history-heading">Version history</h2>
          <ol className="log small">
            {versions.map((v) => (
              <li key={v.id}>
                <strong>v{v.version}</strong> {v.status}
                {v.approvedAt && ` · approved ${formatDateTime(v.approvedAt)}`} · updated {formatDateTime(v.updatedAt)} ·{" "}
                <a href={`${api}/config?version=${v.version}`}>JSON</a> · <a href={`${api}/css?version=${v.version}`}>CSS</a> ·{" "}
                <a href={`${api}/css?version=${v.version}&scope=brand`}>scoped CSS</a>
              </li>
            ))}
          </ol>
          {approved && <p className="small">The approved handoff is version {approved.version}.</p>}
        </section>
        <section className="card" aria-labelledby="style-notes-heading">
          <h2 id="style-notes-heading">Reference notes on visual style</h2>
          <p className="small muted">From WF-02. Context for decisions; these are other sites, not this brand.</p>
          {styleNotes.length === 0 ? (
            <p className="small muted">None recorded.</p>
          ) : (
            <ul className="log small">
              {styleNotes.map((n) => (
                <li key={n.id}>
                  <span className={`badge ${n.basis === "observed" ? "ok" : "warn"}`}>{n.basis}</span> {n.text} <span className="muted">· {n.ref}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

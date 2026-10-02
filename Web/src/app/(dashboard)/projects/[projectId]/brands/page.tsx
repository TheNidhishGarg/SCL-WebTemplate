import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreateBrandForm } from "@/components/brand/brand-forms";
import { formatDateTime } from "@/components/format";
import { BRAND_CONFIG_SCHEMA } from "@/domain/brand-contract";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Brand · SCL Web" };

export default async function BrandsPage({ params }: PageProps<"/projects/[projectId]/brands">) {
  const { projectId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const brands = store.brands.list(projectId);
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Brand configuration</h1>
          <p className="muted">WF-04: design tokens and assets, exported as validated JSON (<code>{BRAND_CONFIG_SCHEMA}</code>) and CSS variables.</p>
        </div>
      </div>
      <div className="grid grid-main-side">
        <section className="card" aria-labelledby="brands-heading">
          <h2 id="brands-heading">Brands ({brands.length})</h2>
          {brands.length === 0 ? (
            <p className="muted">No brand yet. Create one: it starts from neutral defaults, all marked as undecided.</p>
          ) : (
            <ul className="log">
              {brands.map(({ brand, latest, approved, errors }) => (
                <li key={brand.id}>
                  <div className="actions" style={{ justifyContent: "space-between" }}>
                    <Link href={`/projects/${projectId}/brands/${brand.id}`} style={{ fontWeight: 600 }}>
                      {brand.name}
                    </Link>
                    <span className={`badge ${approved && latest.status !== "draft" ? "ok" : "warn"}`}>{latest.status === "draft" ? `v${latest.version} draft` : `v${latest.version} approved`}</span>
                  </div>
                  <div className="small muted">
                    <code>{brand.key}</code> · updated {formatDateTime(brand.updatedAt)}
                    {latest.status === "draft" && ` · ${errors} item(s) block approval`}
                    {approved && latest.status === "draft" && ` · v${approved.version} remains approved`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <CreateBrandForm projectId={projectId} suggestedName={brands.length ? "" : detail.project.clientName} />
        </section>
      </div>
    </>
  );
}

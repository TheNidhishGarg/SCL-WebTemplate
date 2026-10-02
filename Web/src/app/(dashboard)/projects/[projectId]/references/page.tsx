import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/components/format";
import { AddReferenceForm, ImportFromBriefButton } from "@/components/references/reference-forms";
import { ReferenceStatusBadge } from "@/components/references/reference-status";
import { SaveAllResourcesCapture } from "@/components/references/sar-capture";
import { SaveAllResourcesImportForm } from "@/components/references/sar-import-form";
import { ASPECT_LABELS, decidingAttempt, normaliseReferenceUrl, OUTCOME_LABELS, ObservationAspect, REFERENCE_USAGE_NOTICE, STATUS_LABELS, type ReferenceStatus } from "@/domain/reference";
import { REFERENCE_LIBRARY_SCHEMA } from "@/domain/reference-library";
import { getEnv } from "@/server/env";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "References · SCL Web" };

const STATUSES = Object.keys(STATUS_LABELS) as ReferenceStatus[];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function ReferencesPage({ params, searchParams }: PageProps<"/projects/[projectId]/references">) {
  const { projectId } = await params;
  const q = await searchParams;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const { project, approved } = detail;
  const all = store.references.list(project.id);
  const briefPages = approved?.content?.requiredPages ?? [];

  const filter = { status: one(q.status), page: one(q.page), aspect: one(q.aspect) };
  const shown = all.filter(
    (v) =>
      (!filter.status || v.status === filter.status) &&
      (!filter.page || v.reference.targetPages.includes(filter.page)) &&
      (!filter.aspect || v.observations.some((o) => o.aspect === filter.aspect)),
  );
  const filtered = Boolean(filter.status || filter.page || filter.aspect);
  const sites = [...new Set(shown.map((v) => v.reference.host))];

  const inLibrary = new Set(all.map((v) => v.reference.url));
  const importable = (approved?.content?.referenceUrls ?? []).filter((r) => {
    const n = normaliseReferenceUrl(r.url);
    return n && !inLibrary.has(n);
  }).length;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, all.filter((v) => v.status === s).length])) as Record<ReferenceStatus, number>;
  const libraryUrl = `/api/projects/${project.id}/references/library`;
  const env = getEnv();
  const extensionId = env.integrations.saveAllResources ? env.values.SAR_EXTENSION_ID : null;
  const captureJobs = store.sarCaptures.list(project.id).slice(0, 5);

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${project.id}`}>{project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Reference library</h1>
          <p className="muted">
            {all.length} reference{all.length === 1 ? "" : "s"} across {new Set(all.map((v) => v.reference.host)).size} site
            {new Set(all.map((v) => v.reference.host)).size === 1 ? "" : "s"}
          </p>
        </div>
        <div className="actions">
          <a className="button" href={libraryUrl} target="_blank" rel="noreferrer">
            View export for WF-03
          </a>
          <a className="button" href={`${libraryUrl}?download`}>
            Download
          </a>
        </div>
      </div>

      <p className="alert info small">{REFERENCE_USAGE_NOTICE}</p>

      <p className="small">
        To capture a website and reconstruct a template, use <Link href={`/projects/${project.id}#generate`}>Generate Website Template</Link> on the project page. The options below are alternatives.
      </p>
      <section className="card" style={{ marginBottom: "1rem" }}>
        <SaveAllResourcesCapture projectId={project.id} extensionId={extensionId} />
        {captureJobs.length > 0 && (
          <ul className="log small" aria-label="Recent extension captures">
            {captureJobs.map((j) => (
              <li key={j.id} data-status={j.status}>
                {j.url} · {j.status.replace(/_/g, " ")} · {formatDateTime(j.updatedAt)}
                {j.captureId && (
                  <>
                    {" "}
                    · <Link href={`/projects/${project.id}/references/${j.referenceId}`}>reference</Link> ·{" "}
                    <Link href={`/projects/${project.id}/sources/${j.sourceId}`}>WF-03 source</Link>
                  </>
                )}
                {j.error && <div className="muted">{j.error}</div>}
                {j.warnings.length > 0 && <div className="muted">{j.warnings.join(" ")}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {all.length > 0 && (
        <dl className="stats">
          {(["captured", "checked", "failed", "manual"] as const).map((s) => (
            <div key={s} className="card stat">
              <dt>{STATUS_LABELS[s]}</dt>
              <dd>
                <Link href={`?status=${s}`} aria-label={`Show ${counts[s]} references: ${STATUS_LABELS[s]}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {counts[s]}
                </Link>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="grid grid-main-side">
        <div className="stack">
          {all.length > 0 && (
            <section className="card" aria-labelledby="filter-heading">
              <h2 id="filter-heading" className="visually-hidden">
                Filter references
              </h2>
              <form method="get" className="filters">
                <div className="field">
                  <label htmlFor="f-status">Status</label>
                  <select id="f-status" name="status" defaultValue={filter.status}>
                    <option value="">Any</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="f-page">Client page</label>
                  <select id="f-page" name="page" defaultValue={filter.page}>
                    <option value="">Any</option>
                    {briefPages.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="f-aspect">Has observations on</label>
                  <select id="f-aspect" name="aspect" defaultValue={filter.aspect}>
                    <option value="">Any aspect</option>
                    {ObservationAspect.options.map((a) => (
                      <option key={a} value={a}>
                        {ASPECT_LABELS[a]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="actions">
                  <button type="submit" className="button">
                    Filter
                  </button>
                  {filtered && (
                    <Link className="button link" href={`/projects/${project.id}/references`}>
                      Clear
                    </Link>
                  )}
                </div>
              </form>
            </section>
          )}

          <section className="card" aria-labelledby="refs-heading">
            <h2 id="refs-heading">{filtered ? `Matching references (${shown.length})` : "References by site"}</h2>
            {all.length === 0 ? (
              <div className="empty">
                <p className="muted">
                  No references yet. Import the reference websites from the approved brief, or add pages here. Each one
                  is then checked, captured with SaveMyResources, and annotated.
                </p>
              </div>
            ) : shown.length === 0 ? (
              <p className="muted">No references match these filters.</p>
            ) : (
              sites.map((host) => (
                <div key={host} className="site">
                  <h3>{host}</h3>
                  <ul className="log">
                    {shown
                      .filter((v) => v.reference.host === host)
                      .map(({ reference: r, status, attempts, captures, observations }) => {
                        const latest = decidingAttempt(attempts, captures);
                        return (
                          <li key={r.id}>
                            <div className="actions" style={{ justifyContent: "space-between" }}>
                              <Link href={`/projects/${project.id}/references/${r.id}`} style={{ fontWeight: 600 }}>
                                {r.label || r.url}
                              </Link>
                              <ReferenceStatusBadge status={status} />
                            </div>
                            <div className="small muted">
                              {r.pageType && `${r.pageType} · `}
                              {captures.length} capture{captures.length === 1 ? "" : "s"} · {observations.length} observation
                              {observations.length === 1 ? "" : "s"}
                              {r.targetPages.length > 0 && ` · informs ${r.targetPages.map((s) => `/${s}`).join(", ")}`}
                            </div>
                            {latest && (
                              <div className="small">
                                {status === "captured" ? "Last attempt" : "Status based on"}: {OUTCOME_LABELS[latest.outcome]} · {formatDateTime(latest.createdAt)}
                                {status === "failed" && <span className="muted"> · {latest.detail}</span>}
                              </div>
                            )}
                          </li>
                        );
                      })}
                  </ul>
                </div>
              ))
            )}
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="import-heading">
            <h2 id="import-heading">From the client brief</h2>
            {approved?.content ? (
              <>
                <p className="small muted">
                  Brief version {approved.version} lists {approved.content.referenceUrls.length} reference website
                  {approved.content.referenceUrls.length === 1 ? "" : "s"}.
                </p>
                <ImportFromBriefButton projectId={project.id} count={importable} briefVersion={approved.version} />
              </>
            ) : (
              <p className="small muted">
                No approved brief yet. <Link href={`/projects/${project.id}/brief`}>Approve the brief</Link> to import its
                reference websites; you can still add references by hand.
              </p>
            )}
          </section>
          <section className="card">
            <AddReferenceForm projectId={project.id} />
          </section>
          <section className="card">
            <SaveAllResourcesImportForm projectId={project.id} />
          </section>
          <p className="small muted">
            WF-03 reads this library in the <code>{REFERENCE_LIBRARY_SCHEMA}</code> format.
          </p>
        </div>
      </div>
    </>
  );
}

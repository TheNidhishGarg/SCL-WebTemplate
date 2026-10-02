import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBytes, formatDateTime } from "@/components/format";
import {
  CaptureUploadForm,
  CheckUrlButton,
  FailedAttemptForm,
  ManualOnlyForm,
  ObservationForm,
  ObservationItem,
  ReferenceDetailsForm,
  RemoveCaptureButton,
  RemoveReferenceButton,
} from "@/components/references/reference-forms";
import { ReferenceStatusBadge } from "@/components/references/reference-status";
import { ASPECT_LABELS, CAPTURE_KIND_LABELS, decidingAttempt, isSuccessfulOutcome, OUTCOME_LABELS, REFERENCE_USAGE_NOTICE, type Observation } from "@/domain/reference";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Reference · SCL Web" };

export default async function ReferencePage({ params }: PageProps<"/projects/[projectId]/references/[referenceId]">) {
  const { projectId, referenceId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const view = store.references.list(projectId).find((v) => v.reference.id === referenceId);
  if (!view) notFound();
  const { project, approved } = detail;
  const { reference: r, status, attempts, captures, observations } = view;
  const deciding = decidingAttempt(attempts, captures);
  const captureOptions = captures.map((c) => ({ id: c.id, filename: c.file.filename }));
  const observed = observations.filter((o) => o.basis === "observed");
  const inferred = observations.filter((o) => o.basis === "inferred");
  const checkInferences = attempts.flatMap((a) => a.inferences.map((text) => ({ text, at: a.createdAt })));
  const today = new Date().toISOString().slice(0, 10);
  const captureName = (id: string | null) => captures.find((c) => c.id === id)?.file.filename;

  const observationLine = (o: Observation) => (
    <ObservationItem
      key={o.id}
      projectId={project.id}
      referenceId={r.id}
      captures={captureOptions}
      observation={{ id: o.id, aspect: o.aspect, basis: o.basis, text: o.text, captureId: o.captureId }}
    >
      <span className="badge">{ASPECT_LABELS[o.aspect]}</span> <span style={{ whiteSpace: "pre-wrap" }}>{o.text}</span>
      <div className="small muted">
        {o.captureId ? `From capture ${captureName(o.captureId)}` : "From the live page"} · {formatDateTime(o.updatedAt)}
      </div>
    </ObservationItem>
  );

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${project.id}`}>{project.name}</Link> /{" "}
        <Link href={`/projects/${project.id}/references`}>References</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>{r.label || r.host}</h1>
          <p className="muted" style={{ overflowWrap: "anywhere" }}>
            <a href={r.url} target="_blank" rel="noreferrer noopener">
              {r.url}
            </a>
            {r.origin === "brief" && ` · from brief v${r.briefVersion}`}
          </p>
        </div>
        <ReferenceStatusBadge status={status} />
      </div>

      {status === "failed" && deciding && (
        <div className="alert error" role="status">
          <strong>Acquisition failed: {OUTCOME_LABELS[deciding.outcome]}.</strong> {deciding.detail}
          <br />
          To recover: check the URL again, capture it yourself with SaveMyResources from a browser that can open it, or mark
          it for manual observation and record what you can see.
        </div>
      )}

      <div className="grid grid-main-side">
        <div className="stack">
          <section className="card" aria-labelledby="evidence-heading">
            <h2 id="evidence-heading">Acquired evidence</h2>
            <p className="small muted">Files captured from the page, and the record of every attempt. Nothing here is edited after the fact.</p>

            <h3>Captures ({captures.length})</h3>
            {captures.length === 0 ? (
              <p className="small muted">No captures yet.</p>
            ) : (
              <ul className="log">
                {captures.map((c) => (
                  <li key={c.id}>
                    <div className="actions" style={{ justifyContent: "space-between" }}>
                      <span>
                        <span className="badge">{CAPTURE_KIND_LABELS[c.kind]}</span>{" "}
                        <a href={`/api/projects/${project.id}/references/${r.id}/captures/${c.id}/file`}>{c.file.filename}</a>{" "}
                        <span className="muted small">({formatBytes(c.file.sizeBytes)})</span>
                      </span>
                      <RemoveCaptureButton projectId={project.id} referenceId={r.id} captureId={c.id} filename={c.file.filename} />
                    </div>
                    <div className="small muted">
                      {c.tool} · captured {c.capturedOn} · uploaded {formatDateTime(c.createdAt)} · sha256 {c.file.sha256.slice(0, 12)}…
                    </div>
                    {c.notes && <div className="small">{c.notes}</div>}
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ marginTop: "1.25rem" }}>Attempts ({attempts.length})</h3>
            {attempts.length === 0 ? (
              <p className="small muted">Nothing attempted yet.</p>
            ) : (
              <ol className="log" aria-label="Acquisition attempts, newest first">
                {attempts.map((a) => (
                  <li key={a.id}>
                    <span className="provenance">{a.recordedBy === "system" ? "System URL check" : "Reported by a person"}</span>
                    <div>
                      <span className={`badge ${isSuccessfulOutcome(a.outcome) ? "ok" : "danger"}`}>{OUTCOME_LABELS[a.outcome]}</span>{" "}
                      <span className="small">{a.detail}</span>
                    </div>
                    <div className="small muted">
                      {formatDateTime(a.createdAt)}
                      {a.pageTitle && ` · title "${a.pageTitle}"`}
                      {a.finalUrl && a.finalUrl !== r.url && ` · ended at ${a.finalUrl}`}
                    </div>
                    {a.redirectChain.length > 0 && (
                      <details className="small">
                        <summary>{a.redirectChain.length} redirect{a.redirectChain.length === 1 ? "" : "s"}</summary>
                        <ol>
                          {a.redirectChain.map((h, i) => (
                            <li key={i}>
                              {h.status} {h.url}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card" aria-labelledby="observed-heading">
            <h2 id="observed-heading">Observations</h2>
            <p className="small muted">What a person saw on the reference.</p>
            {observed.length === 0 ? <p className="small muted">None yet.</p> : <ul className="log">{observed.map(observationLine)}</ul>}
          </section>

          <section className="card" aria-labelledby="inferred-heading">
            <h2 id="inferred-heading">Inferences</h2>
            <p className="small muted">Interpretations, not verified. WF-03 should treat them as leads, not facts.</p>
            {inferred.length === 0 && checkInferences.length === 0 ? (
              <p className="small muted">None yet.</p>
            ) : (
              <ul className="log">
                {inferred.map(observationLine)}
                {checkInferences.map((i, n) => (
                  <li key={`check-${n}`}>
                    <span className="provenance">From a URL check</span>
                    <div>{i.text}</div>
                    <div className="small muted">{formatDateTime(i.at)}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <ObservationForm projectId={project.id} referenceId={r.id} captures={captureOptions} />
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="acquire-heading">
            <h2 id="acquire-heading">Acquire</h2>
            <p className="small muted">
              The URL check makes one ordinary request, without signing in, and records the status, redirects and page title.
              It stores none of the page.
            </p>
            <CheckUrlButton projectId={project.id} referenceId={r.id} />
            <details style={{ marginTop: "1rem" }}>
              <summary>How to capture with SaveMyResources</summary>
              <ol className="small">
                <li>Open the page in your browser. Only capture pages you can lawfully open; do not get around sign-ins or paywalls.</li>
                <li>Let it load fully and scroll to the end, so lazy-loaded resources are fetched.</li>
                <li>Use SaveMyResources to save the page&apos;s resources. It produces a .zip archive.</li>
                <li>Take a full-page screenshot as well (in Chrome DevTools: Run command, then &quot;Capture full size screenshot&quot;).</li>
                <li>Upload both below, with the date you captured them.</li>
                <li>If capturing fails, record what happened, so the failure stays visible.</li>
              </ol>
            </details>
            <hr style={{ border: 0, borderTop: "1px solid var(--color-border)", margin: "1rem 0" }} />
            <p className="small muted">{REFERENCE_USAGE_NOTICE}</p>
            <CaptureUploadForm projectId={project.id} referenceId={r.id} today={today} />
          </section>
          <section className="card">
            <FailedAttemptForm projectId={project.id} referenceId={r.id} />
          </section>
          <section className="card">
            <ManualOnlyForm projectId={project.id} referenceId={r.id} current={r.manualReason} />
          </section>
          <section className="card">
            <ReferenceDetailsForm
              projectId={project.id}
              referenceId={r.id}
              initial={{ label: r.label, pageType: r.pageType, targetPages: r.targetPages, attribution: r.attribution }}
              briefPages={approved?.content ? approved.content.requiredPages.map((p) => ({ slug: p.slug, title: p.title })) : null}
            />
          </section>
          <RemoveReferenceButton projectId={project.id} referenceId={r.id} />
        </div>
      </div>
    </>
  );
}

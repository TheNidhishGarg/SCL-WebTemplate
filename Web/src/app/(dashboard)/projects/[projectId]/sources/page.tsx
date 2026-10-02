import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBytes, formatDateTime } from "@/components/format";
import { RegisterCaptureForm, RegisterUploadForm } from "@/components/sources/source-forms";
import { AUTHORIZATION_LABELS, extractionAllowed, TEMPLATE_MANIFEST_SCHEMA } from "@/domain/wf03";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Source analysis · SCL Web" };

export default async function SourcesPage({ params }: PageProps<"/projects/[projectId]/sources">) {
  const { projectId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const { project } = detail;
  const sources = store.sources.list(project.id);
  const manifest = store.sources.manifest(project.id);
  const usedCaptures = new Set(sources.map((s) => s.source.captureId).filter(Boolean));
  const captures = store.references
    .list(project.id)
    .flatMap((v) => v.captures.filter((c) => c.kind === "archive" && !usedCaptures.has(c.id)).map((c) => ({ ref: v.reference, capture: c })));
  const base = `/api/projects/${project.id}/templates`;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${project.id}`}>{project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Source analysis</h1>
          <p className="muted">WF-03: analyse authorised source code, and extract reusable templates where permitted.</p>
        </div>
        <div className="actions">
          <a className="button" href={`${base}/manifest`} target="_blank" rel="noreferrer">
            Template manifest
          </a>
          <a className="button" href={`${base}/workspace`}>
            Download workspace
          </a>
        </div>
      </div>

      <details className="card" style={{ marginBottom: "1rem" }}>
        <summary>The process</summary>
        <ol className="small">
          <li>Register a source: an archive you are authorised to use, or a WF-02 capture. State the authority; captures of others&apos; sites stay study only.</li>
          <li>Run the analysis. It is deterministic, and its digest proves a re-run saw the same thing.</li>
          <li>Download the analysis kit and open it in VS Code. Claude Code follows its CLAUDE.md to add findings, separating facts (cited) from assumptions.</li>
          <li>Import findings.json. Every cited file and line is checked against the source; invented citations reject the file.</li>
          <li>Add template candidates to the manifest; extract them into the workspace if the source allows it.</li>
          <li>Build extracted code in VS Code and record the result. Answer the open questions.</li>
          <li>WF-04 and WF-05 read the template manifest.</li>
        </ol>
      </details>

      <div className="grid grid-main-side">
        <div className="stack">
          <section className="card" aria-labelledby="sources-heading">
            <h2 id="sources-heading">Sources ({sources.length})</h2>
            {sources.length === 0 ? (
              <div className="empty">
                <p className="muted">No sources yet. Register an archive, or use a SaveMyResources capture from the reference library.</p>
              </div>
            ) : (
              <ul className="log">
                {sources.map(({ source: s, latestScan, templates, extracted, openQuestions, highRisks }) => (
                  <li key={s.id}>
                    <div className="actions" style={{ justifyContent: "space-between" }}>
                      <Link href={`/projects/${project.id}/sources/${s.id}`} style={{ fontWeight: 600 }}>
                        {s.label}
                      </Link>
                      <span className={`badge ${extractionAllowed(s.authorization.basis) ? "ok" : "warn"}`}>{AUTHORIZATION_LABELS[s.authorization.basis]}</span>
                    </div>
                    <div className="small muted">
                      {s.origin === "reference_capture" ? "WF-02 capture" : "Uploaded archive"} · {s.archive.filename} ({formatBytes(s.archive.sizeBytes)})
                    </div>
                    <div className="small">
                      {latestScan ? `Analysed ${formatDateTime(latestScan.createdAt)}` : "Not analysed yet"} · {templates} template{templates === 1 ? "" : "s"}
                      {extracted ? ` (${extracted} extracted)` : ""} · {openQuestions} open question{openQuestions === 1 ? "" : "s"}
                      {highRisks > 0 && <span className="badge danger" style={{ marginLeft: "0.5rem" }}>{highRisks} high risk{highRisks === 1 ? "" : "s"}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="manifest-heading">
            <h2 id="manifest-heading">Template manifest</h2>
            <p className="small muted">
              {manifest.templates.length} template{manifest.templates.length === 1 ? "" : "s"}, {manifest.templates.filter((t) => t.extraction.status === "extracted").length} extracted,{" "}
              {manifest.openQuestions.length} open question{manifest.openQuestions.length === 1 ? "" : "s"}. WF-04 and WF-05 read it as <code>{TEMPLATE_MANIFEST_SCHEMA}</code>.
            </p>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <RegisterUploadForm projectId={project.id} />
          </section>
          <section className="card" aria-labelledby="captures-heading">
            <h2 id="captures-heading">From the reference library</h2>
            {captures.length === 0 ? (
              <p className="small muted">No unused resource archives. Capture references with SaveMyResources in WF-02 first.</p>
            ) : (
              <ul className="log">
                {captures.map(({ ref, capture }) => (
                  <li key={capture.id}>
                    <div className="small">
                      <strong>{ref.label || ref.host}</strong> · {capture.file.filename}
                    </div>
                    <RegisterCaptureForm projectId={project.id} referenceId={ref.id} captureId={capture.id} defaultLabel={`${ref.label || ref.host} (capture ${capture.capturedOn})`} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

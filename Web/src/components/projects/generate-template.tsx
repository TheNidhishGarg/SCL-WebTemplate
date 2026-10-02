"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { cancelTemplateAction, retryTemplateAction, startTemplateAction, templateJobAction } from "@/app/(dashboard)/projects/template-actions";
import { MAX_CAPTURE_LABEL } from "@/domain/reference";
import type { PublicTemplateJob } from "@/server/pipeline/public-job";

// The project's primary action: URL -> SaveAllResources -> website-template.zip
// -> WF-02 -> WF-03 -> WF-04/WF-05 (under their gates), all in the background.
// The panel shows exactly what the server recorded; no invented progress.

const ACTIVE = ["queued", "running"];
const STAGE_LABELS: Record<string, string> = {
  sar: "SaveAllResources capture and reconstruction",
  artifact: "website-template.zip stored in Web",
  wf02: "WF-02 reference and capture",
  wf03: "WF-03 source and analysis",
  wf04: "WF-04 brand",
  wf05: "WF-05 page drafts",
};
const ICON: Record<string, string> = { done: "✓", running: "⏳", waiting: "⏸", blocked: "⛔", failed: "✕", cancelled: "⊘", pending: "○" };
const RUN_STAGES: Record<string, string> = { starting: "Starting SaveAllResources", capturing: "Capturing pages", packaging: "Packaging the capture", templatising: "Reconstructing the website template", verifying: "Verifying the template", finishing: "Writing the ZIP", cancelling: "Cancelling…" };
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

export function GenerateTemplate({ projectId, availability, initial }: { projectId: string; availability: { ok: true } | { ok: false; reason: string }; initial: PublicTemplateJob[] }) {
  const router = useRouter();
  const [v, setV] = useState({ url: "", authority: "study_only", authorizedBy: "", maxPages: "", maxDepth: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [jobs, setJobs] = useState(initial);
  const current = jobs[0] ?? null;
  const running = current && ACTIVE.includes(current.status);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(async () => {
      const r = await templateJobAction(projectId, current.id);
      if (!r.ok) return;
      setJobs((js) => [r.data, ...js.slice(1)]);
      if (!ACTIVE.includes(r.data.status)) router.refresh();
    }, 1500);
    return () => window.clearInterval(t);
  }, [running, current?.id, projectId, router]);

  return (
    <div>
      <form
        noValidate
        aria-labelledby="generate-heading"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const r = await startTemplateAction(projectId, v);
            if (!r.ok) return setError(r.message);
            setJobs((js) => [r.data, ...js]);
            router.refresh();
          });
        }}
      >
        <h2 id="generate-heading">Generate Website Template</h2>
        <p className="small muted">
          Enter a website URL. SaveAllResources captures and reconstructs it in the background, Web stores the website-template.zip, registers it in WF-02 and analyses it in WF-03. WF-04 and WF-05 continue as soon as their approvals allow.
        </p>
        <p className="small muted">Maximum website template size: {MAX_CAPTURE_LABEL}</p>
        {!availability.ok && (
          <p className="alert info small" role="status">
            Template generation is not available on this server: {availability.reason} You can still capture with the browser extension or import an existing ZIP on the <Link href={`/projects/${projectId}/references`}>References</Link> page.
          </p>
        )}
        {error && (
          <p className="alert error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label htmlFor="gen-url" className="required">
            Website URL
          </label>
          <input id="gen-url" type="url" inputMode="url" placeholder="https://www.example.com/" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} />
        </div>
        <fieldset className="field">
          <legend>Source authority</legend>
          <label className="small" style={{ display: "block" }}>
            <input type="radio" name="authority" value="study_only" checked={v.authority === "study_only"} onChange={() => setV({ ...v, authority: "study_only" })} /> Study / reference (default): analysed, never reused
          </label>
          <label className="small" style={{ display: "block" }}>
            <input type="radio" name="authority" value="client_owned" checked={v.authority === "client_owned"} onChange={() => setV({ ...v, authority: "client_owned" })} /> Client-owned: the client&apos;s own site, with their authorisation
          </label>
        </fieldset>
        {v.authority === "client_owned" && (
          <div className="field">
            <label htmlFor="gen-auth" className="required">
              Authorised by
            </label>
            <span className="hint">Who authorised this, and how (e.g. &ldquo;Jane Doe, client CTO, email 1 Oct 2026&rdquo;). Recorded on the WF-03 source.</span>
            <input id="gen-auth" type="text" value={v.authorizedBy} onChange={(e) => setV({ ...v, authorizedBy: e.target.value })} />
          </div>
        )}
        <details>
          <summary className="small">Capture settings</summary>
          <div className="field">
            <label htmlFor="gen-pages">Max pages</label>
            <input id="gen-pages" type="number" min={1} max={100} placeholder="server default" value={v.maxPages} onChange={(e) => setV({ ...v, maxPages: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="gen-depth">Max link depth</label>
            <input id="gen-depth" type="number" min={0} max={10} placeholder="server default" value={v.maxDepth} onChange={(e) => setV({ ...v, maxDepth: e.target.value })} />
          </div>
        </details>
        <button type="submit" className="button primary" disabled={!availability.ok || pending || !!running || !v.url.trim()}>
          {pending ? "Starting…" : "Generate Website Template"}
        </button>
        {running && <p className="small muted">One generation runs at a time.</p>}
      </form>
      {current && <PipelinePanel projectId={projectId} job={current} onChange={(j) => setJobs((js) => [j, ...js.slice(1)])} />}
      {jobs.length > 1 && (
        <details>
          <summary className="small">Earlier generations ({jobs.length - 1})</summary>
          <ul className="log small">
            {jobs.slice(1).map((j) => (
              <li key={j.id}>
                {j.sourceUrl} · {j.status} · {new Date(j.createdAt).toLocaleString()}
                {j.artifact && (
                  <>
                    {" "}
                    · <a href={`/api/projects/${projectId}/template-jobs/${j.id}/artifact`}>ZIP</a> · <Link href={`/projects/${projectId}/templates/${j.id}`}>preview</Link>
                  </>
                )}
                {j.sourceId && (
                  <>
                    {" "}
                    · <Link href={`/projects/${projectId}/sources/${j.sourceId}`}>source</Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PipelinePanel({ projectId, job, onChange }: { projectId: string; job: PublicTemplateJob; onChange: (j: PublicTemplateJob) => void }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: true; data: PublicTemplateJob } | { ok: false; message: string }>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) {
        onChange(r.data);
        router.refresh();
      } else setError(r.message);
    });
  const link = (key: string) => {
    if (key === "wf02" && job.referenceId) return <Link href={`/projects/${projectId}/references/${job.referenceId}`}>reference</Link>;
    if (key === "wf03" && job.sourceId) return <Link href={`/projects/${projectId}/sources/${job.sourceId}`}>source and analysis</Link>;
    if (key === "wf04" && job.brandId) return <Link href={`/projects/${projectId}/brands/${job.brandId}`}>brand draft</Link>;
    if (key === "wf04" && job.stages.wf04.status === "waiting" && job.sourceId) return <Link href={`/projects/${projectId}/sources/${job.sourceId}`}>set the source&apos;s authority</Link>;
    if (key === "wf05" && job.pagesGenerated) return <Link href={`/projects/${projectId}/pages`}>page drafts</Link>;
    if (key === "wf05" && job.stages.wf05.status === "waiting") return <Link href={`/projects/${projectId}/brief`}>review and approve the brief</Link>;
    return null;
  };
  const failedRegistration = job.artifact && ["wf02", "wf03", "wf04", "wf05"].some((k) => job.stages[k as keyof typeof job.stages].status === "failed");
  return (
    <section className="card" aria-labelledby="pipeline-heading" style={{ marginTop: "1rem" }} data-testid="template-pipeline" data-status={job.status}>
      <h3 id="pipeline-heading" style={{ marginTop: 0 }}>
        Website Template Pipeline <span className="small muted">· {job.sourceUrl}</span>
      </h3>
      <p className="small" role="status" data-testid="pipeline-status">
        Status: <strong>{job.status}</strong>
        {ACTIVE.includes(job.status) && <> · {RUN_STAGES[job.cancelRequested ? "cancelling" : job.stage] ?? job.stage}</>}
        {job.progress && ACTIVE.includes(job.status) && (
          <>
            {" "}
            · {job.progress.captured} captured of {job.progress.discovered} discovered pages, {job.progress.failed} failed, {job.progress.pending} pending
          </>
        )}
      </p>
      {error && (
        <p className="alert error small" role="alert">
          {error}
        </p>
      )}
      <ol className="checklist small" aria-label="Pipeline stages" style={{ listStyle: "none", paddingLeft: 0 }}>
        {(Object.keys(STAGE_LABELS) as (keyof typeof job.stages)[]).map((k) => {
          const s = job.stages[k];
          const l = link(k);
          return (
            <li key={k} data-stage={k} data-stage-status={s.status}>
              <span>
                <span aria-hidden="true">{ICON[s.status]}</span> {STAGE_LABELS[k]} <span className="visually-hidden">({s.status})</span>
                {s.detail && s.status !== "running" && <span className="muted"> · {s.detail}</span>}
                {s.error && <div className="field-error">{s.error}</div>}
                {k === "artifact" && job.artifact && (
                  <div className="muted">
                    {mb(job.artifact.bytes)} ({job.artifact.bytes} bytes) · SHA-256 <code data-testid="artifact-sha">{job.artifact.sha256}</code> ·{" "}
                    <a href={`/api/projects/${projectId}/template-jobs/${job.id}/artifact`}>Download website-template.zip</a> ·{" "}
                    <Link href={`/projects/${projectId}/templates/${job.id}`}>Preview and edit template</Link>
                  </div>
                )}
                {l && <> · {l}</>}
              </span>
              <span className={`badge ${s.status === "done" ? "ok" : s.status === "failed" || s.status === "blocked" ? "danger" : s.status === "pending" ? "" : "warn"}`}>{s.status}</span>
            </li>
          );
        })}
      </ol>
      <div className="actions">
        {ACTIVE.includes(job.status) && !job.cancelRequested && (
          <button type="button" className="button danger" disabled={busy} onClick={() => act(() => cancelTemplateAction(projectId, job.id))}>
            Cancel generation
          </button>
        )}
        {failedRegistration && (
          <button type="button" className="button" disabled={busy} onClick={() => act(() => retryTemplateAction(projectId, job.id))}>
            Retry registration
          </button>
        )}
      </div>
    </section>
  );
}

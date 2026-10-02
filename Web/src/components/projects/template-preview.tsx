"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { previewStatusAction, resetTemplateAction, restartPreviewAction, saveTemplateBrandAction, saveTemplatePageAction, startPreviewAction, stopPreviewAction } from "@/app/(dashboard)/projects/preview-actions";
import type { PreviewMode, PreviewStatus } from "@/server/preview/preview-manager";
import type { Editable, WorkspaceInfo } from "@/server/preview/workspace";
import type { StructureView } from "@/server/templates";
import { TemplateStructure } from "./template-structure";

// Live preview of a generated template, with its brand and content editors.
// The preview runs in a separate process on its own origin (127.0.0.1:<port>)
// and is shown in a sandboxed iframe: scripts may run, but it gets an opaque
// origin (no cookies, no access to the dashboard), cannot submit forms and
// cannot navigate the dashboard. Saving an edit triggers the template's own
// build; the frame reloads when the new build is ready.

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const isLocalViewer = () => typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);

export function TemplatePreview({
  projectId,
  jobId,
  mode,
  availability,
  workspace,
  editable,
  canEdit,
  editReason,
  initialStatus,
  structure,
}: {
  projectId: string;
  jobId: string;
  mode: PreviewMode;
  availability: { ok: true } | { ok: false; reason: string };
  workspace: WorkspaceInfo;
  editable: Editable | null;
  canEdit: boolean;
  editReason: string | null;
  initialStatus: PreviewStatus;
  structure: StructureView | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [route, setRoute] = useState(workspace.routes[0]?.route ?? "index.html");
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [frameKey, setFrameKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const lastBuild = useRef(initialStatus.buildId);
  const [local, setLocal] = useState(true);
  useEffect(() => setLocal(isLocalViewer()), []); // eslint-disable-line react-hooks/set-state-in-effect -- browser-only fact

  // Follow the preview while it runs; reload the frame after each new build.
  useEffect(() => {
    if (status.state === "stopped") return;
    const t = window.setInterval(async () => {
      const r = await previewStatusAction(projectId, jobId);
      if (!r.ok) return;
      setStatus(r.data);
      if (r.data.buildId !== lastBuild.current) {
        lastBuild.current = r.data.buildId;
        setFrameKey((k) => k + 1);
      }
    }, 1200);
    return () => window.clearInterval(t);
  }, [status.state, projectId, jobId]);

  const act = (fn: () => Promise<Result<PreviewStatus>>) =>
    startTransition(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) {
        setStatus(r.data);
        lastBuild.current = r.data.buildId;
        setFrameKey((k) => k + 1);
      } else setError(r.message);
    });

  const canRun = availability.ok && workspace.verification.ok && local;
  const src = status.url ? `${status.url}/${route === "index.html" ? "" : route}` : null;
  const stateText: Record<string, string> = { stopped: "Stopped", starting: "Starting…", building: "Building…", ready: "Ready", error: "Build failed" };

  return (
    <div className="stack">
      <section className="card" aria-labelledby="preview-heading">
        <h2 id="preview-heading">Live preview</h2>
        <p className="small muted">
          {mode === "local"
            ? "Local development preview: it runs on the computer running Web and is shown to a browser on that same computer."
            : mode === "remote"
              ? "Remote preview."
              : "Previews are off on this server."}
        </p>
        {!availability.ok && <p className="alert info small">{availability.reason}</p>}
        {availability.ok && !workspace.verification.ok && (
          <p className="alert error small" role="alert">
            {workspace.verification.reason}
          </p>
        )}
        {availability.ok && mode === "local" && !local && (
          <p className="alert info small" role="status">
            Local previews run on the computer running Web, and &ldquo;localhost&rdquo; always means the computer running your browser. Open the dashboard on that computer to see the preview.
          </p>
        )}
        {workspace.skipped.length > 0 && <p className="small muted">{workspace.skipped.length} file(s) were too large or unsafe to extract and are missing from the preview.</p>}
        {error && (
          <p className="alert error small" role="alert">
            {error}
          </p>
        )}
        <p className="small" role="status" data-testid="preview-state" data-state={status.state} data-build={status.buildId}>
          Preview: <strong>{stateText[status.state]}</strong>
          {status.builtAt && status.state === "ready" && <> · built {new Date(status.builtAt).toLocaleTimeString()}</>}
        </p>
        {status.state === "error" && status.error && <pre className="alert error small" style={{ whiteSpace: "pre-wrap" }}>{status.error}</pre>}
        {status.state !== "stopped" && (status.missingAssets.length > 0 || status.notFound.length > 0) && (
          <details className="alert error small" data-testid="missing-assets" data-count={status.missingAssets.length + status.notFound.length} open>
            <summary>
              Missing assets: {status.missingAssets.length} referenced by this build{status.notFound.length > 0 && `, ${status.notFound.length} requested by the page`}
            </summary>
            <ul>
              {status.missingAssets.slice(0, 50).map((m) => (
                <li key={`${m.from}|${m.ref}`}>
                  <code>{m.ref}</code> in {m.from}
                </li>
              ))}
              {status.notFound.map((n) => (
                <li key={n}>
                  <code>{n}</code> (requested, not found)
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="actions">
          {status.state === "stopped" ? (
            <button type="button" className="button primary" disabled={!canRun || busy} onClick={() => act(() => startPreviewAction(projectId, jobId))}>
              {busy ? "Starting…" : "Start preview"}
            </button>
          ) : (
            <>
              <button type="button" className="button" disabled={busy} onClick={() => act(() => restartPreviewAction(projectId, jobId))}>
                Restart
              </button>
              <button type="button" className="button danger" disabled={busy} onClick={() => act(() => stopPreviewAction(projectId, jobId))}>
                Stop
              </button>
            </>
          )}
        </div>
        <div className="actions" style={{ marginTop: "0.75rem", alignItems: "end" }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="preview-route">Page</label>
            <select id="preview-route" value={route} onChange={(e) => setRoute(e.target.value)}>
              {workspace.routes.map((r) => (
                <option key={r.route} value={r.route}>
                  /{r.route === "index.html" ? "" : r.route.replace(/index\.html$/, "")} — {r.title}
                </option>
              ))}
            </select>
          </div>
          <div role="group" aria-label="Viewport" className="actions">
            <button type="button" className="button" aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>
              Desktop
            </button>
            <button type="button" className="button" aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>
              Mobile
            </button>
          </div>
          <button type="button" className="button" disabled={!src} onClick={() => setFrameKey((k) => k + 1)}>
            Refresh
          </button>
          {src && (
            <a className="button" href={src} target="_blank" rel="noopener noreferrer">
              Open preview in new tab
            </a>
          )}
        </div>
        {src && local ? (
          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "center", background: "#0001", padding: viewport === "mobile" ? "1rem 0" : 0 }}>
            <iframe
              key={frameKey}
              title="Template preview"
              src={src}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              data-viewport={viewport}
              style={{ width: viewport === "mobile" ? 390 : "100%", height: viewport === "mobile" ? 844 : 760, border: "1px solid #8884", background: "#fff" }}
            />
          </div>
        ) : (
          <p className="small muted">{status.state === "stopped" ? "Start the preview to see the template." : null}</p>
        )}
      </section>

      {structure && <TemplateStructure projectId={projectId} jobId={jobId} pageId={workspace.routes.find((r) => r.route === route)?.pageId} view={structure} canEdit={canEdit} />}

      {editable && (canEdit ? <Editors projectId={projectId} jobId={jobId} editable={editable} pageId={workspace.routes.find((r) => r.route === route)?.pageId} onReset={() => act(async () => ({ ok: true, data: status }))} /> : <p className="alert info small">{editReason}</p>)}
    </div>
  );
}

function Editors({ projectId, jobId, editable, pageId, onReset }: { projectId: string; jobId: string; editable: Editable; pageId?: string; onReset: () => void }) {
  const [brand, setBrand] = useState({ name: editable.brand.name, colors: Object.fromEntries(editable.colors.map((c) => [c.key, c.value])), fonts: Object.fromEntries(editable.fonts.map((f) => [f.key, f.family])) });
  // Only what was typed is kept here, over the latest values from the server:
  // a structure change (a new or split section) brings new fields without a reload.
  const [edits, setEdits] = useState<Record<string, { title?: string; description?: string; fields: Record<string, string> }>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, startTransition] = useTransition();
  const page = editable.pages.find((p) => p.pageId === pageId) ?? editable.pages[0];
  const mine = page ? (edits[page.pageId] ?? { fields: {} }) : { fields: {} };
  const current = page && {
    title: mine.title ?? page.title,
    description: mine.description ?? page.description,
    fields: { ...Object.fromEntries(page.sections.flatMap((s) => s.fields.map((f) => [`${s.id}.${f.path}`, f.value]))), ...mine.fields },
  };
  const edit = (patch: { title?: string; description?: string; fields?: Record<string, string> }) => page && setEdits({ ...edits, [page.pageId]: { ...mine, ...patch, fields: { ...mine.fields, ...patch.fields } } });
  const save = (fn: () => Promise<Result<unknown>>, ok: string) =>
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? { ok: true, text: ok } : { ok: false, text: r.message });
    });

  return (
    <>
      {message && (
        <p className={`alert small ${message.ok ? "success" : "error"}`} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <form
        className="card"
        aria-labelledby="brand-edit-heading"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save(() => saveTemplateBrandAction(projectId, jobId, brand), "Brand saved. The preview rebuilds now.");
        }}
      >
        <h2 id="brand-edit-heading">Brand</h2>
        <div className="field">
          <label htmlFor="brand-name">Brand name</label>
          <input id="brand-name" type="text" value={brand.name} onChange={(e) => setBrand({ ...brand, name: e.target.value })} />
        </div>
        {editable.colors.map((c) => (
          <div className="field" key={c.key}>
            <label htmlFor={`color-${c.key}`}>Colour {c.key}</label>
            <div className="actions">
              <input id={`color-${c.key}`} type="text" value={brand.colors[c.key]} onChange={(e) => setBrand({ ...brand, colors: { ...brand.colors, [c.key]: e.target.value } })} style={{ maxWidth: "10rem" }} />
              <input type="color" aria-label={`Pick colour ${c.key}`} value={/^#[0-9a-f]{6}$/i.test(brand.colors[c.key]) ? brand.colors[c.key] : "#000000"} onChange={(e) => setBrand({ ...brand, colors: { ...brand.colors, [c.key]: e.target.value } })} />
            </div>
          </div>
        ))}
        {editable.fonts.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`font-${f.key}`}>Font {f.key}</label>
            <input id={`font-${f.key}`} type="text" value={brand.fonts[f.key]} onChange={(e) => setBrand({ ...brand, fonts: { ...brand.fonts, [f.key]: e.target.value } })} />
          </div>
        ))}
        <button type="submit" className="button primary" disabled={busy}>
          Save brand
        </button>
      </form>

      {page && current && (
        <form
          className="card"
          aria-labelledby="content-edit-heading"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            save(() => saveTemplatePageAction(projectId, jobId, page.pageId, current), "Page saved. The preview rebuilds now.");
          }}
        >
          <h2 id="content-edit-heading">Content: /{page.route === "index.html" ? "" : page.route.replace(/index\.html$/, "")}</h2>
          <p className="small muted">The page selected above. Text and links only; images and structure stay as captured.</p>
          <div className="field">
            <label htmlFor="page-title">Page title</label>
            <input id="page-title" type="text" value={current.title} onChange={(e) => edit({ title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="page-description">Page description</label>
            <input id="page-description" type="text" value={current.description} onChange={(e) => edit({ description: e.target.value })} />
          </div>
          {page.sections.map((s) => (
            <fieldset key={s.id} className="field">
              <legend>Section {s.id}</legend>
              {s.fields.length === 0 && <p className="small muted">No editable text.</p>}
              {s.fields.map((f) => {
                const key = `${s.id}.${f.path}`;
                const id = `field-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                return (
                  <div className="field" key={key}>
                    <label htmlFor={id}>
                      {s.id} · {f.path}
                    </label>
                    <input id={id} type="text" value={current.fields[key] ?? ""} onChange={(e) => edit({ fields: { [key]: e.target.value } })} />
                  </div>
                );
              })}
            </fieldset>
          ))}
          <button type="submit" className="button primary" disabled={busy}>
            Save page
          </button>
        </form>
      )}

      <div className="card">
        <p className="small muted">Edits change this working copy only. The stored website-template.zip stays exactly as SaveAllResources produced it.</p>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={() =>
            window.confirm("Discard all edits and go back to the generated template?") &&
            save(async () => {
              const r = await resetTemplateAction(projectId, jobId);
              if (r.ok) window.location.reload();
              onReset();
              return r;
            }, "Reset to the generated template.")
          }
        >
          Reset to generated template
        </button>
      </div>
    </>
  );
}

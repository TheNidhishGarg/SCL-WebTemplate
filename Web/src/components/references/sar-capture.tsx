"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { abandonCaptureAction, cancelCaptureAction, captureStatusAction, startCaptureAction } from "@/app/(dashboard)/projects/capture-actions";

// Alternative path: asks the SaveAllResources extension in this browser to
// capture a URL and send it to Web. Web's own client for the extension's
// documented messaging protocol (v1: ping, startCapture, cancel), written
// for Web. The server is the source of truth for the job's state.

type ChromeRuntime = { sendMessage: (id: string, msg: unknown, cb: (res: unknown) => void) => void; lastError?: { message?: string } };
type Reply = { ok: boolean; error?: { code: string; message: string }; [k: string]: unknown };
type Job = Awaited<ReturnType<typeof captureStatusAction>> extends infer R ? (R extends { ok: true; data: infer D } ? D : never) : never;

const TERMINAL = ["completed", "completed_with_warnings", "failed", "cancelled"];

function send(extensionId: string, message: Record<string, unknown>, timeoutMs = 10_000): Promise<Reply> {
  const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  if (!runtime?.sendMessage) {
    return Promise.resolve({ ok: false, error: { code: "EXTENSION_UNAVAILABLE", message: "This browser cannot reach the extension (not Chrome, or the extension does not allow this site)." } });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { code: "TIMEOUT", message: "The extension did not answer." } }), timeoutMs);
    try {
      runtime.sendMessage(extensionId, { v: 1, ...message }, (res) => {
        clearTimeout(timer);
        const err = runtime.lastError;
        if (err || res === undefined) resolve({ ok: false, error: { code: "EXTENSION_UNAVAILABLE", message: err?.message ?? "No response from the extension." } });
        else resolve(res as Reply);
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: { code: "EXTENSION_UNAVAILABLE", message: (e as Error).message } });
    }
  });
}

export function SaveAllResourcesCapture({ projectId, extensionId }: { projectId: string; extensionId: string | null }) {
  const router = useRouter();
  const [ext, setExt] = useState<{ state: "checking" | "available" | "unavailable"; detail?: string }>({ state: extensionId ? "checking" : "unavailable" });
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => {
    if (!extensionId) return;
    let live = true;
    void send(extensionId, { type: "ping" }, 3000).then((r) => {
      if (!live) return;
      setExt(r.ok ? { state: "available", detail: typeof r.version === "string" ? r.version : undefined } : { state: "unavailable", detail: r.error?.message });
    });
    return () => {
      live = false;
    };
  }, [extensionId]);

  const watch = useCallback(
    (jobId: string) => {
      if (poll.current) window.clearInterval(poll.current);
      poll.current = window.setInterval(async () => {
        const r = await captureStatusAction(projectId, jobId);
        if (!r.ok) return;
        setJob(r.data);
        if (TERMINAL.includes(r.data.status)) {
          window.clearInterval(poll.current!);
          poll.current = null;
          router.refresh();
        }
      }, 1500);
    },
    [projectId, router],
  );
  useEffect(() => () => void (poll.current && window.clearInterval(poll.current)), []);

  const start = async () => {
    if (!extensionId) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const created = await startCaptureAction(projectId, { url, maxPages });
      if (!created.ok) return setError(created.message);
      const reply = await send(extensionId, created.data.message);
      if (!reply.ok) {
        // The extension never started: end the job so nothing waits for it.
        await abandonCaptureAction(projectId, created.data.jobId, `${reply.error?.code}: ${reply.error?.message}`);
        return setError(`The extension did not start the capture: ${reply.error?.message ?? reply.error?.code}`);
      }
      const s = await captureStatusAction(projectId, created.data.jobId);
      if (s.ok) setJob(s.data);
      watch(created.data.jobId);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job || !extensionId) return;
    await cancelCaptureAction(projectId, job.id);
    await send(extensionId, { type: "cancel", jobId: job.id });
    const s = await captureStatusAction(projectId, job.id);
    if (s.ok) setJob(s.data);
  };

  const running = job && !TERMINAL.includes(job.status);
  return (
    <form
      noValidate
      aria-labelledby="capture-heading"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h2 id="capture-heading">Alternative: capture with the browser extension</h2>
      <p className="small muted">
        For pages only your own browser can open. The SaveAllResources extension in <strong>your</strong> Chrome captures the pages and sends them here, as a WF-02 capture and a study-only WF-03 source. It does not reconstruct a website template; for that, use <strong>Generate Website Template</strong> on the <Link href={`/projects/${projectId}#generate`}>project page</Link>.
      </p>
      {ext.state === "checking" && <p className="small muted" role="status">Looking for the SaveAllResources extension…</p>}
      {ext.state === "available" && (
        <p className="alert success small" role="status">
          SaveAllResources extension found{ext.detail ? ` (${ext.detail})` : ""}.
        </p>
      )}
      {ext.state === "unavailable" && (
        <div className="alert info small" role="status">
          {extensionId ? (
            <>
              The SaveAllResources extension is not available in this browser{ext.detail ? ` (${ext.detail})` : ""}. Install the automation build configured for this site, then reload.
            </>
          ) : (
            <>Capturing from Web is not configured on this server.</>
          )}{" "}
          Meanwhile you can <Link href={`/projects/${projectId}/references#sar-heading`}>import a SaveAllResources export ZIP</Link> instead.
        </div>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="capture-url" className="required">
          Website URL
        </label>
        <input id="capture-url" type="url" inputMode="url" placeholder="https://www.example.com/" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!running} />
      </div>
      <div className="field">
        <label htmlFor="capture-pages">Pages to capture (at most)</label>
        <input id="capture-pages" type="number" min={1} max={25} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} disabled={!!running} />
        <span className="hint">Only capture sites you may open. Sign-ins, paywalls and bot checks are not bypassed.</span>
      </div>
      <div className="actions">
        <button type="submit" className="button primary" disabled={ext.state !== "available" || busy || !!running || !url.trim()}>
          {busy ? "Starting…" : "Capture with the extension"}
        </button>
        {running && (
          <button type="button" className="button danger" onClick={() => void cancel()}>
            Cancel capture
          </button>
        )}
      </div>
      {job && (
        <div className={`alert small ${job.status === "failed" ? "error" : job.status.startsWith("completed") ? "success" : "info"}`} role={job.status === "failed" ? "alert" : "status"} data-testid="capture-status" data-status={job.status}>
          {job.status === "awaiting_extension" && <>Waiting for the extension to start…</>}
          {job.status === "capturing" && (
            <>
              Capturing {job.url}: {job.progress ? `${job.progress.captured} of ${job.progress.discovered} discovered pages captured` : "starting"}, {job.pagesReceived} page package(s) received.
            </>
          )}
          {job.status.startsWith("completed") && (
            <>
              Captured and registered. <Link href={`/projects/${projectId}/references/${job.referenceId}`}>View the reference</Link> ·{" "}
              <Link href={`/projects/${projectId}/sources/${job.sourceId}`}>Open the WF-03 source to run the analysis</Link>
              {job.warnings.length > 0 && (
                <ul>
                  {job.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {(job.status === "failed" || job.status === "cancelled") && <>{job.error}</>}
        </div>
      )}
    </form>
  );
}

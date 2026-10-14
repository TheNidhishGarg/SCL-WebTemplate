"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";

type Done =
  | { kind: "export"; referenceId: string; sourceId: string; entryUrl: string; jobId: string; createdReference: boolean }
  | { kind: "download"; templateJobId: string; entryUrl: string; host: string };

// SaveAllResources export → WF-02 capture + WF-03 source (study only), in one step.
// A plain Save All Resources download (Chrome Web Store build) is templatised by
// the website-template pipeline first, then registered the same way.
export function SaveAllResourcesImportForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<{ ok: true; done: Done } | { ok: false; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby="sar-heading"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const file = data.get("file");
        if (!(file instanceof File) || !file.name) return setResult({ ok: false, message: "Choose the Save All Resources ZIP." });
        if (file.size > MAX_CAPTURE_BYTES) return setResult({ ok: false, message: `Captures are limited to ${MAX_CAPTURE_BYTES / 1024 / 1024} MB.` });
        startTransition(async () => {
          setResult(null);
          try {
            const res = await fetch(`/api/projects/${projectId}/references/import/save-all-resources`, { method: "POST", body: data });
            const body = await res.json().catch(() => ({}));
            if (res.status === 201 || res.status === 202) {
              formRef.current?.reset();
              setResult({ ok: true, done: body as Done });
              router.refresh();
            } else setResult({ ok: false, message: body.error ?? `Import failed (HTTP ${res.status}).` });
          } catch {
            setResult({ ok: false, message: "Import failed: the server could not be reached. Nothing was saved." });
          }
        });
      }}
    >
      <h2 id="sar-heading">Import a Save All Resources ZIP</h2>
      <p className="small muted">
        Accepts either a ZIP downloaded with the <strong>Save All Resources</strong> extension from the Chrome Web Store (DevTools → Save All Resources), or a website-template.zip made by SaveAllResources. A download is
        turned into a website template first, then registered like a generated one; follow it in the <strong>Website Template Pipeline</strong> on the project page. Either way it is registered for WF-03 as <strong>study only</strong> unless you
        declare it client-owned in WF-03.
      </p>
      {result?.ok === false && (
        <p className="alert error" role="alert">
          {result.message}
        </p>
      )}
      {result?.ok && result.done.kind === "export" && (
        <p className="alert success" role="status">
          Imported job {result.done.jobId} ({result.done.entryUrl}){result.done.createdReference ? " as a new reference" : ""}.{" "}
          <Link href={`/projects/${projectId}/sources/${result.done.sourceId}`}>Open the source to run the analysis</Link>.
        </p>
      )}
      {result?.ok && result.done.kind === "download" && (
        <p className="alert success" role="status">
          Templatising the download of {result.done.entryUrl}. <Link href={`/projects/${projectId}`}>Follow it in the Website Template Pipeline</Link>; when it finishes, the template can be previewed and the reference, capture and source are
          registered.
        </p>
      )}
      <div className="field">
        <label htmlFor="sar-file" className="required">
          ZIP file
        </label>
        <span className="hint" id="sar-file-hint">
          Maximum size: {MAX_CAPTURE_BYTES / 1024 / 1024} MB.
        </span>
        <input id="sar-file" name="file" type="file" accept=".zip" aria-describedby="sar-file-hint" />
      </div>
      <div className="field">
        <label htmlFor="sar-entry-url">Page address (downloads only, optional)</label>
        <span className="hint" id="sar-entry-url-hint">
          The page you saved, for example https://www.example.com/. Leave empty to use the website named in the download (https).
        </span>
        <input id="sar-entry-url" name="entryUrl" type="url" inputMode="url" placeholder="https://" aria-describedby="sar-entry-url-hint" />
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Importing…" : "Import ZIP"}
      </button>
    </form>
  );
}

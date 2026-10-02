"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { MAX_CAPTURE_BYTES } from "@/domain/reference";

type Done = { referenceId: string; sourceId: string; entryUrl: string; jobId: string; createdReference: boolean };

// SaveAllResources export → WF-02 capture + WF-03 source (study only), in one step.
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
        if (!(file instanceof File) || !file.name) return setResult({ ok: false, message: "Choose the SaveAllResources export (.zip)." });
        if (file.size > MAX_CAPTURE_BYTES) return setResult({ ok: false, message: `Captures are limited to ${MAX_CAPTURE_BYTES / 1024 / 1024} MB.` });
        startTransition(async () => {
          setResult(null);
          try {
            const res = await fetch(`/api/projects/${projectId}/references/import/save-all-resources`, { method: "POST", body: data });
            const body = await res.json().catch(() => ({}));
            if (res.status === 201) {
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
      <h2 id="sar-heading">Manual fallback: import a SaveAllResources ZIP</h2>
      <p className="small muted">
        Only for a website-template.zip that already exists (for example made on another machine, or for debugging). Normally use <strong>Generate Website Template</strong> on the project page, which runs SaveAllResources for you. The ZIP is stored unchanged as a capture of its entry URL and registered for WF-03 as <strong>study only</strong>; tool, URL, date and job come from its manifest.
      </p>
      {result?.ok === false && (
        <p className="alert error" role="alert">
          {result.message}
        </p>
      )}
      {result?.ok && (
        <p className="alert success" role="status">
          Imported job {result.done.jobId} ({result.done.entryUrl}){result.done.createdReference ? " as a new reference" : ""}.{" "}
          <Link href={`/projects/${projectId}/sources/${result.done.sourceId}`}>Open the source to run the analysis</Link>.
        </p>
      )}
      <div className="field">
        <label htmlFor="sar-file" className="required">
          Export ZIP
        </label>
        <span className="hint" id="sar-file-hint">
          A SaveAllResources website-template.zip. Maximum website template size: {MAX_CAPTURE_BYTES / 1024 / 1024} MB.
        </span>
        <input id="sar-file" name="file" type="file" accept=".zip" aria-describedby="sar-file-hint" />
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Importing…" : "Import ZIP"}
      </button>
    </form>
  );
}

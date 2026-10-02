"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { addAssetUrlAction, removeAssetAction } from "@/app/(dashboard)/projects/actions";
import { ALLOWED_UPLOAD_EXTENSIONS, ASSET_KIND_LABELS, AssetKind, MAX_UPLOAD_BYTES, fileExtension } from "@/domain/asset";
import type { ActionResult } from "@/lib/action-result";

type Issue = { path: string; message: string };

function KindSelect({ id, value, onChange }: { id: string; value?: string; onChange?: (v: AssetKind) => void }) {
  return (
    <div className="field">
      <label htmlFor={id} className="required">
        Kind
      </label>
      <select id={id} name="kind" value={value} onChange={(e) => onChange?.(e.target.value as AssetKind)}>
        {AssetKind.options.map((k) => (
          <option key={k} value={k}>
            {ASSET_KIND_LABELS[k]}
          </option>
        ))}
      </select>
    </div>
  );
}

type LabelNotes = { label: string; notes: string };

function LabelAndNotes({
  prefix,
  issues,
  values,
  onChange,
}: {
  prefix: string;
  issues: Issue[];
  values?: LabelNotes;
  onChange?: (v: LabelNotes) => void;
}) {
  const labelError = issues.find((i) => i.path === "label")?.message;
  // Controlled when values are given (the link form); uncontrolled otherwise.
  const bind = (field: keyof LabelNotes) =>
    values && onChange ? { value: values[field], onChange: (e: { target: { value: string } }) => onChange({ ...values, [field]: e.target.value }) } : {};
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-label`} className="required">
          Label
        </label>
        <input
          id={`${prefix}-label`}
          name="label"
          type="text"
          maxLength={160}
          {...bind("label")}
          aria-invalid={labelError ? true : undefined}
          aria-describedby={labelError ? `${prefix}-label-error` : undefined}
          placeholder="e.g. Primary logo, full colour"
        />
        {labelError && (
          <p className="field-error" id={`${prefix}-label-error`}>
            {labelError}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-notes`}>Notes</label>
        <input
          id={`${prefix}-notes`}
          name="notes"
          type="text"
          maxLength={1000}
          placeholder="Usage rights, version, where it came from"
          {...bind("notes")}
        />
      </div>
    </>
  );
}

// Uploads go to a Route Handler with fetch (Server Actions cap bodies at 1 MB).
// Success is shown only on a 201 from the server, after the file and its
// record are both stored.
export function AssetUploadForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<AssetKind>("logo");
  const [result, setResult] = useState<{ ok: boolean; message: string; issues: Issue[] } | null>(null);
  const [pending, startTransition] = useTransition();
  const accepted = ALLOWED_UPLOAD_EXTENSIONS[kind].map((e) => `.${e}`).join(",");
  const fileError = result?.issues.find((i) => i.path === "file")?.message;

  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const file = data.get("file");
    // Checked here only to save a pointless upload; the server checks again.
    if (file instanceof File && file.size > MAX_UPLOAD_BYTES) {
      setResult({ ok: false, message: `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; add a link instead.`, issues: [{ path: "file", message: "File too large" }] });
      return;
    }
    if (file instanceof File && file.name && !(ALLOWED_UPLOAD_EXTENSIONS[kind] as readonly string[]).includes(fileExtension(file.name))) {
      setResult({ ok: false, message: `A ${ASSET_KIND_LABELS[kind].toLowerCase()} file must be one of: ${ALLOWED_UPLOAD_EXTENSIONS[kind].join(", ")}.`, issues: [{ path: "file", message: "File type not accepted for this kind" }] });
      return;
    }
    startTransition(async () => {
      setResult(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: data });
        const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Issue[] };
        if (res.status === 201) {
          formRef.current?.reset();
          setKind("logo");
          setResult({ ok: true, message: "File uploaded and added to the register.", issues: [] });
          router.refresh();
        } else {
          setResult({ ok: false, message: body.error ?? `Upload failed (HTTP ${res.status}).`, issues: body.issues ?? [] });
        }
      } catch {
        setResult({ ok: false, message: "Upload failed: the server could not be reached. Nothing was saved.", issues: [] });
      }
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget);
      }}
      aria-labelledby="upload-heading"
    >
      <h2 id="upload-heading">Upload a file</h2>
      {result && (
        <p className={`alert ${result.ok ? "success" : "error"}`} role={result.ok ? "status" : "alert"}>
          {result.message}
        </p>
      )}
      <KindSelect id="upload-kind" value={kind} onChange={setKind} />
      <div className="field">
        <label htmlFor="upload-file" className="required">
          File
        </label>
        <span className="hint" id="upload-file-hint">
          Up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB. Accepted for {ASSET_KIND_LABELS[kind].toLowerCase()}:{" "}
          {ALLOWED_UPLOAD_EXTENSIONS[kind].join(", ")}.
        </span>
        <input
          id="upload-file"
          name="file"
          type="file"
          accept={accepted}
          aria-invalid={fileError ? true : undefined}
          aria-describedby="upload-file-hint"
        />
        {fileError && <p className="field-error">{fileError}</p>}
      </div>
      <LabelAndNotes prefix="upload" issues={result && !result.ok ? result.issues : []} />
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}

// Submitted from onSubmit, not the form's action prop: React resets a form
// after every action, failed ones included, which once silently turned a
// "Brand guidelines" link into a "Logo" when the user fixed a bad URL.
export function AssetLinkForm({ projectId }: { projectId: string }) {
  const empty = { kind: "logo" as AssetKind, url: "", label: "", notes: "" };
  const [values, setValues] = useState(empty);
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (data: FormData) =>
    startTransition(async () => {
      const result = await addAssetUrlAction(projectId, state, data);
      if (result.ok) setValues(empty);
      setState(result);
    });
  const issues = state && !state.ok ? state.issues : [];
  const urlError = issues.find((i) => i.path === "url")?.message;

  return (
    <form
      noValidate
      aria-labelledby="link-heading"
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget));
      }}
    >
      <h2 id="link-heading">Record a link</h2>
      <p className="small muted">For files that live elsewhere: a Drive folder, brand portal, font licence page or large video.</p>
      {state && (
        <p className={`alert ${state.ok ? "success" : "error"}`} role={state.ok ? "status" : "alert"}>
          {state.ok ? "Link added to the register." : state.message}
        </p>
      )}
      <KindSelect id="link-kind" value={values.kind} onChange={(kind) => setValues((v) => ({ ...v, kind }))} />
      <div className="field">
        <label htmlFor="link-url" className="required">
          URL
        </label>
        <input
          id="link-url"
          name="url"
          type="url"
          placeholder="https://"
          value={values.url}
          onChange={(e) => setValues((v) => ({ ...v, url: e.target.value }))}
          aria-invalid={urlError ? true : undefined}
          aria-describedby={urlError ? "link-url-error" : undefined}
        />
        {urlError && (
          <p className="field-error" id="link-url-error">
            {urlError}
          </p>
        )}
      </div>
      <LabelAndNotes
        prefix="link"
        issues={issues}
        values={{ label: values.label, notes: values.notes }}
        onChange={(ln) => setValues((v) => ({ ...v, ...ln }))}
      />
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Adding…" : "Add link"}
      </button>
    </form>
  );
}

export function RemoveAssetButton({ projectId, assetId, label }: { projectId: string; assetId: string; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <button
        type="button"
        className="button link danger small"
        disabled={pending}
        aria-label={`Remove ${label}`}
        onClick={() => {
          if (!window.confirm(`Remove "${label}" from the register? Uploaded files are deleted.`)) return;
          startTransition(async () => {
            const result = await removeAssetAction(projectId, assetId);
            if (result.ok) router.refresh();
            else setError(result.message);
          });
        }}
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

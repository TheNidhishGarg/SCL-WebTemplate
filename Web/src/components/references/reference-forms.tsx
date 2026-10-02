"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import {
  addObservationAction,
  addReferenceAction,
  importReferencesAction,
  recordFailedAttemptAction,
  removeCaptureAction,
  removeObservationAction,
  removeReferenceAction,
  runCheckAction,
  setManualAction,
  updateObservationAction,
  updateReferenceAction,
} from "@/app/(dashboard)/projects/reference-actions";
import { fileExtension } from "@/domain/asset";
import {
  ALLOWED_CAPTURE_EXTENSIONS,
  ASPECT_LABELS,
  CAPTURE_KIND_LABELS,
  MAX_CAPTURE_BYTES,
  ObservationAspect,
  OUTCOME_LABELS,
  USER_REPORTABLE_OUTCOMES,
  type CaptureKind,
  type ObservationBasis,
} from "@/domain/reference";
import type { ActionResult } from "@/lib/action-result";
import { useAction } from "../use-action";

// WF-02 forms. All submit from onSubmit, never a form action prop: React
// resets a form after every action, failed ones included (see project-form.tsx).

function Message({ result, success }: { result: ActionResult<unknown> | null; success?: string }) {
  if (!result) return null;
  if (result.ok) {
    return success ? (
      <p className="alert success" role="status">
        {success}
      </p>
    ) : null;
  }
  return (
    <p className="alert error" role="alert">
      {result.message}
    </p>
  );
}

function Text({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  type = "text",
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: "text" | "url" | "date";
  placeholder?: string;
  multiline?: boolean;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value,
    placeholder,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  };
  return (
    <div className="field">
      <label htmlFor={id} className={required ? "required" : undefined}>
        {label}
      </label>
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {multiline ? <textarea {...common} /> : <input type={type} {...common} />}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function ConfirmButton({ label, confirm, onConfirm, pending, ariaLabel }: { label: string; confirm: string; onConfirm: () => void; pending: boolean; ariaLabel?: string }) {
  return (
    <button
      type="button"
      className="button link danger small"
      disabled={pending}
      aria-label={ariaLabel}
      onClick={() => window.confirm(confirm) && onConfirm()}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

// ------------------------------------------------------------ library page

export function AddReferenceForm({ projectId }: { projectId: string }) {
  const empty = { url: "", label: "", pageType: "" };
  const [v, setV] = useState(empty);
  const { run, result, pending, issue } = useAction(addReferenceAction);
  return (
    <form
      noValidate
      aria-labelledby="add-ref-heading"
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await run(projectId, v)).ok) setV(empty);
      }}
    >
      <h2 id="add-ref-heading">Add a reference</h2>
      <Message result={result} success="Reference added. Open it to check, capture and annotate it." />
      <Text label="Page URL" required type="url" value={v.url} onChange={(url) => setV({ ...v, url })} error={issue("url")} placeholder="https://" hint="One page per reference. Add several pages of the same site separately." />
      <Text label="Label" value={v.label} onChange={(label) => setV({ ...v, label })} placeholder="e.g. Studio X portfolio grid" />
      <Text label="Page type" value={v.pageType} onChange={(pageType) => setV({ ...v, pageType })} placeholder="e.g. Homepage, Case study, Pricing" />
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Adding…" : "Add reference"}
      </button>
    </form>
  );
}

export function ImportFromBriefButton({ projectId, count, briefVersion }: { projectId: string; count: number; briefVersion: number }) {
  const { run, result, pending } = useAction(importReferencesAction);
  const msg = result?.ok ? `${result.data.added} added from brief version ${result.data.briefVersion}${result.data.skipped ? `, ${result.data.skipped} already in the library` : ""}.` : undefined;
  return (
    <div>
      <Message result={result} success={msg} />
      <button type="button" className="button" disabled={pending || count === 0} onClick={() => run(projectId)}>
        {pending ? "Importing…" : count ? `Import ${count} URL${count === 1 ? "" : "s"} from brief v${briefVersion}` : "Brief URLs already imported"}
      </button>
    </div>
  );
}

// ------------------------------------------------------- reference: details

export function ReferenceDetailsForm({
  projectId,
  referenceId,
  initial,
  briefPages,
}: {
  projectId: string;
  referenceId: string;
  initial: { label: string; pageType: string; targetPages: string[]; attribution: string };
  briefPages: { slug: string; title: string }[] | null;
}) {
  const [v, setV] = useState(initial);
  const { run, result, pending, issue } = useAction(updateReferenceAction);
  const toggle = (slug: string) =>
    setV((x) => ({ ...x, targetPages: x.targetPages.includes(slug) ? x.targetPages.filter((s) => s !== slug) : [...x.targetPages, slug] }));
  return (
    <form
      noValidate
      aria-labelledby="ref-details-heading"
      onSubmit={(e) => {
        e.preventDefault();
        run(projectId, referenceId, v);
      }}
    >
      <h2 id="ref-details-heading">Organise</h2>
      <Message result={result} success="Saved." />
      <Text label="Label" value={v.label} onChange={(label) => setV({ ...v, label })} />
      <Text label="Page type" value={v.pageType} onChange={(pageType) => setV({ ...v, pageType })} placeholder="e.g. Homepage" />
      <fieldset className="field" aria-describedby="target-pages-hint">
        <legend className="label">Informs these client pages</legend>
        <span className="hint" id="target-pages-hint">
          {briefPages ? "From the approved brief." : "Approve the client brief to link references to its pages."}
        </span>
        {briefPages?.map((p) => (
          <label key={p.slug} className="small" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input type="checkbox" checked={v.targetPages.includes(p.slug)} onChange={() => toggle(p.slug)} />
            {p.title} <code className="muted">/{p.slug}</code>
          </label>
        ))}
        {issue("targetPages") && <p className="field-error">{issue("targetPages")}</p>}
      </fieldset>
      <Text label="Attribution" value={v.attribution} onChange={(attribution) => setV({ ...v, attribution })} hint="Who owns this site or work, e.g. © Studio X." />
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export function RemoveReferenceButton({ projectId, referenceId }: { projectId: string; referenceId: string }) {
  const router = useRouter();
  const { run, result, pending } = useAction(removeReferenceAction);
  return (
    <div>
      <Message result={result} />
      <ConfirmButton
        label="Remove this reference"
        confirm="Remove this reference with all its captures, observations and attempt history?"
        pending={pending}
        onConfirm={async () => {
          if ((await run(projectId, referenceId)).ok) router.push(`/projects/${projectId}/references`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------- reference: acquisition

export function CheckUrlButton({ projectId, referenceId }: { projectId: string; referenceId: string }) {
  const { run, result, pending } = useAction(runCheckAction);
  return (
    <div>
      <Message result={result} success={result?.ok ? `Check recorded: ${OUTCOME_LABELS[result.data.outcome]}.` : undefined} />
      <button type="button" className="button" disabled={pending} onClick={() => run(projectId, referenceId)}>
        {pending ? "Checking…" : "Check URL now"}
      </button>
    </div>
  );
}

export function FailedAttemptForm({ projectId, referenceId }: { projectId: string; referenceId: string }) {
  const empty = { outcome: "capture_failed", detail: "" };
  const [v, setV] = useState(empty);
  const { run, result, pending, issue } = useAction(recordFailedAttemptAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await run(projectId, referenceId, v)).ok) setV(empty);
      }}
    >
      <h3>Record a failed capture</h3>
      <Message result={result} success="Recorded in the attempt log." />
      <Choice label="What happened" value={v.outcome} options={USER_REPORTABLE_OUTCOMES.map((o) => [o, OUTCOME_LABELS[o]])} onChange={(outcome) => setV({ ...v, outcome })} />
      <Text label="Details" required multiline value={v.detail} onChange={(detail) => setV({ ...v, detail })} error={issue("detail")} hint="What you tried and what you saw." />
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Recording…" : "Record attempt"}
      </button>
    </form>
  );
}

export function ManualOnlyForm({ projectId, referenceId, current }: { projectId: string; referenceId: string; current: string | null }) {
  const [reason, setReason] = useState("");
  const { run, result, pending, issue } = useAction(setManualAction);
  if (current) {
    return (
      <div>
        <h3>Manual observations only</h3>
        <Message result={result} />
        <p className="small">{current}</p>
        <button type="button" className="button" disabled={pending} onClick={() => run(projectId, referenceId, null)}>
          Clear, and try acquiring again
        </button>
      </div>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        run(projectId, referenceId, reason);
      }}
    >
      <h3>Cannot be acquired?</h3>
      <Message result={result} />
      <Text label="Why" required multiline value={reason} onChange={setReason} error={issue("reason")} hint="Marks the reference for manual observation. Record what you can see under Observations." />
      <button type="submit" className="button" disabled={pending}>
        Mark as manual observation only
      </button>
    </form>
  );
}

export function CaptureUploadForm({ projectId, referenceId, today }: { projectId: string; referenceId: string; today: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const empty = { kind: "archive" as CaptureKind, tool: "SaveMyResources", capturedOn: today, notes: "" };
  const [v, setV] = useState(empty);
  const [result, setResult] = useState<{ ok: boolean; message: string; issues: { path: string; message: string }[] } | null>(null);
  const [pending, startTransition] = useTransition();
  const issue = (p: string) => result?.issues.find((i) => i.path === p)?.message;
  const allowed = ALLOWED_CAPTURE_EXTENSIONS[v.kind];

  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || !file.name) {
      setResult({ ok: false, message: "Choose the file to upload.", issues: [{ path: "file", message: "Choose a file" }] });
      return;
    }
    if (file.size > MAX_CAPTURE_BYTES) {
      setResult({ ok: false, message: `Captures are limited to ${MAX_CAPTURE_BYTES / 1024 / 1024} MB.`, issues: [{ path: "file", message: "File too large" }] });
      return;
    }
    if (!(allowed as readonly string[]).includes(fileExtension(file.name))) {
      setResult({ ok: false, message: `A ${CAPTURE_KIND_LABELS[v.kind].toLowerCase()} must be one of: ${allowed.join(", ")}.`, issues: [{ path: "file", message: "File type not accepted" }] });
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/references/${referenceId}/captures`, { method: "POST", body: data });
        const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: { path: string; message: string }[] };
        if (res.status === 201) {
          formRef.current?.reset();
          setV(empty);
          setResult({ ok: true, message: "Capture stored and recorded as evidence.", issues: [] });
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
      aria-labelledby="capture-heading"
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget);
      }}
    >
      <h3 id="capture-heading">Add a capture</h3>
      {result && (
        <p className={`alert ${result.ok ? "success" : "error"}`} role={result.ok ? "status" : "alert"}>
          {result.message}
        </p>
      )}
      <div className="two-col">
        <Choice
          label="Kind"
          value={v.kind}
          options={Object.entries(CAPTURE_KIND_LABELS)}
          onChange={(k) => setV({ ...v, kind: k as CaptureKind, tool: k === "archive" ? "SaveMyResources" : k === "screenshot" ? "Browser screenshot" : v.tool })}
        />
        <Text label="Tool" required value={v.tool} onChange={(tool) => setV({ ...v, tool })} error={issue("tool")} />
      </div>
      <input type="hidden" name="kind" value={v.kind} />
      <input type="hidden" name="tool" value={v.tool} />
      <input type="hidden" name="capturedOn" value={v.capturedOn} />
      <input type="hidden" name="notes" value={v.notes} />
      <div className="field">
        <label htmlFor="capture-file" className="required">
          File
        </label>
        <span className="hint" id="capture-file-hint">
          Up to {MAX_CAPTURE_BYTES / 1024 / 1024} MB: {allowed.join(", ")}.
        </span>
        <input id="capture-file" name="file" type="file" accept={allowed.map((e) => `.${e}`).join(",")} aria-describedby="capture-file-hint" aria-invalid={issue("file") ? true : undefined} />
        {issue("file") && <p className="field-error">{issue("file")}</p>}
      </div>
      <Text label="Captured on" required type="date" value={v.capturedOn} onChange={(capturedOn) => setV({ ...v, capturedOn })} error={issue("capturedOn")} />
      <Text label="Notes" value={v.notes} onChange={(notes) => setV({ ...v, notes })} hint="What the capture covers, e.g. homepage only, logged-out view." />
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Uploading…" : "Upload capture"}
      </button>
    </form>
  );
}

export function RemoveCaptureButton({ projectId, referenceId, captureId, filename }: { projectId: string; referenceId: string; captureId: string; filename: string }) {
  const { run, result, pending } = useAction(removeCaptureAction);
  return (
    <>
      <ConfirmButton
        label="Remove"
        ariaLabel={`Remove capture ${filename}`}
        confirm={`Delete the capture ${filename}? Observations linked to it are kept.`}
        pending={pending}
        onConfirm={() => run(projectId, referenceId, captureId)}
      />
      {result && !result.ok && (
        <p className="field-error" role="alert">
          {result.message}
        </p>
      )}
    </>
  );
}

// --------------------------------------------------- reference: observations

type ObservationValues = { aspect: string; basis: ObservationBasis; text: string; captureId: string | null };

export function ObservationForm({
  projectId,
  referenceId,
  captures,
  existing,
  onDone,
}: {
  projectId: string;
  referenceId: string;
  captures: { id: string; filename: string }[];
  existing?: { id: string } & ObservationValues;
  onDone?: () => void;
}) {
  const empty: ObservationValues = { aspect: "layout", basis: "observed", text: "", captureId: null };
  const [v, setV] = useState<ObservationValues>(existing ?? empty);
  const add = useAction(addObservationAction);
  const update = useAction(updateObservationAction);
  const { result, pending, issue } = existing ? update : add;
  const name = useId();
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = existing ? await update.run(projectId, referenceId, existing.id, v) : await add.run(projectId, referenceId, v);
        if (r.ok) {
          if (!existing) setV({ ...empty, aspect: v.aspect, basis: v.basis });
          onDone?.();
        }
      }}
    >
      {!existing && <h3>Add an observation</h3>}
      <Message result={result} success={existing ? undefined : "Added."} />
      <div className="two-col">
        <Choice label="Aspect" value={v.aspect} options={ObservationAspect.options.map((a) => [a, ASPECT_LABELS[a]])} onChange={(aspect) => setV({ ...v, aspect })} />
        <Choice
          label="Based on"
          value={v.captureId ?? ""}
          options={[["", "Looking at the live page"], ...captures.map((c): [string, string] => [c.id, `Capture: ${c.filename}`])]}
          onChange={(id) => setV({ ...v, captureId: id || null })}
        />
      </div>
      <fieldset className="field">
        <legend className="label">This is</legend>
        <label className="small" style={{ display: "flex", gap: "0.5rem" }}>
          <input type="radio" name={name} checked={v.basis === "observed"} onChange={() => setV({ ...v, basis: "observed" })} />
          Observed: I saw this on the reference
        </label>
        <label className="small" style={{ display: "flex", gap: "0.5rem" }}>
          <input type="radio" name={name} checked={v.basis === "inferred"} onChange={() => setV({ ...v, basis: "inferred" })} />
          Inferred: my interpretation, not directly verified
        </label>
      </fieldset>
      <Text label="Observation" required multiline value={v.text} onChange={(text) => setV({ ...v, text })} error={issue("text")} />
      <div className="actions">
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? "Saving…" : existing ? "Save" : "Add observation"}
        </button>
        {existing && onDone && (
          <button type="button" className="button" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function ObservationItem({
  projectId,
  referenceId,
  captures,
  observation,
  children,
}: {
  projectId: string;
  referenceId: string;
  captures: { id: string; filename: string }[];
  observation: { id: string } & ObservationValues;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const remove = useAction(removeObservationAction);
  if (editing) {
    return (
      <li>
        <ObservationForm projectId={projectId} referenceId={referenceId} captures={captures} existing={observation} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li>
      {children}
      <div className="actions">
        <button type="button" className="button link small" onClick={() => setEditing(true)}>
          Edit
        </button>
        <ConfirmButton label="Delete" confirm="Delete this observation?" pending={remove.pending} onConfirm={() => remove.run(projectId, referenceId, observation.id)} />
      </div>
      {remove.result && !remove.result.ok && (
        <p className="field-error" role="alert">
          {remove.result.message}
        </p>
      )}
    </li>
  );
}

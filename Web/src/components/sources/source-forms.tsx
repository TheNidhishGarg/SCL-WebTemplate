"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import {
  acceptCandidateAction,
  addFindingAction,
  addQuestionAction,
  extractTemplateAction,
  recordBuildAction,
  registerFromCaptureAction,
  removeSourceAction,
  removeTemplateAction,
  resolveQuestionAction,
  runScanAction,
  updateAuthorizationAction,
} from "@/app/(dashboard)/projects/source-actions";
import { AUTHORIZATION_LABELS, AuthorizationBasis, FindingTopic } from "@/domain/wf03";
import type { ActionResult } from "@/lib/action-result";
import { useAction } from "../use-action";

// WF-03 forms. All submit from onSubmit (see project-form.tsx for why).

type Issue = { path: string; message: string };

function Message({ result, success }: { result: { ok: boolean; message?: string } | ActionResult<unknown> | null; success?: string }) {
  if (!result) return null;
  if (result.ok) return success ? <p className="alert success" role="status">{success}</p> : null;
  return (
    <div className="alert error" role="alert">
      {"message" in result ? result.message : null}
      {"issues" in result && result.issues.length > 1 && (
        <ul>
          {result.issues.slice(0, 20).map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, value, onChange, error, hint, required, multiline, placeholder }: { label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string; required?: boolean; multiline?: boolean; placeholder?: string }) {
  const id = useId();
  const describedBy = [hint && `${id}-h`, error && `${id}-e`].filter(Boolean).join(" ") || undefined;
  const common = { id, value, placeholder, onChange: (e: { target: { value: string } }) => onChange(e.target.value), "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
  return (
    <div className="field">
      <label htmlFor={id} className={required ? "required" : undefined}>
        {label}
      </label>
      {hint && <span className="hint" id={`${id}-h`}>{hint}</span>}
      {multiline ? <textarea {...common} /> : <input type="text" {...common} />}
      {error && <p className="field-error" id={`${id}-e`}>{error}</p>}
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

type Auth = { basis: string; note: string; license: string };

function AuthorityFields({ value, onChange, issue }: { value: Auth; onChange: (a: Auth) => void; issue: (p: string) => string | undefined }) {
  return (
    <>
      <Choice label="Authority to use this source" value={value.basis} options={AuthorizationBasis.options.map((b) => [b, AUTHORIZATION_LABELS[b]])} onChange={(basis) => onChange({ ...value, basis })} />
      {value.basis !== "study_only" && (
        <Field label="Who authorised it, or where the licence is" required multiline value={value.note} onChange={(note) => onChange({ ...value, note })} error={issue("authorization.note") ?? issue("note")} hint="Recorded in the provenance of anything extracted." />
      )}
      {value.basis === "licensed" && <Field label="Licence" required value={value.license} onChange={(license) => onChange({ ...value, license })} error={issue("authorization.license") ?? issue("license")} placeholder="e.g. MIT" />}
      {value.basis === "study_only" && <p className="small muted">Study only: the source is analysed, but nothing is extracted from it.</p>}
    </>
  );
}

// ------------------------------------------------------------ registration

export function RegisterUploadForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const empty = { label: "", originUrl: "", originRef: "", auth: { basis: "client_owned", note: "", license: "" } };
  const [v, setV] = useState(empty);
  const [result, setResult] = useState<{ ok: boolean; message: string; issues: Issue[] } | null>(null);
  const [pending, start] = useTransition();
  const issue = (p: string) => result?.issues.find((i) => i.path === p)?.message;
  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby="register-heading"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const file = data.get("file");
        if (!(file instanceof File) || !file.name) return setResult({ ok: false, message: "Choose the .zip to upload.", issues: [{ path: "file", message: "Choose a file" }] });
        for (const [k, val] of Object.entries({ label: v.label, originUrl: v.originUrl, originRef: v.originRef, basis: v.auth.basis, note: v.auth.note, license: v.auth.license })) data.set(k, val);
        start(async () => {
          try {
            const res = await fetch(`/api/projects/${projectId}/sources`, { method: "POST", body: data });
            const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; issues?: Issue[] };
            if (res.status === 201 && body.id) {
              formRef.current?.reset();
              setV(empty);
              setResult({ ok: true, message: "Source registered. Open it to run the analysis.", issues: [] });
              router.refresh();
            } else setResult({ ok: false, message: body.error ?? `Upload failed (HTTP ${res.status}).`, issues: body.issues ?? [] });
          } catch {
            setResult({ ok: false, message: "Upload failed: the server could not be reached. Nothing was saved.", issues: [] });
          }
        });
      }}
    >
      <h2 id="register-heading">Register a source archive</h2>
      <p className="small muted">A .zip of a repository (e.g. <code>git archive --format=zip -o source.zip HEAD</code>) or of website files you are authorised to use.</p>
      <Message result={result} success={result?.ok ? result.message : undefined} />
      <div className="field">
        <label htmlFor="source-file" className="required">
          Archive (.zip, up to 100 MB)
        </label>
        <input id="source-file" name="file" type="file" accept=".zip" aria-invalid={issue("file") ? true : undefined} />
        {issue("file") && <p className="field-error">{issue("file")}</p>}
      </div>
      <Field label="Name" required value={v.label} onChange={(label) => setV({ ...v, label })} error={issue("label")} placeholder="e.g. Client's current site repo" />
      <Field label="Where it came from" value={v.originUrl} onChange={(originUrl) => setV({ ...v, originUrl })} placeholder="Repository URL, site, or person" />
      <Field label="Commit, tag or version" value={v.originRef} onChange={(originRef) => setV({ ...v, originRef })} hint="So the exact input can be found again." />
      <AuthorityFields value={v.auth} onChange={(auth) => setV({ ...v, auth })} issue={issue} />
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Uploading…" : "Register source"}
      </button>
    </form>
  );
}

// On success the capture leaves this list, so the new source is opened
// instead of showing a message that would vanish with the form.
export function RegisterCaptureForm({ projectId, referenceId, captureId, defaultLabel }: { projectId: string; referenceId: string; captureId: string; defaultLabel: string }) {
  const router = useRouter();
  const [label, setLabel] = useState(defaultLabel);
  const [auth, setAuth] = useState<Auth>({ basis: "study_only", note: "", license: "" });
  const { run, result, pending, issue } = useAction(registerFromCaptureAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(projectId, referenceId, captureId, { label, authorization: auth });
        if (r.ok) router.push(`/projects/${projectId}/sources/${r.data}`);
      }}
    >
      <Message result={result} />
      <Field label="Name" required value={label} onChange={setLabel} error={issue("label")} />
      <AuthorityFields value={auth} onChange={setAuth} issue={issue} />
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Registering…" : "Use as a source"}
      </button>
    </form>
  );
}

// ------------------------------------------------------------ source page

export function AuthorityForm({ projectId, sourceId, initial }: { projectId: string; sourceId: string; initial: Auth }) {
  const [auth, setAuth] = useState(initial);
  const { run, result, pending, issue } = useAction(updateAuthorizationAction);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        run(projectId, sourceId, auth);
      }}
    >
      <Message result={result} success="Authority updated." />
      <AuthorityFields value={auth} onChange={setAuth} issue={issue} />
      <button type="submit" className="button" disabled={pending}>
        Save authority
      </button>
    </form>
  );
}

export function RunScanButton({ projectId, sourceId, label }: { projectId: string; sourceId: string; label: string }) {
  const { run, result, pending } = useAction(runScanAction);
  return (
    <div>
      <Message result={result} success={result?.ok ? `Analysis complete. Digest ${result.data.digest.slice(0, 12)}…` : undefined} />
      <button type="button" className="button primary" disabled={pending} onClick={() => run(projectId, sourceId)}>
        {pending ? "Analysing…" : label}
      </button>
    </div>
  );
}

export function AcceptCandidateButton({ projectId, sourceId, candidateKey, name }: { projectId: string; sourceId: string; candidateKey: string; name: string }) {
  const { run, result, pending } = useAction(acceptCandidateAction);
  return (
    <>
      <button type="button" className="button" disabled={pending} onClick={() => run(projectId, sourceId, candidateKey)} aria-label={`Add ${name} to the template manifest`}>
        {pending ? "Adding…" : "Add to manifest"}
      </button>
      {result && !result.ok && <p className="field-error" role="alert">{result.message}</p>}
    </>
  );
}

export function TemplateActions({ projectId, templateId, name, canExtract, extracted, needsBuildRecord }: { projectId: string; templateId: string; name: string; canExtract: boolean; extracted: boolean; needsBuildRecord: boolean }) {
  const extract = useAction(extractTemplateAction);
  const remove = useAction(removeTemplateAction);
  const build = useAction(recordBuildAction);
  const [b, setB] = useState({ status: "passed", note: "" });
  return (
    <div className="stack">
      <div className="actions">
        {canExtract ? (
          <button type="button" className="button" disabled={extract.pending} onClick={() => extract.run(projectId, templateId)} aria-label={`${extracted ? "Re-extract" : "Extract"} ${name}`}>
            {extract.pending ? "Extracting…" : extracted ? "Re-extract" : "Extract to workspace"}
          </button>
        ) : (
          <span className="small muted">Not extractable: the source is study only.</span>
        )}
        <button type="button" className="button link danger small" disabled={remove.pending} onClick={() => window.confirm(`Remove ${name} from the manifest${extracted ? " and delete its extracted files" : ""}?`) && remove.run(projectId, templateId)} aria-label={`Remove ${name}`}>
          Remove
        </button>
      </div>
      <Message result={extract.result} success={extract.result?.ok ? `Extracted to workspace/${extract.result.data.workspacePath}` : undefined} />
      <Message result={remove.result} />
      {extracted && needsBuildRecord && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            build.run(projectId, templateId, b);
          }}
        >
          <Message result={build.result} success="Build result recorded." />
          <div className="two-col">
            <Choice label="Build result in VS Code" value={b.status} options={[["passed", "Passed"], ["failed", "Failed"]]} onChange={(status) => setB({ ...b, status })} />
            <Field label="Command and output" required value={b.note} onChange={(note) => setB({ ...b, note })} error={build.issue("note")} placeholder="e.g. npx tsc --noEmit → 0 errors" />
          </div>
          <button type="submit" className="button" disabled={build.pending}>
            Record build
          </button>
        </form>
      )}
    </div>
  );
}

export function FindingsImportForm({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; issues: Issue[] } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby="import-heading"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const file = data.get("file");
        if (!(file instanceof File) || !file.name) return setResult({ ok: false, message: "Choose findings.json.", issues: [] });
        start(async () => {
          try {
            const res = await fetch(`/api/projects/${projectId}/sources/${sourceId}/findings`, { method: "POST", body: data });
            const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Issue[]; findings?: number; questions?: number; templates?: number };
            if (res.status === 201) {
              formRef.current?.reset();
              setResult({ ok: true, message: `Imported ${body.findings} findings, ${body.questions} questions, ${body.templates} templates.`, issues: [] });
              router.refresh();
            } else setResult({ ok: false, message: body.error ?? `Import failed (HTTP ${res.status}).`, issues: body.issues ?? [] });
          } catch {
            setResult({ ok: false, message: "Import failed: the server could not be reached. Nothing was imported.", issues: [] });
          }
        });
      }}
    >
      <h3 id="import-heading">Import findings from VS Code</h3>
      {result && !result.ok ? (
        // Every problem is listed, even a single one: the analyst needs to know
        // exactly which citation to fix.
        <div className="alert error" role="alert">
          {result.message}
          {result.issues.length > 0 && (
            <ul>
              {result.issues.slice(0, 20).map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <Message result={result} success={result?.ok ? result.message : undefined} />
      )}
      <div className="field">
        <label htmlFor="findings-file">findings.json</label>
        <input id="findings-file" name="file" type="file" accept=".json,application/json" />
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Checking…" : "Import"}
      </button>
    </form>
  );
}

export function AddFindingForm({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const empty = { basis: "fact", topic: "components", statement: "", evidencePath: "", evidenceLine: "" };
  const [v, setV] = useState(empty);
  const { run, result, pending, issue } = useAction(addFindingAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await run(projectId, sourceId, v)).ok) setV({ ...empty, basis: v.basis, topic: v.topic });
      }}
    >
      <h3>Add a finding</h3>
      <Message result={result} success="Added." />
      <div className="two-col">
        <Choice label="This is" value={v.basis} options={[["fact", "Fact: I can point to it in the source"], ["assumption", "Assumption: my conclusion"]]} onChange={(basis) => setV({ ...v, basis })} />
        <Choice label="Topic" value={v.topic} options={FindingTopic.options.map((t) => [t, t])} onChange={(topic) => setV({ ...v, topic })} />
      </div>
      <Field label="Finding" required multiline value={v.statement} onChange={(statement) => setV({ ...v, statement })} error={issue("statement")} />
      <div className="two-col">
        <Field label="File in the source" required={v.basis === "fact"} value={v.evidencePath} onChange={(evidencePath) => setV({ ...v, evidencePath })} error={issue("evidencePath")} placeholder="e.g. components/Header.tsx" />
        <Field label="Line" value={v.evidenceLine} onChange={(evidenceLine) => setV({ ...v, evidenceLine: evidenceLine.replace(/\D/g, "") })} />
      </div>
      <button type="submit" className="button" disabled={pending}>
        Add finding
      </button>
    </form>
  );
}

export function AddQuestionForm({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const [text, setText] = useState("");
  const { run, result, pending, issue } = useAction(addQuestionAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if ((await run(projectId, sourceId, text)).ok) setText("");
      }}
    >
      <Message result={result} />
      <Field label="Add a question" value={text} onChange={setText} error={issue("text")} />
      <button type="submit" className="button" disabled={pending}>
        Add question
      </button>
    </form>
  );
}

export function QuestionAnswer({ projectId, sourceId, questionId, resolved }: { projectId: string; sourceId: string; questionId: string; resolved: boolean }) {
  const [answer, setAnswer] = useState("");
  const { run, result, pending } = useAction(resolveQuestionAction);
  if (resolved) {
    return (
      <button type="button" className="button link small" disabled={pending} onClick={() => run(projectId, sourceId, questionId, "")}>
        Reopen
      </button>
    );
  }
  return (
    <form
      noValidate
      className="actions"
      onSubmit={(e) => {
        e.preventDefault();
        if (answer.trim()) run(projectId, sourceId, questionId, answer);
      }}
    >
      <label className="visually-hidden" htmlFor={`answer-${questionId}`}>
        Answer
      </label>
      <input id={`answer-${questionId}`} type="text" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" style={{ flex: 1, minWidth: "12rem" }} />
      <button type="submit" className="button" disabled={pending || !answer.trim()}>
        Resolve
      </button>
      <Message result={result} />
    </form>
  );
}

export function RemoveSourceButton({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const router = useRouter();
  const { run, result, pending } = useAction(removeSourceAction);
  return (
    <div>
      <Message result={result} />
      <button
        type="button"
        className="button link danger small"
        disabled={pending}
        onClick={async () => {
          if (!window.confirm("Remove this source, its analyses, findings, questions, templates and extracted files?")) return;
          if ((await run(projectId, sourceId)).ok) router.push(`/projects/${projectId}/sources`);
        }}
      >
        Remove this source
      </button>
    </div>
  );
}

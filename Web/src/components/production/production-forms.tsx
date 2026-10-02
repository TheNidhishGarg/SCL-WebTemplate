"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  addPromptAction,
  cancelJobAction,
  generateAction,
  pollJobAction,
  previewRequestAction,
  retryJobAction,
  reviewTakeAction,
  setBlockedAction,
  startProductionAction,
} from "@/app/(dashboard)/projects/production-actions";
import { MAX_ATTEMPTS, PROVIDER_LABELS, REVIEW_CONFIRMATIONS, SHOT_LABELS, type ProviderId, type ShotStatus } from "@/domain/production";
import type { Shot, Take } from "@/server/store/production";
import { formatDateTime } from "../format";
import { Check, Field } from "../content/section-fields";
import { useAction } from "../use-action";

type ProviderStatus = { id: ProviderId; configured: boolean; missingConfig: string[]; capabilities: { aspectRatios: string[]; durations: string; inputs: string; notes: string[] } };

const STATUS_BADGE: Record<ShotStatus, string> = { approved: "ok", blocked: "danger", failed: "danger", rejected: "warn", review_required: "warn", generating: "", queued: "", pending: "" };

function Result({ result, success }: { result: { ok: boolean; message?: string } | null; success?: string }) {
  if (!result) return null;
  if (result.ok) return success ? <p className="alert success small" role="status">{success}</p> : null;
  return <p className="alert error small" role="alert">{result.message}</p>;
}

export function StartProductionButton({ projectId, journeyId, label }: { projectId: string; journeyId: string; label: string }) {
  const router = useRouter();
  const { run, result, pending } = useAction(startProductionAction);
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <Result result={result} />
      <button
        type="button"
        className="button primary"
        disabled={pending}
        onClick={async () => {
          const r = await run(projectId, journeyId);
          if (r.ok) router.push(`/projects/${projectId}/production/${r.data}`);
        }}
      >
        {pending ? "Starting…" : `Start production: ${label}`}
      </button>
    </div>
  );
}

export function ShotPanel({ projectId, productionId, shot, providers }: { projectId: string; productionId: string; shot: Shot; providers: ProviderStatus[] }) {
  const ids = { projectId, productionId, slotId: shot.slotId };
  const a = shot.slot.acceptance;
  return (
    <article className="card" style={{ marginTop: "1rem" }} aria-label={`Shot: ${shot.slot.label}`}>
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>
          {shot.slot.label} <span className="small muted">({shot.slot.kind}{shot.slot.required ? ", required" : ""})</span>
        </h3>
        <span className={`badge ${STATUS_BADGE[shot.status]}`} data-testid="shot-status">
          {SHOT_LABELS[shot.status]}
        </span>
      </div>
      <p className="small muted">
        Needs: {a.aspectRatio}
        {a.minDurationSeconds !== null && `, at least ${a.minDurationSeconds}s`}
        {a.seamlessLoop && ", seamless loop"}, no burned-in text.
        {shot.blockedReason && <strong> Blocked: {shot.blockedReason}</strong>}
      </p>
      <Takes {...ids} shot={shot} />
      {shot.status !== "approved" && !shot.blockedReason && (
        <>
          <Jobs {...ids} shot={shot} />
          <div className="two-col">
            <Generate {...ids} shot={shot} providers={providers} />
            <ManualUpload {...ids} kind={shot.slot.kind} />
          </div>
        </>
      )}
      <Prompts {...ids} shot={shot} />
      <Block {...ids} shot={shot} />
    </article>
  );
}

function Prompts({ projectId, productionId, slotId, shot }: { projectId: string; productionId: string; slotId: string; shot: Shot }) {
  const current = shot.prompts[0];
  const [v, setV] = useState({ positive: current?.positive ?? "", negative: current?.negative ?? "", note: "" });
  const { run, result, pending, issue } = useAction(addPromptAction);
  return (
    <details>
      <summary className="small">
        Prompt v{current?.version} ({shot.prompts.length} version{shot.prompts.length === 1 ? "" : "s"})
      </summary>
      <ol reversed className="small">
        {shot.prompts.map((p) => (
          <li key={p.version}>
            <strong>v{p.version}</strong> {p.note && <em>({p.note})</em>} · {formatDateTime(p.createdAt)}
            <div>{p.positive}</div>
            <div className="muted">Avoid: {p.negative || "—"}</div>
          </li>
        ))}
      </ol>
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(projectId, productionId, slotId, v);
          if (r.ok) setV({ ...v, note: "" });
        }}
      >
        <Result result={result} success={result?.ok ? `Saved as prompt v${result.data}.` : undefined} />
        <Field label="Prompt" required multiline value={v.positive} onChange={(positive) => setV({ ...v, positive })} error={issue("positive")} />
        <Field label="Avoid" multiline value={v.negative} onChange={(negative) => setV({ ...v, negative })} hint="Neither Runway nor Veo takes a negative prompt; this is written into the prompt as “Avoid: …”." />
        <Field label="What changed" value={v.note} onChange={(note) => setV({ ...v, note })} />
        <button type="submit" className="button" disabled={pending}>
          Save as new prompt version
        </button>
      </form>
    </details>
  );
}

function Generate({ projectId, productionId, slotId, shot, providers }: { projectId: string; productionId: string; slotId: string; shot: Shot; providers: ProviderStatus[] }) {
  const [provider, setProvider] = useState<ProviderId>(providers.find((p) => p.configured)?.id ?? "runway");
  const [repeat, setRepeat] = useState(false);
  const gen = useAction(generateAction);
  const preview = useAction(previewRequestAction);
  const status = providers.find((p) => p.id === provider)!;
  const duplicate = gen.result && !gen.result.ok && gen.result.issues.some((i) => i.path === "allowRepeat");
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void gen.run(projectId, productionId, slotId, provider, repeat);
      }}
      aria-label="Generate with a provider"
    >
      <h4>Generate</h4>
      <div className="field">
        <label htmlFor={`prov-${slotId}`}>Provider</label>
        <select id={`prov-${slotId}`} value={provider} onChange={(e) => (setProvider(e.target.value as ProviderId), preview.reset(), gen.reset())}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {PROVIDER_LABELS[p.id]}
              {p.configured ? "" : " (not configured)"}
            </option>
          ))}
        </select>
        <span className="hint">
          {status.capabilities.aspectRatios.join(", ")} · {status.capabilities.durations}. {status.capabilities.notes.join(". ")}.
        </span>
      </div>
      {!status.configured && <p className="alert info small">Not configured on this server: set {status.missingConfig.join(", ")}. Until then, use manual upload.</p>}
      <Result result={gen.result} success={gen.result?.ok ? (gen.result.data.status === "failed" ? undefined : `Submitted. Status: ${gen.result.data.status}.`) : undefined} />
      {gen.result?.ok && gen.result.data.status === "failed" && (
        <p className="alert error small" role="alert">
          Submission failed: {gen.result.data.error}
        </p>
      )}
      {duplicate && <Check label="Generate another take from the identical request anyway" checked={repeat} onChange={setRepeat} />}
      <div className="actions">
        <button type="button" className="button" disabled={preview.pending} onClick={() => preview.run(projectId, productionId, slotId, provider)}>
          Preview request
        </button>
        <button type="submit" className="button primary" disabled={!status.configured || gen.pending}>
          {gen.pending ? "Submitting…" : `Generate with ${PROVIDER_LABELS[provider]}`}
        </button>
      </div>
      {preview.result?.ok &&
        (preview.result.data.ok ? (
          <pre className="small" style={{ whiteSpace: "pre-wrap", maxHeight: "16rem", overflow: "auto" }}>
            {`POST ${preview.result.data.endpoint}\n${JSON.stringify(preview.result.data.body, null, 2)}${preview.result.data.notes.length ? `\n\n${preview.result.data.notes.join("\n")}` : ""}`}
          </pre>
        ) : (
          <div className="alert error small" role="alert">
            {PROVIDER_LABELS[provider]} cannot make this shot as specified:
            <ul>
              {preview.result.data.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
      {preview.result && !preview.result.ok && <Result result={preview.result} />}
      {shot.jobs.length === 0 && <p className="small muted">Nothing is sent until you press Generate. Each request is stored with its prompt version.</p>}
    </form>
  );
}

function Jobs({ projectId, productionId, shot }: { projectId: string; productionId: string; slotId: string; shot: Shot }) {
  const poll = useAction(pollJobAction);
  const retry = useAction(retryJobAction);
  const cancel = useAction(cancelJobAction);
  if (shot.jobs.length === 0) return null;
  const err = [poll, retry, cancel].map((x) => x.result).find((r) => r && !r.ok) ?? null;
  return (
    <div>
      <h4>Jobs</h4>
      <Result result={err} />
      <ul className="log">
        {shot.jobs.map((j) => (
          <li key={j.id}>
            <div className="actions" style={{ justifyContent: "space-between" }}>
              <span>
                {PROVIDER_LABELS[j.provider]} · {j.model} · prompt v{j.promptVersion} · attempt {j.attempts}/{MAX_ATTEMPTS}
              </span>
              <span className={`badge ${j.status === "completed" ? "ok" : j.status === "failed" ? "danger" : ""}`}>{j.status}</span>
            </div>
            <div className="small muted">
              {j.providerJobId && `Provider job ${j.providerJobId} · `}updated {formatDateTime(j.updatedAt)}
            </div>
            {j.error && <div className="small">{j.error.message}{j.status === "failed" && (j.error.retryable ? " (retryable)" : " (not retryable as-is)")}</div>}
            <div className="actions">
              {j.status === "generating" && (
                <button type="button" className="button" disabled={poll.pending} onClick={() => poll.run(projectId, productionId, j.id)}>
                  Check status
                </button>
              )}
              {j.status === "failed" && j.error?.retryable && j.attempts < MAX_ATTEMPTS && (
                <button type="button" className="button" disabled={retry.pending} onClick={() => retry.run(projectId, productionId, j.id)}>
                  Retry
                </button>
              )}
              {(j.status === "queued" || j.status === "generating") && (
                <button type="button" className="button danger" disabled={cancel.pending} onClick={() => cancel.run(projectId, productionId, j.id)}>
                  Cancel
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ManualUpload({ projectId, productionId, slotId, kind }: { projectId: string; productionId: string; slotId: string; kind: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [tool, setTool] = useState("Flow");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const accept = kind === "still" ? ".png,.jpg,.jpeg" : kind === "audio" ? ".m4a,.mp4" : ".mp4,.mov";
  return (
    <form
      ref={formRef}
      noValidate
      aria-label="Upload a take"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(async () => {
          setResult(null);
          try {
            const res = await fetch(`/api/projects/${projectId}/production/${productionId}/shots/${slotId}/upload`, { method: "POST", body: data });
            const body = (await res.json().catch(() => ({}))) as { error?: string; passed?: boolean };
            if (res.status === 201) {
              formRef.current?.reset();
              setResult({ ok: true, message: body.passed ? "Uploaded. Checks passed; review it below." : "Uploaded, but it fails its checks. See the take below." });
              router.refresh();
            } else setResult({ ok: false, message: body.error ?? `Upload failed (HTTP ${res.status}).` });
          } catch {
            setResult({ ok: false, message: "Upload failed: the server could not be reached. Nothing was saved." });
          }
        });
      }}
    >
      <h4>Manual upload</h4>
      {result && (
        <p className={`alert ${result.ok ? "success" : "error"} small`} role={result.ok ? "status" : "alert"}>
          {result.message}
        </p>
      )}
      <div className="field">
        <label htmlFor={`file-${slotId}`} className="required">
          File
        </label>
        <span className="hint">From Flow, a provider&apos;s own app, or a shoot. {accept}, up to 500 MB. The file is checked as uploaded.</span>
        <input id={`file-${slotId}`} name="file" type="file" accept={accept} />
      </div>
      <div className="field">
        <label htmlFor={`tool-${slotId}`} className="required">
          Made with
        </label>
        <input id={`tool-${slotId}`} name="tool" type="text" value={tool} onChange={(e) => setTool(e.target.value)} />
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Uploading…" : "Upload take"}
      </button>
    </form>
  );
}

function Takes({ projectId, productionId, shot }: { projectId: string; productionId: string; slotId: string; shot: Shot }) {
  if (shot.takes.length === 0) return <p className="small muted">No takes yet.</p>;
  const visible = shot.takes.filter((t) => t.review !== "rejected");
  const rejected = shot.takes.filter((t) => t.review === "rejected");
  return (
    <div>
      <h4>Takes ({shot.takes.length}){visible.length > 1 && <span className="small muted"> · side by side to compare</span>}</h4>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))" }}>
        {visible.map((t) => (
          <TakeCard key={t.id} projectId={projectId} productionId={productionId} shot={shot} take={t} />
        ))}
      </div>
      {rejected.length > 0 && (
        <details>
          <summary className="small">Rejected takes ({rejected.length})</summary>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))" }}>
            {rejected.map((t) => (
              <TakeCard key={t.id} projectId={projectId} productionId={productionId} shot={shot} take={t} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function TakeCard({ projectId, productionId, shot, take }: { projectId: string; productionId: string; shot: Shot; take: Take }) {
  const url = `/api/projects/${projectId}/production/${productionId}/takes/${take.id}/file`;
  const needed = (["plays", "noText", ...(shot.slot.kind === "loop" ? ["loop"] : [])] as (keyof typeof REVIEW_CONFIRMATIONS)[]);
  const [conf, setConf] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const { run, result, pending } = useAction(reviewTakeAction);
  const isVideo = take.file.mimeType.startsWith("video/");
  return (
    <div className="card" role="group" aria-label={`Take ${take.file.filename}`}>
      {isVideo ? (
        <video src={url} controls preload="metadata" loop={shot.slot.kind === "loop"} style={{ width: "100%" }} aria-label={`Playback of ${take.file.filename}`} />
      ) : take.file.mimeType.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`Take ${take.file.filename}`} style={{ width: "100%" }} />
      ) : (
        <p className="small muted">Not playable here.</p>
      )}
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <strong className="small">{take.file.filename}</strong>
        <span className={`badge ${take.review === "approved" ? "ok" : take.review === "rejected" ? "danger" : "warn"}`}>{take.review.replace("_", " ")}</span>
      </div>
      <div className="small muted">
        {take.source === "manual_upload" ? `Uploaded · ${take.tool}` : `${PROVIDER_LABELS[take.provider as ProviderId] ?? take.provider} · ${take.model}`}
        {take.promptVersion !== null && ` · prompt v${take.promptVersion}`} · {formatDateTime(take.createdAt)}
      </div>
      <ul className="checklist small" aria-label="Checks">
        {take.checks.map((c) => (
          <li key={c.key}>
            <span>
              {c.key}: {c.message}
            </span>
            <span className={`badge ${c.passed ? "ok" : "danger"}`}>{c.passed ? "Pass" : "Fail"}</span>
          </li>
        ))}
      </ul>
      {take.reviewNote && <p className="small">Note: {take.reviewNote}</p>}
      <a className="small" href={`${url}?download`}>
        Download original
      </a>
      {take.review === "review_required" && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const decision = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "approve";
            void run(projectId, productionId, take.id, { decision, note, confirmations: conf });
          }}
        >
          <Result result={result} />
          {take.passed ? (
            needed.map((k) => <Check key={k} label={REVIEW_CONFIRMATIONS[k]} checked={!!conf[k]} onChange={(on) => setConf({ ...conf, [k]: on })} />)
          ) : (
            <p className="small muted">Fails its checks, so it cannot be approved.</p>
          )}
          <Field label="Review note" value={note} onChange={setNote} hint="Required to reject: say what the next take should fix." />
          <div className="actions">
            {take.passed && (
              <button type="submit" value="approve" className="button primary" disabled={pending}>
                Approve take
              </button>
            )}
            <button type="submit" value="reject" className="button danger" disabled={pending}>
              Reject take
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Block({ projectId, productionId, slotId, shot }: { projectId: string; productionId: string; slotId: string; shot: Shot }) {
  const [reason, setReason] = useState("");
  const { run, result, pending, issue } = useAction(setBlockedAction);
  if (shot.approvedTakeId) return null;
  return shot.blockedReason ? (
    <div className="actions">
      <Result result={result} />
      <button type="button" className="button" disabled={pending} onClick={() => run(projectId, productionId, slotId, null)}>
        Unblock shot
      </button>
    </div>
  ) : (
    <details>
      <summary className="small">Can&apos;t be produced? Mark it blocked</summary>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run(projectId, productionId, slotId, reason);
        }}
      >
        <Result result={result} />
        <Field label="Why is this shot blocked?" required value={reason} onChange={setReason} error={issue("reason")} />
        <button type="submit" className="button danger" disabled={pending}>
          Mark blocked
        </button>
      </form>
    </details>
  );
}

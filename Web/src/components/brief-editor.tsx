"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { saveAndApproveAction, saveDraftAction } from "@/app/(dashboard)/projects/actions";
import {
  BRIEF_SECTIONS,
  ConstraintCategory,
  DESIRED_ACTION_LABELS,
  DesiredActionKind,
  evaluateDraft,
  type BriefIssue,
  type BriefSectionKey,
  type ClientBriefDraft,
} from "@/domain/client-brief";
import { DELIVERY_MODE_LABELS, DeliveryMode, includesCinematic, includesConventional } from "@/domain/project";
import { slugify } from "@/lib/slug";

type Props = {
  projectId: string;
  briefId: string;
  version: number;
  initialDraft: ClientBriefDraft;
  savedAt: string;
  approvedVersion: number | null;
};

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; message: string; issues: BriefIssue[] };

const timeFmt = new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" });

export function BriefEditor({ projectId, briefId, version, initialDraft, savedAt, approvedVersion }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<ClientBriefDraft>(initialDraft);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "saved", at: savedAt });
  const [showErrors, setShowErrors] = useState(false);
  const [pending, startTransition] = useTransition();
  const summaryRef = useRef<HTMLDivElement>(null);

  // Same function the server uses to decide approval, so the checklist here
  // and the server's verdict cannot disagree.
  const { completeness } = useMemo(() => evaluateDraft(draft), [draft]);
  const errorFor = (path: string) =>
    showErrors ? completeness.issues.find((i) => i.path === path)?.message : undefined;

  // Leaving with unsaved edits loses them; say so.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Every change goes through here: it hands over a fresh copy to mutate.
  const edit = (fn: (d: ClientBriefDraft) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
    if (status.kind !== "saving") setStatus({ kind: "idle" });
  };

  const save = () =>
    startTransition(async () => {
      setStatus({ kind: "saving" });
      const result = await saveDraftAction(projectId, briefId, draft);
      if (result.ok) {
        setDirty(false);
        setStatus({ kind: "saved", at: result.data.updatedAt });
      } else {
        setStatus({ kind: "error", message: result.message, issues: result.issues });
      }
    });

  const approve = () => {
    if (!completeness.complete) {
      setShowErrors(true);
      setStatus({ kind: "idle" });
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    startTransition(async () => {
      setStatus({ kind: "saving" });
      const result = await saveAndApproveAction(projectId, briefId, draft);
      if (result.ok) {
        setDirty(false);
        router.refresh();
      } else {
        // Approval runs after a successful save, so edits may be persisted even
        // when approval fails; the message says which.
        setShowErrors(true);
        setStatus({ kind: "error", message: result.message, issues: result.issues });
        if (result.message.startsWith("Your edits were saved")) setDirty(false);
        requestAnimationFrame(() => summaryRef.current?.focus());
      }
    });
  };

  const mode = draft.deliveryMode;
  const visible = (key: BriefSectionKey) =>
    key === "cinematic"
      ? mode !== null && includesCinematic(mode)
      : key === "pages"
        ? mode === null || includesConventional(mode)
        : true;
  const sectionIssues = completeness.sections.filter((s) => s.applicable && !s.complete);

  return (
    <div className="grid grid-main-side">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        aria-describedby="brief-help"
      >
        <p id="brief-help" className="visually-hidden">
          Fields marked with an asterisk are required before the brief can be approved. Drafts can be saved at any time.
        </p>

        <div ref={summaryRef} tabIndex={-1}>
          {status.kind === "error" && (
            <div className="alert error" role="alert">
              {status.message}
              {status.issues.length > 0 && (
                <ul>
                  {status.issues.slice(0, 8).map((i) => (
                    <li key={i.path + i.message}>
                      {i.path}: {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {showErrors && !completeness.complete && status.kind !== "error" && (
            <div className="alert error" role="alert">
              The brief cannot be approved yet. Complete these sections:
              <ul>
                {sectionIssues.map((s) => (
                  <li key={s.key}>
                    <a href={`#section-${s.key}`}>{s.label}</a> – {s.issues[0]?.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <Section id="deliverable" title="Deliverable" required>
          <fieldset aria-describedby={errorFor("deliveryMode") ? "deliveryMode-error" : undefined}>
            <legend className="label required">What are we delivering?</legend>
            <div className="choice-group" style={{ marginTop: "0.5rem" }}>
              {DeliveryMode.options.map((m) => (
                <label key={m} className="choice">
                  <input
                    type="radio"
                    name="deliveryMode"
                    value={m}
                    checked={mode === m}
                    onChange={() => edit((d) => void (d.deliveryMode = m))}
                  />
                  <span>
                    <strong>{DELIVERY_MODE_LABELS[m]}</strong>
                    <span className="hint muted small" style={{ display: "block" }}>
                      {m === "conventional" && "Pages, content and forms. No AI video."}
                      {m === "cinematic" && "A video-led interactive journey on its own."}
                      {m === "combined" && "A website with a cinematic journey built in."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <FieldError id="deliveryMode-error" message={errorFor("deliveryMode")} />
          </fieldset>
        </Section>

        <Section id="business" title="Business">
          <div className="two-col">
            <TextInput
              label="Industry"
              required
              value={draft.industry}
              onChange={(v) => edit((d) => void (d.industry = v))}
              error={errorFor("industry")}
              placeholder="e.g. Wedding planning"
            />
            <TextInput
              label="Current website URL"
              type="url"
              value={draft.websiteUrl}
              onChange={(v) => edit((d) => void (d.websiteUrl = v))}
              error={errorFor("websiteUrl")}
              hint="Leave blank if there is none."
              placeholder="https://"
            />
          </div>
          <TextArea
            label="Project summary"
            required
            value={draft.summary}
            onChange={(v) => edit((d) => void (d.summary = v))}
            error={errorFor("summary")}
            hint="What the client does, why they need this now, and what success looks like."
          />
        </Section>

        <Section id="audiences" title="Target audiences" required>
          <Rows
            items={draft.audiences}
            itemName="audience"
            emptyText="No audiences yet."
            onAdd={() => edit((d) => void d.audiences.push({ name: "", description: "" }))}
            onRemove={(i) => edit((d) => void d.audiences.splice(i, 1))}
            error={errorFor("audiences")}
            render={(a, i) => (
              <div className="row cols-2">
                <TextInput
                  label={`Audience ${i + 1}`}
                  value={a.name}
                  onChange={(v) => edit((d) => void (d.audiences[i].name = v))}
                  error={errorFor(`audiences.${i}.name`)}
                  placeholder="e.g. Couples planning a destination wedding"
                />
                <TextInput
                  label="What they need"
                  value={a.description}
                  onChange={(v) => edit((d) => void (d.audiences[i].description = v))}
                  error={errorFor(`audiences.${i}.description`)}
                />
              </div>
            )}
          />
        </Section>

        <Section id="objectives" title="Business objectives" required>
          <Rows
            items={draft.objectives}
            itemName="objective"
            emptyText="No objectives yet."
            onAdd={() =>
              edit((d) => void d.objectives.push({ statement: "", priority: d.objectives.length ? "secondary" : "primary" }))
            }
            onRemove={(i) => edit((d) => void d.objectives.splice(i, 1))}
            error={errorFor("objectives")}
            render={(o, i) => (
              <div className="row cols-2">
                <Select
                  label="Priority"
                  value={o.priority}
                  options={[
                    ["primary", "Primary"],
                    ["secondary", "Secondary"],
                  ]}
                  onChange={(v) => edit((d) => void (d.objectives[i].priority = v as "primary" | "secondary"))}
                />
                <TextInput
                  label={`Objective ${i + 1}`}
                  value={o.statement}
                  onChange={(v) => edit((d) => void (d.objectives[i].statement = v))}
                  error={errorFor(`objectives.${i}.statement`)}
                  placeholder="e.g. 30 qualified enquiries a month"
                />
              </div>
            )}
          />
        </Section>

        {visible("pages") && (
          <Section id="pages" title="Required pages" required>
            <Rows
              items={draft.requiredPages}
              itemName="page"
              emptyText="No pages yet."
              onAdd={() => edit((d) => void d.requiredPages.push({ slug: "", title: "", purpose: "" }))}
              onRemove={(i) => edit((d) => void d.requiredPages.splice(i, 1))}
              error={errorFor("requiredPages")}
              render={(p, i) => (
                <div className="row cols-3">
                  <TextInput
                    label={`Page ${i + 1} title`}
                    value={p.title}
                    onChange={(v) => edit((d) => void (d.requiredPages[i].title = v))}
                    onBlur={() => {
                      // Suggest a slug from the title, but never overwrite one.
                      if (!p.slug.trim() && p.title.trim()) edit((d) => void (d.requiredPages[i].slug = slugify(p.title)));
                    }}
                    error={errorFor(`requiredPages.${i}.title`)}
                    placeholder="e.g. Our work"
                  />
                  <TextInput
                    label="Slug"
                    value={p.slug}
                    onChange={(v) => edit((d) => void (d.requiredPages[i].slug = v))}
                    error={errorFor(`requiredPages.${i}.slug`)}
                    hint="Lowercase and hyphens."
                    placeholder="our-work"
                  />
                  <TextInput
                    label="Purpose"
                    value={p.purpose}
                    onChange={(v) => edit((d) => void (d.requiredPages[i].purpose = v))}
                    error={errorFor(`requiredPages.${i}.purpose`)}
                  />
                </div>
              )}
            />
          </Section>
        )}

        <Section id="actions" title="Desired actions" required>
          <p className="small muted">What should a visitor do? WF-09 builds forms and conversion tracking from this list.</p>
          <Rows
            items={draft.desiredActions}
            itemName="action"
            emptyText="No actions yet."
            onAdd={() => edit((d) => void d.desiredActions.push({ kind: "lead_form", description: "" }))}
            onRemove={(i) => edit((d) => void d.desiredActions.splice(i, 1))}
            error={errorFor("desiredActions")}
            render={(a, i) => (
              <div className="row cols-2">
                <Select
                  label={`Action ${i + 1}`}
                  value={a.kind}
                  options={DesiredActionKind.options.map((k) => [k, DESIRED_ACTION_LABELS[k]])}
                  onChange={(v) => edit((d) => void (d.desiredActions[i].kind = v as DesiredActionKind))}
                />
                <TextInput
                  label="Details"
                  value={a.description}
                  onChange={(v) => edit((d) => void (d.desiredActions[i].description = v))}
                  error={errorFor(`desiredActions.${i}.description`)}
                  placeholder="e.g. Enquiry form with date and guest count"
                />
              </div>
            )}
          />
        </Section>

        <Section id="references" title="Reference websites">
          <p className="small muted">Sites the client likes, or competitors to study. WF-02 captures each one.</p>
          <Rows
            items={draft.referenceUrls}
            itemName="reference"
            emptyText="No references yet. Optional."
            onAdd={() => edit((d) => void d.referenceUrls.push({ url: "", note: "" }))}
            onRemove={(i) => edit((d) => void d.referenceUrls.splice(i, 1))}
            render={(r, i) => (
              <div className="row cols-2">
                <TextInput
                  label={`Reference ${i + 1} URL`}
                  type="url"
                  value={r.url}
                  onChange={(v) => edit((d) => void (d.referenceUrls[i].url = v))}
                  error={errorFor(`referenceUrls.${i}.url`)}
                  placeholder="https://"
                />
                <TextInput
                  label="What to take from it"
                  value={r.note}
                  onChange={(v) => edit((d) => void (d.referenceUrls[i].note = v))}
                />
              </div>
            )}
          />
        </Section>

        {visible("cinematic") && (
          <Section id="cinematic" title="Cinematic journey" required>
            <FieldError message={errorFor("cinematic")} />
            <TextArea
              label="Journey intent"
              required
              value={draft.cinematic.intent}
              onChange={(v) => edit((d) => void (d.cinematic.intent = v))}
              error={errorFor("cinematic.intent")}
              hint="What the visitor should experience and feel, and where the journey should lead them."
            />
            <div className="two-col">
              <TextInput
                label="Target runtime (seconds)"
                required
                type="number"
                value={draft.cinematic.targetRuntimeSeconds === null ? "" : String(draft.cinematic.targetRuntimeSeconds)}
                onChange={(v) =>
                  edit((d) => {
                    const n = Number.parseInt(v, 10);
                    d.cinematic.targetRuntimeSeconds =
                      v.trim() === "" || Number.isNaN(n) ? null : Math.max(0, Math.min(1800, n));
                  })
                }
                error={errorFor("cinematic.targetRuntimeSeconds")}
                hint="Across the main path, 10 – 1800."
              />
              <div className="field">
                <span className="label">Branching</span>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={draft.cinematic.branching}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      edit((d) => void (d.cinematic.branching = checked));
                    }}
                  />
                  <span>Visitors choose between paths</span>
                </label>
              </div>
            </div>
          </Section>
        )}

        <Section id="constraints" title="Constraints">
          <div className="two-col">
            <LocalesInput
              value={draft.constraints.locales}
              onChange={(locales) => edit((d) => void (d.constraints.locales = locales))}
              error={
                showErrors
                  ? completeness.issues.find((i) => i.path === "constraints.locales" || i.path.startsWith("constraints.locales."))
                      ?.message
                  : undefined
              }
            />
            <TextInput
              label="Launch date"
              type="date"
              value={draft.constraints.launchDate}
              onChange={(v) => edit((d) => void (d.constraints.launchDate = v))}
              error={errorFor("constraints.launchDate")}
              hint="Optional."
            />
          </div>
          <Rows
            items={draft.constraints.items}
            itemName="constraint"
            emptyText="No other constraints recorded."
            onAdd={() => edit((d) => void d.constraints.items.push({ category: "brand", detail: "" }))}
            onRemove={(i) => edit((d) => void d.constraints.items.splice(i, 1))}
            render={(c, i) => (
              <div className="row cols-2">
                <Select
                  label={`Constraint ${i + 1}`}
                  value={c.category}
                  options={ConstraintCategory.options.map((k) => [k, k[0].toUpperCase() + k.slice(1)])}
                  onChange={(v) => edit((d) => void (d.constraints.items[i].category = v as ConstraintCategory))}
                />
                <TextInput
                  label="Detail"
                  value={c.detail}
                  onChange={(v) => edit((d) => void (d.constraints.items[i].detail = v))}
                  error={errorFor(`constraints.items.${i}.detail`)}
                  placeholder="e.g. Must not use the old green logo"
                />
              </div>
            )}
          />
        </Section>

        <div className="save-bar">
          <span className="save-status" role="status" aria-live="polite">
            {status.kind === "saving" && "Saving…"}
            {status.kind === "saved" && !dirty && `All changes saved · ${timeFmt.format(new Date(status.at))}`}
            {status.kind === "idle" && dirty && "Unsaved changes"}
            {status.kind === "error" && "Not saved – see the message above"}
          </span>
          <div className="actions">
            <button type="submit" className="button" disabled={pending || !dirty}>
              Save draft
            </button>
            <button type="button" className="button primary" disabled={pending} onClick={approve}>
              Approve version {version}
            </button>
          </div>
        </div>
      </form>

      <aside className="card sticky-side" aria-labelledby="completeness-heading">
        <h2 id="completeness-heading">Completeness · {completeness.percent}%</h2>
        <ul className="checklist">
          {BRIEF_SECTIONS.filter((s) => visible(s.key)).map((s) => {
            const complete = completeness.sections.find((x) => x.key === s.key)?.complete;
            return (
              <li key={s.key}>
                <a href={`#section-${s.key}`}>{s.label}</a>
                {complete ? <span className="badge ok">Complete</span> : <span className="badge warn">Incomplete</span>}
              </li>
            );
          })}
        </ul>
        <p className="small muted" style={{ marginTop: "0.75rem" }}>
          {approvedVersion
            ? `Version ${approvedVersion} remains the approved brief until this version is approved.`
            : "Approving freezes this version and makes it available to the next workflows."}
        </p>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------ form pieces

function Section({ id, title, required, children }: { id: string; title: string; required?: boolean; children: ReactNode }) {
  return (
    <section className="card" id={`section-${id}`} aria-labelledby={`section-${id}-title`} style={{ scrollMarginTop: "1rem" }}>
      <h2 id={`section-${id}-title`} className={required ? "required" : undefined}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id}>
      {message}
    </p>
  );
}

type InputProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  type?: "text" | "url" | "date" | "number";
};

function TextInput({ label, value, onChange, onBlur, error, hint, required, placeholder, type = "text" }: InputProps) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
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
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        inputMode={type === "number" ? "numeric" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function TextArea({ label, value, onChange, error, hint, required }: Omit<InputProps, "type" | "placeholder" | "onBlur">) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
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
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
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

// Edited as text ("en-IN, hi-IN") but stored as a list. The text is kept
// locally so typing a comma is not reformatted mid-keystroke.
function LocalesInput({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <TextInput
      label="Languages"
      required
      value={text}
      onChange={(v) => {
        setText(v);
        onChange(v.split(",").map((s) => s.trim()).filter(Boolean));
      }}
      error={error}
      hint="Language tags, comma-separated. The first is the default, e.g. en-IN, hi-IN."
    />
  );
}

function Rows<T>({
  items,
  render,
  onAdd,
  onRemove,
  itemName,
  emptyText,
  error,
}: {
  items: T[];
  render: (item: T, i: number) => ReactNode;
  onAdd: () => void;
  onRemove: (i: number) => void;
  itemName: string;
  emptyText: string;
  error?: string;
}) {
  return (
    <div>
      {items.length === 0 ? (
        <p className="small muted">{emptyText}</p>
      ) : (
        <div className="rows">
          {items.map((item, i) => (
            // Rows have no stable id; index keys are correct here because a
            // removal re-renders every row below it from the new draft.
            <div key={i} className="row-wrap">
              {render(item, i)}
              <button
                type="button"
                className="button link danger small"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${itemName} ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <FieldError message={error} />
      <button type="button" className="button" onClick={onAdd} style={{ marginTop: "0.75rem" }}>
        Add {itemName}
      </button>
    </div>
  );
}

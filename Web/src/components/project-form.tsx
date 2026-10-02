"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

type Props = {
  action: (prev: unknown, formData: FormData) => Promise<ActionResult<unknown>>;
  initial?: { name: string; clientName: string };
  submitLabel: string;
  pendingLabel: string;
  successMessage?: string;
};

// Used for both creating a project and editing its details. On create the
// action redirects, so only failures come back here.
//
// Submitted from onSubmit rather than the form's action prop: React resets a
// form after every action, failed ones included, and that reset reaches the
// DOM even for controlled fields - a failed submit would wipe what was typed.
export function ProjectForm({ action, initial, submitLabel, pendingLabel, successMessage }: Props) {
  const [state, setState] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState({ name: initial?.name ?? "", clientName: initial?.clientName ?? "" });
  const set = (field: keyof typeof values) => (v: string) => setValues((x) => ({ ...x, [field]: v }));
  const issue = (field: string) => (state && !state.ok ? state.issues.find((i) => i.path === field)?.message : undefined);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(async () => setState(await action(state, data)));
      }}
    >
      {state && !state.ok && (
        <p className="alert error" role="alert">
          {state.message}
        </p>
      )}
      {state?.ok && successMessage && (
        <p className="alert success" role="status">
          {successMessage}
        </p>
      )}
      <Field name="clientName" label="Client or business name" value={values.clientName} onChange={set("clientName")} error={issue("clientName")} hint="As the client refers to their business, e.g. Anaïs Events." />
      <Field name="name" label="Project name" value={values.name} onChange={set("name")} error={issue("name")} hint="What this engagement is called internally, e.g. Anaïs website 2026." />
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint: string;
}) {
  const id = `project-${name}`;
  return (
    <div className="field">
      <label htmlFor={id} className="required">
        {label}
      </label>
      <span className="hint" id={`${id}-hint`}>
        {hint}
      </span>
      <input
        id={id}
        name={name}
        type="text"
        required
        maxLength={160}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
      />
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

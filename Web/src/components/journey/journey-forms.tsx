"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createJourneyAction, reviseJourneyAction } from "@/app/(dashboard)/projects/journey-actions";
import { useAction } from "../use-action";
import { Field, Pick } from "../content/section-fields";

export function CreateJourneyForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [v, setV] = useState({ name: "", start: "branching" });
  const { run, result, pending } = useAction(createJourneyAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(projectId, v);
        if (r.ok) router.push(`/projects/${projectId}/journeys/${r.data}`);
      }}
    >
      <h2>New journey</h2>
      {result && !result.ok && <p className="alert error" role="alert">{result.message}</p>}
      <Field label="Name" required value={v.name} onChange={(name) => setV({ ...v, name })} />
      <Pick
        label="Start from"
        value={v.start}
        options={[
          ["branching", "Branching template: opening, choice, two paths, conversion, ending"],
          ["linear", "Linear template: opening, story, conversion, ending"],
          ["sample", "Complete sample journey (an architecture studio's site visit)"],
        ]}
        onChange={(start) => setV({ ...v, start })}
      />
      <p className="small muted">Templates come with the structure in place and the production details to fill in. Goals are prefilled from the brief&apos;s cinematic intent.</p>
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Creating…" : "Create journey"}
      </button>
    </form>
  );
}

export function ReviseJourneyButton({ projectId, journeyId, nextVersion }: { projectId: string; journeyId: string; nextVersion: number }) {
  const { run, result, pending } = useAction(reviseJourneyAction);
  return (
    <div>
      {result && !result.ok && <p className="alert error" role="alert">{result.message}</p>}
      <button type="button" className="button primary" disabled={pending} onClick={() => run(projectId, journeyId)}>
        Start revision (version {nextVersion})
      </button>
    </div>
  );
}

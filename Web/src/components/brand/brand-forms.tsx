"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBrandAction, reviseBrandAction } from "@/app/(dashboard)/projects/brand-actions";
import { useAction } from "../use-action";

export function CreateBrandForm({ projectId, suggestedName }: { projectId: string; suggestedName: string }) {
  const router = useRouter();
  const [name, setName] = useState(suggestedName);
  const { run, result, pending } = useAction(createBrandAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(projectId, name);
        if (r.ok) router.push(`/projects/${projectId}/brands/${r.data}`);
      }}
    >
      <h2>New brand</h2>
      {result && !result.ok && <p className="alert error" role="alert">{result.message}</p>}
      <div className="field">
        <label htmlFor="brand-name" className="required">
          Brand name
        </label>
        <span className="hint">A project can hold several, e.g. a parent brand and a sub-brand.</span>
        <input id="brand-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </div>
      <button type="submit" className="button primary" disabled={pending}>
        {pending ? "Creating…" : "Create brand"}
      </button>
    </form>
  );
}

export function ReviseBrandButton({ projectId, brandId, nextVersion }: { projectId: string; brandId: string; nextVersion: number }) {
  const { run, result, pending } = useAction(reviseBrandAction);
  return (
    <div>
      {result && !result.ok && <p className="alert error" role="alert">{result.message}</p>}
      <button type="button" className="button primary" disabled={pending} onClick={() => run(projectId, brandId)}>
        Start revision (version {nextVersion})
      </button>
    </div>
  );
}

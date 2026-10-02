"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reviseBriefAction } from "@/app/(dashboard)/projects/actions";

export function ReviseButton({ projectId, nextVersion }: { projectId: string; nextVersion: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button"
        title="Only if the approved brief has to change. The approved version stays in force until the new one is approved."
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await reviseBriefAction(projectId);
            if (result.ok) router.refresh();
            else setError(result.message);
          })
        }
      >
        {pending ? "Opening…" : `Start revision (version ${nextVersion})`}
      </button>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";

// Runs a Server Action from an event handler (not a form's action prop, whose
// automatic reset would wipe a failed form - see project-form.tsx), keeps its
// result for display, and refreshes server data only after a success.
export function useAction<A extends unknown[], T>(action: (...args: A) => Promise<ActionResult<T>>) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<T> | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (...args: A) =>
    new Promise<ActionResult<T>>((resolve) =>
      startTransition(async () => {
        const r = await action(...args);
        setResult(r);
        if (r.ok) router.refresh();
        resolve(r);
      }),
    );
  const issue = (path: string) => (result && !result.ok ? result.issues.find((i) => i.path === path)?.message : undefined);
  return { run, result, pending, issue, reset: () => setResult(null) };
}

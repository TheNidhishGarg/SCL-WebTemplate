import type { BriefIssue } from "@/domain/client-brief";

// What every WF-01 Server Action returns. The UI shows success only on
// ok: true, which the action sets only after the write has committed.
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; message: string; issues: BriefIssue[] };

type KnownError = { name: string; message: string; code?: string; issues?: BriefIssue[] };

// Turns a thrown error into a result the UI can show. Expected errors (bad
// input, conflicts, missing records, access) pass their own message through;
// anything else - a locked database, a full disk - is logged with a reference
// and reported generically, without internals.
export async function toActionResult<T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const err = e as KnownError;
    if (err?.name === "StoreError" || err?.name === "AccessDeniedError") {
      return { ok: false, message: err.message, issues: err.issues ?? [] };
    }
    const ref = Math.random().toString(36).slice(2, 10);
    console.error(`[wf-01] unexpected failure ref=${ref}`, e);
    return { ok: false, message: `Not saved: something went wrong on the server (ref ${ref}). Try again.`, issues: [] };
  }
}

import "server-only";
import type { BriefIssue } from "@/domain/client-brief";

// Shared error mapping for WF-01 Route Handlers: the same messages the
// dashboard shows, as JSON with a matching status. Never internals.
//
// Matched by name, not instanceof: the production bundle can hold more than
// one copy of a class across chunks, and instanceof then fails silently
// (an expected 422 came back as a 500 before this was changed).
type Known = { name?: string; message: string; code?: string; issues?: BriefIssue[] };

export function errorResponse(e: unknown): Response {
  const err = e as Known;
  if (err?.name === "AccessDeniedError") return Response.json({ error: err.message }, { status: 403 });
  if (err?.name === "StoreError") {
    const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 422;
    return Response.json({ error: err.message, issues: err.issues ?? [] }, { status });
  }
  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[wf-01] unexpected failure ref=${ref}`, e);
  return Response.json({ error: `Something went wrong on the server (ref ${ref}).` }, { status: 500 });
}

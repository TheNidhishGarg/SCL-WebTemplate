import type { BriefIssue } from "@/domain/client-brief";

// Expected failures a store method reports to its caller: bad input, a
// conflict with the current state, or a missing record. Callers match on
// `name`, not instanceof (see src/server/http.ts).
export class StoreError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid",
    message: string,
    readonly issues: BriefIssue[] = [],
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const issuesFrom = (error: { issues: { path: PropertyKey[]; message: string }[] }): BriefIssue[] =>
  error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));

export const now = () => new Date().toISOString();

export type Row = Record<string, unknown>;

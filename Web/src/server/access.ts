import "server-only";
import { getEnv } from "@/server/env";

// The dashboard has no sign-in yet (docs/wf-01.md, "Before deployment").
// Until it does, it serves only in development, or where someone has
// explicitly declared the deployment private. Every page, Server Action and
// Route Handler that touches project data calls this first: Server Actions
// are reachable by direct POST, so guarding the layout alone is not enough.

export class AccessDeniedError extends Error {
  constructor() {
    super("The dashboard is not available on this deployment: no sign-in is configured.");
    this.name = "AccessDeniedError";
  }
}

export function requireDashboardAccess(): void {
  const env = getEnv();
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return;
  if (env.DASHBOARD_ALLOW_UNAUTHENTICATED) return;
  throw new AccessDeniedError();
}

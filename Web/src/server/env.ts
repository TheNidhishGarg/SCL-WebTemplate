import "server-only";
import { parseEnv, type IntegrationName, type ParsedEnv } from "@/lib/env-schema";

// The only place application code reads process.env. The server-only import
// makes any accidental client-side import a build error, so secrets cannot be
// bundled for the browser.

let cached: ParsedEnv | undefined;

export function getEnv(): ParsedEnv {
  if (cached) return cached;
  const result = parseEnv(process.env);
  if (!result.ok) {
    throw new Error(`Invalid environment configuration:\n  - ${result.errors.join("\n  - ")}`);
  }
  cached = result.env;
  return cached;
}

// For feature code: check before calling a provider, and fall back to the
// documented manual path when it is off.
export function isIntegrationEnabled(name: IntegrationName): boolean {
  return getEnv().integrations[name];
}

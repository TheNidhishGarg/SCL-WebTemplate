import "server-only";
import { isAbsolute, join } from "node:path";
import { requireDashboardAccess } from "@/server/access";
import { getEnv } from "@/server/env";
import { openDatabase } from "./db";
import { createStore, type Store } from "./store";
import { runwayProvider, veoProvider } from "@/server/production/providers";

export { StoreError } from "./store";
export type { ActivityItem, ProjectDetail, Store } from "./store";

// One store per server process. Kept on globalThis because dev-mode hot reload
// re-evaluates modules, and a second SQLite handle per reload leaks.
const g = globalThis as typeof globalThis & { __sclStore?: Store };

export function getStore(): Store {
  if (g.__sclStore) return g.__sclStore;
  const { SCL_DATA_DIR, integrations, values } = getEnv();
  const dataDir = isAbsolute(SCL_DATA_DIR) ? SCL_DATA_DIR : join(/*turbopackIgnore: true*/ process.cwd(), SCL_DATA_DIR);
  g.__sclStore = createStore(openDatabase(join(dataDir, "scl.sqlite")), join(dataDir, "uploads"), {
    // Real provider calls only when the provider's whole env group is valid (src/lib/env-schema.ts).
    providers: {
      runway: runwayProvider(integrations.runway ? values.RUNWAYML_API_SECRET : undefined),
      veo: veoProvider(integrations.veo ? values.GEMINI_API_KEY : undefined),
    },
  });
  return g.__sclStore;
}

// What pages, Server Actions and Route Handlers use. Layouts and pages render
// in parallel in the App Router, so the layout's access check cannot stop a
// page from reading data; checking at the point of access does.
export function getDashboardStore(): Store {
  requireDashboardAccess();
  return getStore();
}

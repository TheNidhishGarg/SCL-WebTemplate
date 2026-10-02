import "server-only";
import { isAbsolute, join } from "node:path";
import { resolveSarHome } from "@/server/integrations/sar-runner";
import { getEnv } from "@/server/env";
import { getStore } from "@/server/store";
import { StoreError } from "@/server/store/errors";
import { createPreviewManager, type PreviewManager } from "./preview-manager";

// One preview manager per server process (on globalThis for dev hot reloads).
// It cleans up abandoned previews once, on first use.
const g = globalThis as typeof globalThis & { __sclPreviews?: PreviewManager };

export function getPreviewManager(): PreviewManager {
  if (g.__sclPreviews) return g.__sclPreviews;
  const env = getEnv();
  const dataDir = isAbsolute(env.SCL_DATA_DIR) ? env.SCL_DATA_DIR : join(/*turbopackIgnore: true*/ process.cwd(), env.SCL_DATA_DIR);
  const manager = createPreviewManager(
    {
      mode: env.PREVIEW_MODE ?? (env.NODE_ENV === "development" ? "local" : "off"),
      root: join(dataDir, "template-workspaces"),
      hostScript: join(process.cwd(), "scripts", "preview-host.mjs"),
      sarHome: resolveSarHome(env),
      portMin: env.PREVIEW_PORT_MIN,
      portMax: env.PREVIEW_PORT_MAX,
      maxRunning: env.PREVIEW_MAX_RUNNING,
      idleMs: env.PREVIEW_IDLE_MINUTES * 60_000,
      // Only the dashboard (on this machine, or at APP_BASE_URL) may frame a preview.
      frameAncestors: ["http://localhost:*", "http://127.0.0.1:*", new URL(env.APP_BASE_URL).origin].join(" "),
    },
    { registry: getStore().templatePreviews },
  );
  g.__sclPreviews = manager;
  void manager.cleanup().catch((e) => console.error("[previews] cleanup failed", e));
  return manager;
}

// The template job behind a preview, checked against the project, and
// whether it may be edited: WF-03's authority rule - a study-only source is
// analysed, never reused, so its preview is read-only.
export function previewContext(projectId: string, jobId: string) {
  const store = getStore();
  const job = store.templateJobs.get(projectId, jobId);
  if (!job.artifact) throw new StoreError("conflict", "This generation has no stored template to preview.");
  let basis: string = job.authority;
  if (job.sourceId) {
    try {
      basis = store.sources.get(projectId, job.sourceId).source.authorization.basis;
    } catch {
      /* source removed: fall back to the authority declared at generation */
    }
  }
  const editable = basis !== "study_only";
  return {
    job,
    editable,
    editReason: editable ? null : "This template comes from a study-only source: it can be previewed, not edited (WF-03: analysed, never reused). Change the source's authority to edit it.",
    zip: () => store.templateJobs.readArtifact(job),
  };
}

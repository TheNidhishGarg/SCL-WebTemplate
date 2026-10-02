"use server";

import { revalidatePath } from "next/cache";
import { toActionResult } from "@/lib/action-result";
import { getEnv } from "@/server/env";
import { getDashboardStore, StoreError } from "@/server/store";

// Dashboard side of a SaveAllResources capture. The page talks to the
// extension; these create, watch and end the job on the server.

export async function startCaptureAction(projectId: string, input: { url: string; maxPages: number }) {
  return toActionResult(() => {
    const store = getDashboardStore();
    const env = getEnv();
    if (!env.integrations.saveAllResources) throw new StoreError("conflict", "SaveAllResources capture is not configured on this server (SAR_EXTENSION_ID, SAR_UPLOAD_ORIGIN). Use ZIP import.");
    const { job, message } = store.sarCaptures.start(projectId, input, env.values.SAR_UPLOAD_ORIGIN);
    revalidatePath("/projects", "layout");
    return { jobId: job.id, referenceId: job.referenceId, message };
  });
}

export async function captureStatusAction(projectId: string, jobId: string) {
  return toActionResult(() => getDashboardStore().sarCaptures.get(projectId, jobId));
}

export async function abandonCaptureAction(projectId: string, jobId: string, reason: string) {
  return toActionResult(() => getDashboardStore().sarCaptures.abandon(projectId, jobId, reason));
}

export async function cancelCaptureAction(projectId: string, jobId: string) {
  return toActionResult(() => getDashboardStore().sarCaptures.cancel(projectId, jobId));
}

"use server";

import { revalidatePath } from "next/cache";
import { toActionResult } from "@/lib/action-result";
import { getTemplatePipeline } from "@/server/pipeline";
import { publicTemplateJob } from "@/server/pipeline/public-job";
import { getDashboardStore } from "@/server/store";

// Website template generation (URL -> SaveAllResources -> WF pipeline). The
// work happens in the background pipeline; these start, watch and stop it.
// getDashboardStore() is the access check, as for every dashboard action.

export async function startTemplateAction(projectId: string, input: { url: string; authority: string; authorizedBy: string; maxPages: string; maxDepth: string }) {
  const result = await toActionResult(async () => {
    getDashboardStore();
    return publicTemplateJob(await getTemplatePipeline().start(projectId, input));
  });
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
}

export async function templateJobAction(projectId: string, jobId: string) {
  return toActionResult(() => {
    getDashboardStore();
    return publicTemplateJob(getTemplatePipeline().get(projectId, jobId));
  });
}

export async function cancelTemplateAction(projectId: string, jobId: string) {
  return toActionResult(() => {
    getDashboardStore();
    return publicTemplateJob(getTemplatePipeline().cancel(projectId, jobId));
  });
}

export async function retryTemplateAction(projectId: string, jobId: string) {
  const result = await toActionResult(() => {
    getDashboardStore();
    return publicTemplateJob(getTemplatePipeline().retry(projectId, jobId));
  });
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
}

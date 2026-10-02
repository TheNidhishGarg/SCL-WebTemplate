"use server";

import { revalidatePath } from "next/cache";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getDashboardStore } from "@/server/store";

const done = async <T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> => {
  const result = await toActionResult(fn);
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
};

// Job results are returned as stored after the provider call, so the UI shows
// what was recorded, never an optimistic guess.
const jobView = (j: { status: string; error: { message: string } | null }) => ({ status: j.status, error: j.error?.message ?? null });

export async function startProductionAction(projectId: string, journeyId: string) {
  return done(() => getDashboardStore().production.start(projectId, journeyId));
}
export async function addPromptAction(projectId: string, productionId: string, slotId: string, input: { positive: string; negative: string; note: string }) {
  return done(() => getDashboardStore().production.addPrompt(projectId, productionId, slotId, input));
}
export async function previewRequestAction(projectId: string, productionId: string, slotId: string, provider: "runway" | "veo") {
  return toActionResult(() => getDashboardStore().production.preview(projectId, productionId, slotId, provider));
}
export async function generateAction(projectId: string, productionId: string, slotId: string, provider: string, allowRepeat: boolean) {
  return done(async () => jobView(await getDashboardStore().production.generate(projectId, productionId, slotId, provider, { allowRepeat })));
}
export async function pollJobAction(projectId: string, productionId: string, jobId: string) {
  return done(async () => jobView(await getDashboardStore().production.poll(projectId, productionId, jobId)));
}
export async function retryJobAction(projectId: string, productionId: string, jobId: string) {
  return done(async () => jobView(await getDashboardStore().production.retry(projectId, productionId, jobId)));
}
export async function cancelJobAction(projectId: string, productionId: string, jobId: string) {
  return done(() => jobView(getDashboardStore().production.cancel(projectId, productionId, jobId)));
}
export async function reviewTakeAction(projectId: string, productionId: string, takeId: string, input: { decision: string; note: string; confirmations: Record<string, boolean> }) {
  return done(() => getDashboardStore().production.review(projectId, productionId, takeId, input));
}
export async function setBlockedAction(projectId: string, productionId: string, slotId: string, reason: string | null) {
  return done(() => getDashboardStore().production.setBlocked(projectId, productionId, slotId, reason));
}

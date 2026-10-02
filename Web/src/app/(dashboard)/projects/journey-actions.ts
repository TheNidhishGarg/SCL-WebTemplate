"use server";

import { revalidatePath } from "next/cache";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getDashboardStore } from "@/server/store";

const done = async <T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> => {
  const result = await toActionResult(fn);
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
};

export async function createJourneyAction(projectId: string, input: { name: string; start: string }) {
  return done(() => getDashboardStore().journeys.create(projectId, input).id);
}
export async function saveJourneyAction(projectId: string, journeyId: string, versionId: string, content: unknown) {
  return done(() => ({ updatedAt: getDashboardStore().journeys.saveDraft(projectId, journeyId, versionId, content).updatedAt }));
}
export async function approveJourneyAction(projectId: string, journeyId: string, versionId: string, content: unknown) {
  return done(() => {
    const s = getDashboardStore().journeys;
    s.saveDraft(projectId, journeyId, versionId, content);
    return { version: s.approve(projectId, journeyId, versionId).version };
  });
}
export async function reviseJourneyAction(projectId: string, journeyId: string) {
  return done(() => ({ version: getDashboardStore().journeys.revise(projectId, journeyId).version }));
}

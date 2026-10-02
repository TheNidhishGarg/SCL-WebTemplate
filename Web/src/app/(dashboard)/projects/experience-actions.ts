"use server";

import { revalidatePath } from "next/cache";
import { toActionResult } from "@/lib/action-result";
import { getDashboardStore } from "@/server/store";

export async function publishJourneyAction(projectId: string, journeyId: string) {
  const r = await toActionResult(() => getDashboardStore().experience.publish(projectId, journeyId).number);
  if (r.ok) revalidatePath("/", "layout");
  return r;
}
export async function withdrawJourneyAction(projectId: string, journeyId: string) {
  const r = await toActionResult(() => getDashboardStore().experience.withdraw(projectId, journeyId));
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

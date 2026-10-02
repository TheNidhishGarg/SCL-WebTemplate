"use server";

import { revalidatePath } from "next/cache";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getDashboardStore } from "@/server/store";

// WF-04 Server Actions. Brand configurations are small JSON documents, well
// under the 1 MB Server Action limit.

const done = async <T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> => {
  const result = await toActionResult(fn);
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
};

export async function createBrandAction(projectId: string, name: string) {
  return done(() => getDashboardStore().brands.create(projectId, { name }).id);
}
export async function saveBrandAction(projectId: string, brandId: string, versionId: string, content: unknown) {
  return done(() => ({ updatedAt: getDashboardStore().brands.saveDraft(projectId, brandId, versionId, content).updatedAt }));
}
export async function suggestBrandAction(projectId: string, brandId: string, versionId: string) {
  return done(() => getDashboardStore().brands.suggest(projectId, brandId, versionId));
}
export async function approveBrandAction(projectId: string, brandId: string, versionId: string, content: unknown) {
  return done(() => {
    const store = getDashboardStore().brands;
    store.saveDraft(projectId, brandId, versionId, content);
    return { version: store.approve(projectId, brandId, versionId).version };
  });
}
export async function reviseBrandAction(projectId: string, brandId: string) {
  return done(() => ({ version: getDashboardStore().brands.revise(projectId, brandId).version }));
}

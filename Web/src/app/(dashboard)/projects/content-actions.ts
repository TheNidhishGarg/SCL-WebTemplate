"use server";

import { revalidatePath } from "next/cache";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getDashboardStore } from "@/server/store";

// WF-05 Server Actions. Revalidating the whole tree also refreshes /preview
// and /site, so a saved edit shows on the next render.
const done = async <T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> => {
  const result = await toActionResult(fn);
  if (result.ok) revalidatePath("/", "layout");
  return result;
};

export async function updateSiteAction(projectId: string, input: unknown) {
  return done(() => void getDashboardStore().content.updateSite(projectId, input));
}
export async function generatePagesAction(projectId: string) {
  return done(() => getDashboardStore().content.generateFromBrief(projectId));
}
export async function createPageAction(projectId: string, input: { title: string; slug: string }) {
  return done(() => getDashboardStore().content.createPage(projectId, input).id);
}
export async function savePageAction(projectId: string, pageId: string, revision: number, content: unknown) {
  return done(() => {
    const p = getDashboardStore().content.savePage(projectId, pageId, revision, content);
    return { revision: p.revision };
  });
}
export async function transitionPageAction(projectId: string, pageId: string, action: "submit" | "approve" | "return" | "publish" | "unpublish") {
  return done(() => ({ status: getDashboardStore().content.transition(projectId, pageId, action).status }));
}
export async function movePageAction(projectId: string, pageId: string, direction: -1 | 1) {
  return done(() => getDashboardStore().content.movePage(projectId, pageId, direction));
}
export async function deletePageAction(projectId: string, pageId: string) {
  return done(() => getDashboardStore().content.deletePage(projectId, pageId));
}
export async function saveBlockAction(projectId: string, blockId: string | null, input: unknown) {
  return done(() => getDashboardStore().content.saveBlock(projectId, blockId, input));
}
export async function deleteBlockAction(projectId: string, blockId: string) {
  return done(() => getDashboardStore().content.deleteBlock(projectId, blockId));
}

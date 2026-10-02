"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { evaluateDraft, type BriefCompleteness } from "@/domain/client-brief";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getTemplatePipeline } from "@/server/pipeline";
import { getDashboardStore } from "@/server/store";

// Server Actions for WF-01. Each checks access, delegates to the store, and
// reports what actually happened: ok only after the write commits.

const refresh = () => revalidatePath("/projects", "layout");

const projectFields = (formData: FormData) => ({
  name: String(formData.get("name") ?? ""),
  clientName: String(formData.get("clientName") ?? ""),
});

export async function createProjectAction(_prev: unknown, formData: FormData): Promise<ActionResult<string>> {
  const result = await toActionResult(() => {
    return getDashboardStore().createProject(projectFields(formData)).id;
  });
  if (!result.ok) return result;
  refresh();
  redirect(`/projects/${result.data}/brief`);
}

export async function updateProjectAction(projectId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await toActionResult(() => {
    getDashboardStore().updateProject(projectId, projectFields(formData));
    return undefined;
  });
  if (result.ok) refresh();
  return result;
}

export type SavedBrief = { briefId: string; version: number; updatedAt: string; completeness: BriefCompleteness };

export async function saveDraftAction(projectId: string, briefId: string, draft: unknown): Promise<ActionResult<SavedBrief>> {
  const result = await toActionResult(() => {
    const brief = getDashboardStore().saveDraft(projectId, briefId, draft);
    return {
      briefId: brief.id,
      version: brief.version,
      updatedAt: brief.updatedAt,
      completeness: evaluateDraft(brief.draft).completeness,
    };
  });
  if (result.ok) refresh();
  return result;
}

// Saves first, then approves, in two commits: if approval is refused the
// edits are still kept, and the result says which step failed.
export async function saveAndApproveAction(
  projectId: string,
  briefId: string,
  draft: unknown,
): Promise<ActionResult<{ version: number }>> {
  const saved = await saveDraftAction(projectId, briefId, draft);
  if (!saved.ok) return saved;
  const result = await toActionResult(() => {
    return { version: getDashboardStore().approveBrief(projectId, briefId).version };
  });
  if (!result.ok) return { ...result, message: `Your edits were saved, but the brief was not approved. ${result.message}` };
  // A website-template pipeline waiting for brief approval (WF-05) may now continue.
  try {
    getTemplatePipeline().advanceProject(projectId);
  } catch (e) {
    console.error("[template-pipeline] could not continue after brief approval", e);
  }
  refresh();
  return result;
}

export async function reviseBriefAction(projectId: string): Promise<ActionResult<{ version: number }>> {
  const result = await toActionResult(() => {
    return { version: getDashboardStore().reviseBrief(projectId).version };
  });
  if (result.ok) refresh();
  return result;
}

export async function addAssetUrlAction(projectId: string, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await toActionResult(() => {
    getDashboardStore().addAssetUrl(projectId, {
      kind: formData.get("kind"),
      label: String(formData.get("label") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      url: String(formData.get("url") ?? "").trim(),
    });
    return undefined;
  });
  if (result.ok) refresh();
  return result;
}

export async function removeAssetAction(projectId: string, assetId: string): Promise<ActionResult> {
  const result = await toActionResult(() => {
    getDashboardStore().removeAsset(projectId, assetId);
    return undefined;
  });
  if (result.ok) refresh();
  return result;
}

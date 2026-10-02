"use server";

import { toActionResult } from "@/lib/action-result";
import { getPreviewManager, previewContext } from "@/server/preview";
import { getDashboardStore, StoreError } from "@/server/store";

// Live template previews. getDashboardStore() is the access check; every
// action checks the template job belongs to the project (previewContext).

const ctx = (projectId: string, jobId: string) => {
  getDashboardStore();
  return previewContext(projectId, jobId);
};
const editableOnly = (c: ReturnType<typeof previewContext>) => {
  if (!c.editable) throw new StoreError("conflict", c.editReason!);
};

export async function previewStatusAction(projectId: string, jobId: string) {
  return toActionResult(() => {
    ctx(projectId, jobId);
    return getPreviewManager().status(jobId);
  });
}

export async function startPreviewAction(projectId: string, jobId: string) {
  return toActionResult(async () => {
    const c = ctx(projectId, jobId);
    const m = getPreviewManager();
    m.ensureWorkspace(jobId, c.zip);
    return m.start(jobId, projectId);
  });
}

export async function stopPreviewAction(projectId: string, jobId: string) {
  return toActionResult(async () => {
    ctx(projectId, jobId);
    return getPreviewManager().stop(jobId);
  });
}

export async function restartPreviewAction(projectId: string, jobId: string) {
  return toActionResult(async () => {
    const c = ctx(projectId, jobId);
    const m = getPreviewManager();
    m.ensureWorkspace(jobId, c.zip);
    return m.restart(jobId, projectId);
  });
}

export async function saveTemplateBrandAction(projectId: string, jobId: string, input: { name: string; colors: Record<string, string>; fonts: Record<string, string> }) {
  return toActionResult(() => {
    const c = ctx(projectId, jobId);
    editableOnly(c);
    getPreviewManager().saveBrand(jobId, input);
  });
}

export async function saveTemplatePageAction(projectId: string, jobId: string, pageId: string, input: { title: string; description: string; fields: Record<string, string> }) {
  return toActionResult(() => {
    const c = ctx(projectId, jobId);
    editableOnly(c);
    getPreviewManager().savePageContent(jobId, pageId, input);
  });
}

export async function resetTemplateAction(projectId: string, jobId: string) {
  return toActionResult(async () => {
    const c = ctx(projectId, jobId);
    editableOnly(c);
    await getPreviewManager().reset(jobId, c.zip);
  });
}

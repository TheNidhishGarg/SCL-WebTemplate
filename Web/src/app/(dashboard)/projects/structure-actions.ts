"use server";

import { toActionResult } from "@/lib/action-result";
import { getPreviewManager, previewContext } from "@/server/preview";
import { getDashboardStore, StoreError } from "@/server/store";

// Template structure: composition (reorder, duplicate, insert, remove,
// restore, merge, split, exclude), design-token overrides, undo/reprocess and
// Web's checks. getDashboardStore() is the access check; previewContext checks
// the template job belongs to the project. A study-only template is read-only.

const ctx = (projectId: string, jobId: string, edit: boolean) => {
  getDashboardStore();
  const c = previewContext(projectId, jobId);
  if (edit && !c.editable) throw new StoreError("conflict", c.editReason!);
  getPreviewManager().ensureWorkspace(jobId, c.zip);
  return c;
};

export async function applyTemplateOperationAction(projectId: string, jobId: string, operation: unknown) {
  return toActionResult(() => {
    ctx(projectId, jobId, true);
    const rec = getPreviewManager().applyOperation(jobId, operation);
    return { warnings: rec.warnings };
  });
}

export async function undoTemplateOperationAction(projectId: string, jobId: string, index: number) {
  return toActionResult(async () => {
    const c = ctx(projectId, jobId, true);
    if (!Number.isInteger(index) || index < 0) throw new StoreError("invalid", "Invalid override.");
    const r = await getPreviewManager().replay(jobId, projectId, c.zip, index);
    return { restored: r.restored, failed: r.failed.map((f) => `${f.op}: ${f.error}`) };
  });
}

export async function reprocessTemplateAction(projectId: string, jobId: string) {
  return toActionResult(async () => {
    const c = ctx(projectId, jobId, true);
    const r = await getPreviewManager().replay(jobId, projectId, c.zip, null);
    return { restored: r.restored, failed: r.failed.map((f) => `${f.op}: ${f.error}`) };
  });
}

export async function verifyTemplateAction(projectId: string, jobId: string) {
  return toActionResult(() => {
    ctx(projectId, jobId, false);
    const v = getPreviewManager().verify(jobId);
    return { summary: v.summary, build: v.build };
  });
}

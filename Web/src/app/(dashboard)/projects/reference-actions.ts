"use server";

import { revalidatePath } from "next/cache";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getDashboardStore } from "@/server/store";

// WF-02 Server Actions. Each goes through getDashboardStore(), which checks
// access first, and returns ok only after the write has committed. Uploads
// go through the captures Route Handler instead (Server Action bodies are
// capped at 1 MB).

const done = async <T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> => {
  const result = await toActionResult(fn);
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
};

export async function addReferenceAction(projectId: string, input: { url: string; label: string; pageType: string }) {
  return done(() => getDashboardStore().references.add(projectId, input).id);
}

export async function importReferencesAction(projectId: string) {
  return done(() => getDashboardStore().references.importFromBrief(projectId));
}

export async function updateReferenceAction(
  projectId: string,
  referenceId: string,
  input: { label: string; pageType: string; targetPages: string[]; attribution: string },
) {
  return done(() => void getDashboardStore().references.update(projectId, referenceId, input));
}

export async function removeReferenceAction(projectId: string, referenceId: string) {
  return done(() => getDashboardStore().references.remove(projectId, referenceId));
}

export async function runCheckAction(projectId: string, referenceId: string) {
  return done(async () => {
    const a = await getDashboardStore().references.runCheck(projectId, referenceId);
    return { outcome: a.outcome };
  });
}

export async function recordFailedAttemptAction(projectId: string, referenceId: string, input: { outcome: string; detail: string }) {
  return done(() => getDashboardStore().references.recordFailedAttempt(projectId, referenceId, input));
}

export async function setManualAction(projectId: string, referenceId: string, reason: string | null) {
  return done(() => getDashboardStore().references.setManual(projectId, referenceId, reason === null ? null : { reason }));
}

export async function removeCaptureAction(projectId: string, referenceId: string, captureId: string) {
  return done(() => getDashboardStore().references.removeCapture(projectId, referenceId, captureId));
}

type ObservationFields = { aspect: string; basis: string; text: string; captureId: string | null };

export async function addObservationAction(projectId: string, referenceId: string, input: ObservationFields) {
  return done(() => void getDashboardStore().references.addObservation(projectId, referenceId, input));
}

export async function updateObservationAction(projectId: string, referenceId: string, observationId: string, input: ObservationFields) {
  return done(() => void getDashboardStore().references.updateObservation(projectId, referenceId, observationId, input));
}

export async function removeObservationAction(projectId: string, referenceId: string, observationId: string) {
  return done(() => getDashboardStore().references.removeObservation(projectId, referenceId, observationId));
}

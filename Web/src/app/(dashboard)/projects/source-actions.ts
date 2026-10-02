"use server";

import { revalidatePath } from "next/cache";
import { toActionResult, type ActionResult } from "@/lib/action-result";
import { getTemplatePipeline } from "@/server/pipeline";
import { getDashboardStore } from "@/server/store";

// WF-03 Server Actions. Uploads (source archives, findings files) go through
// Route Handlers; Server Action bodies are capped at 1 MB.

const done = async <T>(fn: () => T | Promise<T>): Promise<ActionResult<T>> => {
  const result = await toActionResult(fn);
  if (result.ok) revalidatePath("/projects", "layout");
  return result;
};

type AuthInput = { basis: string; note: string; license: string };

export async function registerFromCaptureAction(projectId: string, referenceId: string, captureId: string, input: { label: string; authorization: AuthInput }) {
  return done(() => getDashboardStore().sources.registerFromCapture(projectId, referenceId, captureId, { ...input, originUrl: "", originRef: "" }).id);
}

export async function updateAuthorizationAction(projectId: string, sourceId: string, input: AuthInput) {
  return done(() => {
    getDashboardStore().sources.updateAuthorization(projectId, sourceId, input);
    // A website-template pipeline waiting on this authority (WF-04) may now continue.
    continuePipelines(projectId);
  });
}

function continuePipelines(projectId: string) {
  try {
    getTemplatePipeline().advanceProject(projectId);
  } catch (e) {
    console.error("[template-pipeline] could not continue after an authority change", e);
  }
}

export async function removeSourceAction(projectId: string, sourceId: string) {
  return done(() => getDashboardStore().sources.remove(projectId, sourceId));
}

export async function runScanAction(projectId: string, sourceId: string) {
  return done(() => {
    const s = getDashboardStore().sources.runScan(projectId, sourceId);
    return { digest: s.digest };
  });
}

export async function acceptCandidateAction(projectId: string, sourceId: string, candidateKey: string) {
  return done(() => void getDashboardStore().sources.acceptCandidate(projectId, sourceId, candidateKey));
}

export async function removeTemplateAction(projectId: string, templateId: string) {
  return done(() => getDashboardStore().sources.removeTemplate(projectId, templateId));
}

export async function extractTemplateAction(projectId: string, templateId: string) {
  return done(() => {
    const t = getDashboardStore().sources.extractTemplate(projectId, templateId);
    return { workspacePath: t.extraction.workspacePath };
  });
}

export async function recordBuildAction(projectId: string, templateId: string, input: { status: string; note: string }) {
  return done(() => void getDashboardStore().sources.recordBuild(projectId, templateId, input));
}

export async function addFindingAction(projectId: string, sourceId: string, input: { basis: string; topic: string; statement: string; evidencePath: string; evidenceLine: string }) {
  return done(() => getDashboardStore().sources.addFinding(projectId, sourceId, input));
}

export async function addQuestionAction(projectId: string, sourceId: string, text: string) {
  return done(() => getDashboardStore().sources.addQuestion(projectId, sourceId, text));
}

export async function resolveQuestionAction(projectId: string, sourceId: string, questionId: string, answer: string) {
  return done(() => getDashboardStore().sources.resolveQuestion(projectId, sourceId, questionId, answer));
}

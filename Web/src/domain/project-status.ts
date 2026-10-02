import type { Asset } from "./asset";
import { evaluateDraft, type ClientBrief } from "./client-brief";
import { includesCinematic, includesConventional, type Project } from "./project";

// A project's stage is derived from its persisted brief, never stored
// separately, so it cannot drift from the records it describes.

export type ProjectStage =
  | "archived"
  | "brief_in_progress" // no approved brief yet; the draft is incomplete
  | "brief_ready" // no approved brief yet; the draft is complete and can be approved
  | "brief_approved" // latest version approved; downstream modules can start
  | "brief_revision"; // an approved brief exists and a newer draft is being edited

export const STAGE_LABELS: Record<ProjectStage, string> = {
  archived: "Archived",
  brief_in_progress: "Brief in progress",
  brief_ready: "Brief ready to approve",
  brief_approved: "Brief approved",
  brief_revision: "Brief being revised",
};

export type NextAction = { label: string; href: string };

export type ProjectSummary = {
  stage: ProjectStage;
  percent: number;
  // The brief everything downstream should use; null until one is approved.
  approvedVersion: number | null;
  nextActions: NextAction[];
};

export type ReferenceCounts = { total: number; failed: number };

export function summariseProject(
  project: Project,
  latest: ClientBrief,
  approvedVersion: number | null,
  assets: Pick<Asset, "kind">[],
  references: ReferenceCounts = { total: 0, failed: 0 },
): ProjectSummary {
  const base = `/projects/${project.id}`;
  if (project.status === "archived") {
    return { stage: "archived", percent: 100, approvedVersion, nextActions: [] };
  }

  const isDraft = latest.status === "draft";
  const { completeness } = evaluateDraft(latest.draft);
  const stage: ProjectStage = !isDraft
    ? "brief_approved"
    : approvedVersion !== null
      ? "brief_revision"
      : completeness.complete
        ? "brief_ready"
        : "brief_in_progress";

  const actions: NextAction[] = [];
  if (isDraft) {
    const missing = completeness.sections.filter((s) => s.applicable && !s.complete);
    if (missing.length) {
      actions.push({ label: `Complete the brief: ${missing.map((s) => s.label.toLowerCase()).join(", ")}`, href: `${base}/brief` });
    } else {
      actions.push({ label: `Approve brief version ${latest.version}`, href: `${base}/brief` });
    }
  }
  if (!assets.some((a) => a.kind === "logo")) {
    actions.push({ label: "Add the client's logo to the asset register", href: `${base}/assets` });
  }
  if (!isDraft && latest.content) {
    // What becomes possible once a brief is approved. These modules do not
    // exist yet; the links point at the handoff they will consume.
    if (includesConventional(latest.content.deliveryMode) && references.total === 0) {
      actions.push({ label: "Start WF-02: build the reference library from the approved brief", href: `${base}/references` });
    }
    if (includesCinematic(latest.content.deliveryMode)) {
      actions.push({ label: "Start WF-06 cinematic journey planning with the approved brief", href: `${base}#handoff-heading` });
    }
  }

  // Not tied to approval: references can be collected before the brief is final.
  if (references.failed > 0) {
    const n = references.failed;
    actions.push({ label: `${n} reference${n === 1 ? "" : "s"} failed acquisition: recover or record manually`, href: `${base}/references?status=failed` });
  }

  return { stage, percent: isDraft ? completeness.percent : 100, approvedVersion, nextActions: actions };
}

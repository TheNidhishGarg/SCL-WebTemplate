import { STAGE_LABELS, type ProjectStage } from "@/domain/project-status";

const tone: Record<ProjectStage, string> = {
  archived: "",
  brief_in_progress: "warn",
  brief_ready: "warn",
  brief_approved: "ok",
  brief_revision: "warn",
};

export function StageBadge({ stage }: { stage: ProjectStage }) {
  return <span className={`badge ${tone[stage]}`}>{STAGE_LABELS[stage]}</span>;
}

export function Progress({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

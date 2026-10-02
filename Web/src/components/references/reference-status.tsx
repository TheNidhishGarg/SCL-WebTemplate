import { STATUS_LABELS, type ReferenceStatus } from "@/domain/reference";

const tone: Record<ReferenceStatus, string> = { pending: "", checked: "", captured: "ok", failed: "danger", manual: "warn" };

export function ReferenceStatusBadge({ status }: { status: ReferenceStatus }) {
  return <span className={`badge ${tone[status]}`}>{STATUS_LABELS[status]}</span>;
}

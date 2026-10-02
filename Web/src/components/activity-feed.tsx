import Link from "next/link";
import { formatDateTime } from "./format";

export function ActivityFeed({
  items,
  showProject = false,
}: {
  items: { id: string; projectId: string; projectName: string; summary: string; createdAt: string }[];
  showProject?: boolean;
}) {
  if (items.length === 0) return <p className="muted small">No activity yet.</p>;
  return (
    <ul className="feed">
      {items.map((a) => (
        <li key={a.id}>
          {a.summary}
          {showProject && (
            <>
              {" · "}
              <Link href={`/projects/${a.projectId}`}>{a.projectName}</Link>
            </>
          )}
          <time dateTime={a.createdAt}>{formatDateTime(a.createdAt)}</time>
        </li>
      ))}
    </ul>
  );
}

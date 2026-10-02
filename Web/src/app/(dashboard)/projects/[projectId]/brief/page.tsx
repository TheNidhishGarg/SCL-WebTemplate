import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BriefEditor } from "@/components/brief-editor";
import { BriefView } from "@/components/brief-view";
import { formatDateTime } from "@/components/format";
import { ReviseButton } from "@/components/revise-button";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Client brief · SCL Web" };

export default async function BriefPage({ params }: PageProps<"/projects/[projectId]/brief">) {
  const { projectId } = await params;
  const detail = getDashboardStore().getProject(projectId);
  if (!detail) notFound();
  const { project, latest, approved } = detail;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${project.id}`}>{project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Client brief</h1>
          <p className="muted">
            {project.clientName} · version {latest.version}{" "}
            {latest.status === "draft"
              ? "(draft)"
              : `(approved ${latest.approvedAt ? formatDateTime(latest.approvedAt) : ""})`}
          </p>
        </div>
        {latest.status !== "draft" && (
          <div className="actions">
            {/* The next step after approval; a revision is only for changing the brief. */}
            <Link className="button primary" href={`/projects/${project.id}#generate`}>
              Next: generate a website template
            </Link>
            <ReviseButton projectId={project.id} nextVersion={latest.version + 1} />
          </div>
        )}
      </div>

      {latest.status === "draft" ? (
        // Keyed by brief id so a new version starts from fresh editor state.
        <BriefEditor
          key={latest.id}
          projectId={project.id}
          briefId={latest.id}
          version={latest.version}
          initialDraft={latest.draft}
          savedAt={latest.updatedAt}
          approvedVersion={approved?.version ?? null}
        />
      ) : latest.content ? (
        <>
          <p className="alert success" role="status">
            This version is approved and frozen. It is what WF-02 to WF-10 receive.{" "}
            <Link href={`/projects/${project.id}#handoff-heading`}>See the handoff</Link>.
          </p>
          <BriefView content={latest.content} />
        </>
      ) : null}
    </>
  );
}

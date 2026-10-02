import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TemplatePreview } from "@/components/projects/template-preview";
import { getPreviewManager, previewContext } from "@/server/preview";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Template preview · SCL Web" };

// A generated website template: live preview, brand and content editing.
export default async function TemplatePreviewPage({ params }: PageProps<"/projects/[projectId]/templates/[jobId]">) {
  const { projectId, jobId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  let c;
  try {
    c = previewContext(projectId, jobId);
  } catch {
    notFound();
  }
  const m = getPreviewManager();
  const availability = m.availability();
  let workspace = null;
  let workspaceError: string | null = null;
  try {
    workspace = m.ensureWorkspace(jobId, c.zip);
  } catch (e) {
    workspaceError = (e as Error).message;
  }
  const editable = workspace && workspace.strategy === "static-sar" ? m.editable(jobId) : null;
  let structure = null;
  if (workspace && workspace.strategy === "static-sar") {
    try {
      structure = m.structure(jobId);
    } catch (e) {
      workspaceError = `The template's structure could not be read: ${(e as Error).message}`;
    }
  }
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Template preview</h1>
          <p className="muted">
            {c.job.sourceUrl} · generated {new Date(c.job.createdAt).toLocaleString()} · {c.editable ? "editable" : "read-only (study only)"}
          </p>
        </div>
      </div>
      {workspaceError && (
        <p className="alert error" role="alert">
          {workspaceError}
        </p>
      )}
      {workspace && (
        <TemplatePreview
          projectId={projectId}
          jobId={jobId}
          mode={m.mode}
          availability={availability}
          workspace={workspace}
          editable={editable}
          canEdit={c.editable}
          editReason={c.editReason}
          initialStatus={m.status(jobId)}
          structure={structure}
        />
      )}
    </>
  );
}

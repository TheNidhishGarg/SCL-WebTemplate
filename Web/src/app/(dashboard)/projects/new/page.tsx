import type { Metadata } from "next";
import Link from "next/link";
import { ProjectForm } from "@/components/project-form";
import { createProjectAction } from "../actions";

export const metadata: Metadata = { title: "New project · SCL Web" };

export default function NewProjectPage() {
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>New project</h1>
          <p className="muted">Name the project, then fill in the client brief. The brief saves as a draft as you go.</p>
        </div>
      </div>
      <div className="card" style={{ maxWidth: "36rem" }}>
        <ProjectForm action={createProjectAction} submitLabel="Create project and start brief" pendingLabel="Creating…" />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { formatDateTime } from "@/components/format";
import { Progress, StageBadge } from "@/components/status";
import { DELIVERY_MODE_LABELS } from "@/domain/project";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Projects · SCL Web" };

export default function ProjectsPage() {
  const store = getDashboardStore();
  const projects = store.listProjects();
  const activity = store.listActivity(12);

  if (projects.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Projects</h1>
        </div>
        <div className="card empty">
          <h2>No projects yet</h2>
          <p className="muted">
            A project starts with the client brief: who the client is, what the site must do, which pages it needs, and
            whether it includes a cinematic journey. Everything after WF-01 works from that brief.
          </p>
          <Link className="button primary" href="/projects/new">
            Create the first project
          </Link>
        </div>
      </>
    );
  }

  const count = (stages: string[]) => projects.filter((p) => stages.includes(p.summary.stage)).length;
  const nextActions = projects
    .filter((p) => p.summary.nextActions.length > 0)
    .slice(0, 8)
    .map((p) => ({ project: p.project, action: p.summary.nextActions[0] }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">Client briefs and their progress towards handoff.</p>
        </div>
        <Link className="button primary" href="/projects/new">
          New project
        </Link>
      </div>

      <dl className="stats">
        <div className="card stat">
          <dt>Active projects</dt>
          <dd>{projects.filter((p) => p.project.status === "active").length}</dd>
        </div>
        <div className="card stat">
          <dt>Brief in progress</dt>
          <dd>{count(["brief_in_progress", "brief_revision"])}</dd>
        </div>
        <div className="card stat">
          <dt>Ready to approve</dt>
          <dd>{count(["brief_ready"])}</dd>
        </div>
        <div className="card stat">
          <dt>Brief approved</dt>
          <dd>{count(["brief_approved"])}</dd>
        </div>
      </dl>

      <div className="grid grid-main-side">
        <section className="card" aria-labelledby="projects-heading">
          <h2 id="projects-heading">All projects</h2>
          <ul className="project-list">
            {projects.map(({ project, latest, summary }) => (
              <li key={project.id} className="project-row">
                <div>
                  <Link href={`/projects/${project.id}`}>{project.name}</Link>
                  <div className="muted small">{project.clientName}</div>
                </div>
                <div className="small">
                  <StageBadge stage={summary.stage} />
                  <div className="muted" style={{ marginTop: "0.25rem" }}>
                    {latest.draft.deliveryMode ? DELIVERY_MODE_LABELS[latest.draft.deliveryMode] : "Deliverable not set"}
                  </div>
                </div>
                <div className="small muted">Updated {formatDateTime(project.updatedAt)}</div>
                <div>
                  <span className="small muted">{summary.percent}% complete</span>
                  <Progress percent={summary.percent} label={`${project.name} brief completeness`} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="next-heading">
            <h2 id="next-heading">Next actions</h2>
            {nextActions.length === 0 ? (
              <p className="muted small">Nothing waiting. Every brief is approved and has a logo on file.</p>
            ) : (
              <ul className="feed">
                {nextActions.map(({ project, action }) => (
                  <li key={project.id}>
                    <Link href={action.href}>{action.label}</Link>
                    <span className="muted small"> · {project.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="activity-heading">
            <h2 id="activity-heading">Recent activity</h2>
            <ActivityFeed items={activity} showProject />
          </section>
        </div>
      </div>
    </>
  );
}

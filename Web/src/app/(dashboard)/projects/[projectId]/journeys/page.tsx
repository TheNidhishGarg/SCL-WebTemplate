import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/components/format";
import { CreateJourneyForm } from "@/components/journey/journey-forms";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Journeys · SCL Web" };

export default async function JourneysPage({ params }: PageProps<"/projects/[projectId]/journeys">) {
  const { projectId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const journeys = store.journeys.list(projectId);
  const cinematic = detail.approved?.content?.cinematic;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Cinematic journeys</h1>
          <p className="muted">WF-06: plan the journey as a storyboard and scene manifest. No video is needed to plan, review or export.</p>
        </div>
      </div>
      {detail.approved?.content && !cinematic && (
        <p className="alert info small">The approved brief is a conventional website; a journey is optional for this project.</p>
      )}
      <div className="grid grid-main-side">
        <section className="card" aria-labelledby="journeys-heading">
          <h2 id="journeys-heading">Journeys ({journeys.length})</h2>
          {journeys.length === 0 ? (
            <p className="muted">No journeys yet. Start from a template, or from the complete sample to see what a production-ready plan looks like.</p>
          ) : (
            <ul className="log">
              {journeys.map(({ journey, latest, approved, errors }) => (
                <li key={journey.id}>
                  <div className="actions" style={{ justifyContent: "space-between" }}>
                    <Link href={`/projects/${projectId}/journeys/${journey.id}`} style={{ fontWeight: 600 }}>
                      {journey.name}
                    </Link>
                    <span className={`badge ${latest.status === "approved" ? "ok" : "warn"}`}>
                      v{latest.version} {latest.status}
                    </span>
                  </div>
                  <div className="small muted">
                    {latest.content.scenes.length} scenes · {latest.status === "draft" ? `${errors} item(s) to fix` : "approved"}
                    {approved && latest.status === "draft" && ` · v${approved.version} remains approved`} · updated {formatDateTime(journey.updatedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <CreateJourneyForm projectId={projectId} />
        </section>
      </div>
    </>
  );
}

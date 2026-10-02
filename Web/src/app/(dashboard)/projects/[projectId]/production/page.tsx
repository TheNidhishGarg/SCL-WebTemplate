import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/components/format";
import { StartProductionButton } from "@/components/production/production-forms";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Production · SCL Web" };

export default async function ProductionPage({ params }: PageProps<"/projects/[projectId]/production">) {
  const { projectId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const productions = store.production.list(projectId);
  const journeys = store.journeys.list(projectId);
  const startable = journeys.filter((j) => j.approved && !productions.some((p) => p.production.journeyId === j.journey.id && p.production.journeyVersion === j.approved!.version));
  const providers = store.production.providerStatus();
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>Video production</h1>
          <p className="muted">WF-07: produce, check and approve the media each scene of an approved journey needs, before anything is published.</p>
        </div>
      </div>
      <div className="grid grid-main-side">
        <section className="card" aria-labelledby="productions-heading">
          <h2 id="productions-heading">Productions ({productions.length})</h2>
          {productions.length === 0 ? (
            <p className="muted">No productions yet. A production starts from an approved journey version.</p>
          ) : (
            <ul className="log">
              {productions.map(({ production, shots }) => {
                const approved = shots.filter((s) => s.status === "approved").length;
                const blocked = shots.filter((s) => s.status === "blocked").length;
                return (
                  <li key={production.id}>
                    <div className="actions" style={{ justifyContent: "space-between" }}>
                      <Link href={`/projects/${projectId}/production/${production.id}`} style={{ fontWeight: 600 }}>
                        {production.manifest.journey.name} · v{production.journeyVersion}
                      </Link>
                      <span className={`badge ${approved + blocked === shots.length ? "ok" : "warn"}`}>
                        {approved}/{shots.length} approved
                      </span>
                    </div>
                    <div className="small muted">
                      {blocked > 0 && `${blocked} blocked · `}started {formatDateTime(production.createdAt)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <div className="stack">
          <section className="card" aria-labelledby="start-heading">
            <h2 id="start-heading">Start a production</h2>
            {startable.length === 0 ? (
              <p className="small muted">
                {journeys.some((j) => j.approved) ? "Every approved journey version already has a production." : "Approve a journey first."}{" "}
                <Link href={`/projects/${projectId}/journeys`}>Journeys</Link>
              </p>
            ) : (
              startable.map((j) => <StartProductionButton key={j.journey.id} projectId={projectId} journeyId={j.journey.id} label={`${j.journey.name} · v${j.approved!.version}`} />)
            )}
          </section>
          <section className="card" aria-labelledby="providers-heading">
            <h2 id="providers-heading">Providers</h2>
            <ul className="checklist">
              {providers.map((p) => (
                <li key={p.id}>
                  <span>{p.id === "runway" ? "Runway" : "Veo (Gemini API)"}</span>
                  {p.configured ? <span className="badge ok">Configured</span> : <span className="badge warn">Not configured: {p.missingConfig.join(", ")}</span>}
                </li>
              ))}
              <li>
                <span>Flow and other tools</span>
                <span className="badge">Manual upload</span>
              </li>
            </ul>
            <p className="small muted">Flow has no public API; export from Flow and upload the file to the shot.</p>
          </section>
        </div>
      </div>
    </>
  );
}

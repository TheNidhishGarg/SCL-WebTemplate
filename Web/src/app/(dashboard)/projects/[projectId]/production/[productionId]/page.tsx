import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SHOT_LABELS } from "@/domain/production";
import { formatDateTime } from "@/components/format";
import { PublishJourneyButtons } from "@/components/production/experience-panel";
import { ShotPanel } from "@/components/production/production-forms";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Production · SCL Web" };

export default async function ProductionDetailPage({ params }: PageProps<"/projects/[projectId]/production/[productionId]">) {
  const { projectId, productionId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  let data;
  try {
    data = store.production.get(projectId, productionId);
  } catch {
    notFound();
  }
  const { production, shots } = data;
  const providers = store.production.providerStatus();
  const counts = Object.entries(
    shots.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {}),
  );
  const done = shots.filter((s) => s.status === "approved" || s.status === "blocked").length;
  const manifestUrl = `/api/projects/${projectId}/production/${productionId}/asset-manifest`;
  // WF-08: can this journey version go on the website, and what is live now.
  const journeyId = production.journeyId;
  const key = production.manifest.journey.key;
  let assembly: { issues: { level: string; message: string }[]; error: string | null } = { issues: [], error: null };
  try {
    const a = store.experience.assemble(projectId, journeyId, "published");
    assembly = { issues: a.issues, error: a.bundle ? null : "The bundle is not valid." };
  } catch (e) {
    assembly = { issues: [], error: (e as Error).message };
  }
  const releases = store.experience.releases(projectId, journeyId);
  const live = releases.find((r) => !r.withdrawnAt);
  const errors = assembly.issues.filter((i) => i.level === "error");
  const isCurrentVersion = store.journeys.list(projectId).find((j) => j.journey.id === journeyId)?.approved?.version === production.journeyVersion;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link> / <Link href={`/projects/${projectId}/production`}>Production</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>
            {production.manifest.journey.name} · v{production.journeyVersion}
          </h1>
          <p className="muted">
            {done}/{shots.length} shots approved or blocked · {counts.map(([k, n]) => `${n} ${SHOT_LABELS[k as keyof typeof SHOT_LABELS].toLowerCase()}`).join(" · ")}
          </p>
        </div>
        <div className="actions">
          <a className="button" href={manifestUrl}>
            View asset manifest
          </a>
          <a className="button primary" href={`${manifestUrl}?download`}>
            Download for WF-08
          </a>
        </div>
      </div>
      {done < shots.length && <p className="alert info small">Every shot needs an approved take, or to be marked blocked with a reason, before the manifest is ready for WF-08.</p>}
      <section className="card" aria-labelledby="website-heading" style={{ marginBottom: "1rem" }}>
        <h2 id="website-heading">Website (WF-08)</h2>
        {!isCurrentVersion ? (
          <p className="small muted">This production is for version {production.journeyVersion}; the website uses the journey&apos;s current approved version.</p>
        ) : (
          <>
            <p className="small muted">
              Publishing freezes this journey version, its approved media and the published pages it links to into a release the site plays at{" "}
              <code>/journeys/{key}</code>. Blocked shots play as title cards.
            </p>
            {assembly.error && <p className="alert error small">{assembly.error}</p>}
            {assembly.issues.length > 0 && (
              <ul className="checklist small" aria-label="Assembly checks">
                {assembly.issues.map((i, n) => (
                  <li key={n}>
                    <span>{i.message}</span>
                    <span className={`badge ${i.level === "error" ? "danger" : "warn"}`}>{i.level === "error" ? "Blocks publishing" : "Warning"}</span>
                  </li>
                ))}
              </ul>
            )}
            {!assembly.error && errors.length === 0 && <p className="small">Ready to publish.</p>}
            <div className="actions" style={{ marginBottom: "0.75rem" }}>
              <a className="button" href={`/preview/${projectId}/journeys/${key}`}>
                Preview on the site
              </a>
              {live && (
                <a className="button" href={`/site/${projectId}/journeys/${key}`}>
                  View live (release {live.number})
                </a>
              )}
            </div>
            <PublishJourneyButtons projectId={projectId} journeyId={journeyId} ready={!assembly.error && errors.length === 0} live={!!live} />
          </>
        )}
        {releases.length > 0 && (
          <ul className="log small" aria-label="Releases">
            {releases.map((r) => (
              <li key={r.id}>
                Release {r.number} · journey v{r.journeyVersion} · {formatDateTime(r.createdAt)}
                {r.withdrawnAt ? ` · withdrawn ${formatDateTime(r.withdrawnAt)}` : r.id === live?.id ? " · live" : " · superseded"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="stack">
        {production.manifest.scenes.map((scene) => (
          <section key={scene.id} className="card" aria-labelledby={`scene-${scene.id}`}>
            <h2 id={`scene-${scene.id}`}>
              {scene.order + 1}. {scene.title} <span className="small muted">({scene.type}, {scene.durationSeconds}s, {scene.aspectRatio})</span>
            </h2>
            {shots
              .filter((s) => s.scene.id === scene.id)
              .map((s) => (
                <ShotPanel key={s.slotId} projectId={projectId} productionId={productionId} shot={s} providers={providers} />
              ))}
          </section>
        ))}
      </div>
    </>
  );
}

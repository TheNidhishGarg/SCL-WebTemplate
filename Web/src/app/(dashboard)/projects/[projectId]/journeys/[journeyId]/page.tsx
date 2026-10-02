import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/components/format";
import { JourneyEditor } from "@/components/journey/journey-editor";
import { ReviseJourneyButton } from "@/components/journey/journey-forms";
import { SECTION_LABELS } from "@/domain/content";
import { SCENE_TYPE_LABELS } from "@/domain/journey";
import { sceneOrder } from "@/domain/journey-validate";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Journey · SCL Web" };

const IMAGE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

export default async function JourneyPage({ params }: PageProps<"/projects/[projectId]/journeys/[journeyId]">) {
  const { projectId, journeyId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  if (!store.journeys.list(projectId).some((x) => x.journey.id === journeyId)) notFound();
  const { journey, versions, latest, approved } = store.journeys.get(projectId, journeyId);
  const api = `/api/projects/${projectId}/journeys/${journey.id}`;
  const pages = store.content.pages(projectId).map((p) => ({
    id: p.id,
    title: p.content.title,
    sections: p.content.sections.map((s, i) => ({ id: s.id, label: `${i + 1}. ${SECTION_LABELS[s.type]}` })),
  }));
  const images = detail.assets.filter((a) => a.source.type === "upload" && IMAGE.test(a.source.file.filename)).map((a) => ({ id: a.id, label: a.label }));
  const captures = store.references.list(projectId).flatMap((v) => v.captures.filter((c) => c.kind === "screenshot").map((c) => ({ referenceId: v.reference.id, captureId: c.id, label: `${v.reference.label || v.reference.host}: ${c.file.filename}` })));
  const desiredActions = [...new Set(detail.approved?.content?.desiredActions.map((a) => a.kind) ?? [])];

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{detail.project.name}</Link> / <Link href={`/projects/${projectId}/journeys`}>Journeys</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>{journey.name}</h1>
          <p className="muted small">
            <code>{journey.key}</code> · version {latest.version} ({latest.status}) · {latest.content.scenes.length} scenes
          </p>
        </div>
        <div className="actions">
          <a className="button" href={`${api}/scene-manifest?version=latest`} target="_blank" rel="noreferrer">
            Scene manifest (WF-07)
          </a>
          <a className="button" href={`${api}/journey-spec?version=latest`} target="_blank" rel="noreferrer">
            Journey spec (WF-08)
          </a>
        </div>
      </div>

      {latest.status === "draft" ? (
        <JourneyEditor key={latest.id} projectId={projectId} journeyId={journey.id} versionId={latest.id} version={latest.version} initial={latest.content} pages={pages} images={images} captures={captures} desiredActions={desiredActions} />
      ) : (
        <section className="card">
          <p className="alert success" role="status">
            Version {latest.version} is approved and frozen. WF-07 produces from its scene manifest; WF-08 plays it from its journey spec.
          </p>
          <ol className="log small" aria-label="Scenes in playback order">
            {sceneOrder(latest.content).order.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong> <span className="badge">{SCENE_TYPE_LABELS[s.type]}</span> {s.durationSeconds}s. {s.purpose}
              </li>
            ))}
          </ol>
          <ReviseJourneyButton projectId={projectId} journeyId={journey.id} nextVersion={latest.version + 1} />
        </section>
      )}

      <section className="card" aria-labelledby="history-heading" style={{ marginTop: "1rem" }}>
        <h2 id="history-heading">Version history</h2>
        <ol className="log small">
          {versions.map((v) => (
            <li key={v.id}>
              <strong>v{v.version}</strong> {v.status}
              {v.approvedAt && ` · approved ${formatDateTime(v.approvedAt)}`} · <a href={`${api}/scene-manifest?version=${v.version}`}>scene manifest</a> · <a href={`${api}/journey-spec?version=${v.version}`}>journey spec</a>
            </li>
          ))}
        </ol>
        {approved && <p className="small">The approved handoff is version {approved.version}.</p>}
      </section>
    </>
  );
}

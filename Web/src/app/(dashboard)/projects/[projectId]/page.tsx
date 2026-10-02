import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityFeed } from "@/components/activity-feed";
import { formatDateTime } from "@/components/format";
import { ProjectForm } from "@/components/project-form";
import { Progress, StageBadge } from "@/components/status";
import { ASSET_KIND_LABELS, AssetKind } from "@/domain/asset";
import { BRIEF_HANDOFF_SCHEMA } from "@/domain/brief-handoff";
import { evaluateDraft } from "@/domain/client-brief";
import { DELIVERY_MODE_LABELS } from "@/domain/project";
import { GenerateTemplate } from "@/components/projects/generate-template";
import { getTemplatePipeline } from "@/server/pipeline";
import { publicTemplateJob } from "@/server/pipeline/public-job";
import { getDashboardStore } from "@/server/store";
import { updateProjectAction } from "../actions";

type Params = PageProps<"/projects/[projectId]">;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { projectId } = await params;
  const detail = getDashboardStore().getProject(projectId);
  return { title: detail ? `${detail.project.name} · SCL Web` : "Project not found · SCL Web" };
}

export default async function ProjectPage({ params }: Params) {
  const { projectId } = await params;
  const store = getDashboardStore();
  const detail = store.getProject(projectId);
  if (!detail) notFound();
  const { project, latest, approved, assets, summary, referenceCounts } = detail;
  const { completeness } = evaluateDraft(latest.draft);
  const activity = store.listActivity(15, project.id);
  const sources = store.sources.list(project.id);
  const brands = store.brands.list(project.id);
  const pageCount = store.content.pages(project.id).length;
  const journeyCount = store.journeys.list(project.id).length;
  const productionCount = store.production.list(project.id).length;
  const handoffUrl = `/api/projects/${project.id}/handoff`;
  const pipeline = getTemplatePipeline();
  const templateJobs = pipeline.list(project.id).map(publicTemplateJob);
  const mode = (approved?.content ?? latest.draft).deliveryMode;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">
            {project.clientName}
            {mode && ` · ${DELIVERY_MODE_LABELS[mode]}`}
          </p>
        </div>
        <div className="actions">
          <StageBadge stage={summary.stage} />
          <Link className="button primary" href={`/projects/${project.id}/brief`}>
            {latest.status === "draft" ? "Continue brief" : "View brief"}
          </Link>
          <Link className="button" href={`/projects/${project.id}/assets`}>
            Assets ({assets.length})
          </Link>
          <Link className="button" href={`/projects/${project.id}/references`}>
            References ({referenceCounts.total})
          </Link>
          <Link className="button" href={`/projects/${project.id}/sources`}>
            Sources ({sources.length})
          </Link>
          <Link className="button" href={`/projects/${project.id}/brands`}>
            Brand ({brands.length})
          </Link>
          <Link className="button" href={`/projects/${project.id}/pages`}>
            Pages ({pageCount})
          </Link>
          <Link className="button" href={`/projects/${project.id}/journeys`}>
            Journeys ({journeyCount})
          </Link>
          <Link className="button" href={`/projects/${project.id}/production`}>
            Production ({productionCount})
          </Link>
        </div>
      </div>

      {/* The primary action: URL -> SaveAllResources -> website-template.zip -> WF-02 -> WF-03 -> WF-04/WF-05. */}
      <section className="card" id="generate" style={{ marginBottom: "1rem" }}>
        {/* Keyed by the server's view, so fresh server data replaces the client's copy. */}
        <GenerateTemplate key={templateJobs.map((j) => `${j.id}:${j.status}:${j.stage}`).join("|")} projectId={project.id} availability={pipeline.availability()} initial={templateJobs} />
        <p className="small muted">
          Alternatives on the <Link href={`/projects/${project.id}/references`}>References</Link> page: capture with the browser extension, or import an existing SaveAllResources ZIP.
        </p>
      </section>

      <div className="grid grid-main-side">
        <div className="stack">
          <section className="card" aria-labelledby="brief-heading">
            <h2 id="brief-heading">
              Client brief · version {latest.version}{" "}
              <span className="muted small">({latest.status === "draft" ? "draft" : "approved"})</span>
            </h2>
            {latest.status === "draft" ? (
              <>
                <p className="small muted">
                  {completeness.complete
                    ? "Every required section is complete. Approve it to hand it on."
                    : "Sections still to complete before this version can be approved:"}
                </p>
                <Progress percent={summary.percent} label="Brief completeness" />
                <ul className="checklist" style={{ marginTop: "0.75rem" }}>
                  {completeness.sections
                    .filter((s) => s.applicable)
                    .map((s) => (
                      <li key={s.key}>
                        <span>{s.label}</span>
                        {s.complete ? (
                          <span className="badge ok">Complete</span>
                        ) : (
                          <span className="badge warn">
                            {s.issues.length} to fix
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
                {approved && (
                  <p className="alert info small">
                    Version {approved.version} stays approved, and is what downstream modules receive, until this
                    revision is approved.
                  </p>
                )}
              </>
            ) : (
              <p className="small">
                Approved {latest.approvedAt && formatDateTime(latest.approvedAt)}. To change it, open the brief and start a
                revision; this version stays in force until the revision is approved.
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="handoff-heading">
            <h2 id="handoff-heading">Handoff to WF-02 – WF-10</h2>
            {approved ? (
              <>
                <p className="small">
                  Downstream modules receive brief version {approved.version}, approved{" "}
                  {approved.approvedAt && formatDateTime(approved.approvedAt)}, with the asset register as it stands, in
                  the <code>{BRIEF_HANDOFF_SCHEMA}</code> format.
                </p>
                <div className="actions">
                  <a className="button" href={handoffUrl} target="_blank" rel="noreferrer">
                    View handoff JSON
                  </a>
                  <a className="button" href={`${handoffUrl}?download`}>
                    Download
                  </a>
                </div>
              </>
            ) : (
              <p className="small muted">
                Nothing is handed on until a brief version is approved. Downstream modules never receive a draft.
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="references-heading">
            <h2 id="references-heading">Reference library (WF-02)</h2>
            <p className="small">
              {referenceCounts.total === 0
                ? "No references collected yet."
                : `${referenceCounts.total} reference${referenceCounts.total === 1 ? "" : "s"}${referenceCounts.failed ? `, ${referenceCounts.failed} failed acquisition` : ""}.`}
            </p>
            <Link className="button" href={`/projects/${project.id}/references`}>
              Open reference library
            </Link>
          </section>

          <section className="card" aria-labelledby="sources-heading">
            <h2 id="sources-heading">Source analysis (WF-03)</h2>
            <p className="small">
              {sources.length === 0
                ? "No sources registered. Analyse an authorised repository or a captured reference."
                : `${sources.length} source${sources.length === 1 ? "" : "s"}, ${sources.filter((x) => !x.latestScan).length} not analysed · ${sources.reduce((n, x) => n + x.templates, 0)} templates in the manifest · ${sources.reduce((n, x) => n + x.openQuestions, 0)} open questions.`}
            </p>
            <Link className="button" href={`/projects/${project.id}/sources`}>
              Open source analysis
            </Link>
          </section>

          <section className="card" aria-labelledby="brand-heading">
            <h2 id="brand-heading">Brand configuration (WF-04)</h2>
            <p className="small">
              {brands.length === 0
                ? "No brand configured yet."
                : brands.map((x) => `${x.brand.name}: v${x.latest.version} ${x.latest.status}${x.approved ? ` (v${x.approved.version} approved)` : ""}`).join(" · ")}
            </p>
            <Link className="button" href={`/projects/${project.id}/brands`}>
              Open brand configuration
            </Link>
          </section>

          <section className="card" aria-labelledby="assets-heading">
            <h2 id="assets-heading">Asset register</h2>
            {assets.length === 0 ? (
              <p className="small muted">
                No assets recorded. Add the client&apos;s logo, fonts, guidelines and existing photography or video, as
                files or links.
              </p>
            ) : (
              <ul className="checklist">
                {AssetKind.options.map((kind) => {
                  const n = assets.filter((a) => a.kind === kind).length;
                  return (
                    <li key={kind}>
                      <span>{ASSET_KIND_LABELS[kind]}</span>
                      <span className="muted">{n}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <Link className="button" href={`/projects/${project.id}/assets`} style={{ marginTop: "0.75rem" }}>
              Manage assets
            </Link>
          </section>

          <section className="card" aria-labelledby="details-heading">
            <h2 id="details-heading">Project details</h2>
            <ProjectForm
              action={updateProjectAction.bind(null, project.id)}
              initial={{ name: project.name, clientName: project.clientName }}
              submitLabel="Save details"
              pendingLabel="Saving…"
              successMessage="Project details saved."
            />
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="next-heading">
            <h2 id="next-heading">Next actions</h2>
            {sources.some((x) => !x.latestScan) && (
              <p className="small">
                <Link href={`/projects/${project.id}/sources`}>
                  {sources.filter((x) => !x.latestScan).length} source(s) registered but not analysed
                </Link>
              </p>
            )}
            {summary.nextActions.length === 0 ? (
              <p className="small muted">Nothing waiting.</p>
            ) : (
              <ul className="feed">
                {summary.nextActions.map((a) => (
                  <li key={a.label}>
                    <Link href={a.href}>{a.label}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card" aria-labelledby="activity-heading">
            <h2 id="activity-heading">Activity</h2>
            <ActivityFeed items={activity} />
          </section>
        </div>
      </div>
    </>
  );
}

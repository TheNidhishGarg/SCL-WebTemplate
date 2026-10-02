import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBytes, formatDateTime } from "@/components/format";
import { BasisBadge, EvidenceList } from "@/components/sources/evidence";
import {
  AcceptCandidateButton,
  AddFindingForm,
  AddQuestionForm,
  AuthorityForm,
  FindingsImportForm,
  QuestionAnswer,
  RemoveSourceButton,
  RunScanButton,
  TemplateActions,
} from "@/components/sources/source-forms";
import { RiskKind } from "@/domain/source-analysis";
import { AUTHORIZATION_LABELS, BUILD_LABELS, extractionAllowed } from "@/domain/wf03";
import { getDashboardStore } from "@/server/store";

export const metadata: Metadata = { title: "Source · SCL Web" };

const RISK_LABELS: Record<string, string> = { security: "Security", accessibility: "Accessibility", missing_asset: "Missing assets", licensing: "Licensing", dependency: "Dependencies" };
const SEVERITY_TONE: Record<string, string> = { high: "danger", medium: "warn", low: "", info: "" };
// Colours come from untrusted CSS: only plain literals are ever put in a style attribute.
const SAFE_COLOUR = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d.,%\s/]+\))$/i;

export default async function SourcePage({ params }: PageProps<"/projects/[projectId]/sources/[sourceId]">) {
  const { projectId, sourceId } = await params;
  const store = getDashboardStore();
  const project = store.getProject(projectId)?.project;
  if (!project) notFound();
  const detail = store.sources.list(projectId).some((s) => s.source.id === sourceId) ? store.sources.get(projectId, sourceId) : null;
  if (!detail) notFound();
  const { source: s, scans, latest, templates, findings, questions } = detail;
  const a = latest?.analysis;
  const allowed = extractionAllowed(s.authorization.basis);
  const accepted = new Set(templates.map((t) => t.candidateKey).filter(Boolean));
  const api = `/api/projects/${projectId}/sources/${s.id}`;
  const open = questions.filter((q) => q.status === "open");
  const resolved = questions.filter((q) => q.status === "resolved");

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link> / <Link href={`/projects/${project.id}`}>{project.name}</Link> / <Link href={`/projects/${project.id}/sources`}>Sources</Link>
      </nav>
      <div className="page-head">
        <div>
          <h1>{s.label}</h1>
          <p className="muted small" style={{ overflowWrap: "anywhere" }}>
            {s.origin === "reference_capture" ? "WF-02 capture of " : ""}
            {s.originUrl || "origin not recorded"}
            {s.originRef && ` @ ${s.originRef}`} · {s.archive.filename} ({formatBytes(s.archive.sizeBytes)}) · sha256 <code>{s.archive.sha256.slice(0, 16)}…</code>
          </p>
        </div>
        <span className={`badge ${allowed ? "ok" : "warn"}`}>{AUTHORIZATION_LABELS[s.authorization.basis]}</span>
      </div>

      {!allowed && <p className="alert info small">Study only. This source is analysed so the team can learn from it. Nothing is extracted from it, and its code, copy, images and fonts must not appear in client work.</p>}

      <div className="grid grid-main-side">
        <div className="stack">
          <section className="card" aria-labelledby="analysis-heading">
            <h2 id="analysis-heading">Analysis</h2>
            {scans.length === 0 && (
              <p className="small muted">Not analysed yet. The analysis reads the archive and reports what is in it, with the file and line for each finding.</p>
            )}
            {/* One position in the tree, so its result message survives the refresh that follows a run. */}
            <RunScanButton projectId={projectId} sourceId={s.id} label={scans.length ? "Run again" : "Run analysis"} />
            {scans.length > 0 && (
              <>
                <ol className="log small" aria-label="Analysis runs, newest first" style={{ marginTop: "0.75rem" }}>
                  {scans.slice(0, 5).map((sc, i) => (
                    <li key={sc.id}>
                      {formatDateTime(sc.createdAt)} · analyzer {sc.analyzerVersion} · digest <code>{sc.digest.slice(0, 12)}…</code>
                      {scans[i + 1] && <span className="muted"> · {scans[i + 1].digest === sc.digest ? "identical to the previous run" : "differs from the previous run"}</span>}
                    </li>
                  ))}
                </ol>
                <div className="actions" style={{ marginTop: "0.75rem" }}>
                  <a className="button" href={`${api}/report`} target="_blank" rel="noreferrer">
                    Analysis report (JSON)
                  </a>
                  <a className="button" href={`${api}/kit`}>
                    Analysis kit for VS Code
                  </a>
                  <a className="button" href={`${api}/archive`}>
                    Source archive
                  </a>
                </div>
              </>
            )}
          </section>

          {a && (
            <>
              <section className="card" aria-labelledby="overview-heading">
                <h2 id="overview-heading">Overview</h2>
                <p className="small">
                  {a.summary.files} files, {formatBytes(a.summary.totalBytes)}:{" "}
                  {Object.entries(a.summary.byKind)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${n} ${k}`)
                    .join(", ")}
                  {a.rootPrefix && <> · top folder <code>{a.rootPrefix}</code> stripped</>}
                </p>
                {a.skipped.length > 0 && (
                  <details className="small">
                    <summary>{a.skipped.length} not analysed</summary>
                    <ul>
                      {a.skipped.map((x) => (
                        <li key={x.path}>
                          <code>{x.path}</code>: {x.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <h3 style={{ marginTop: "1rem" }}>Framework and tooling</h3>
                {a.frameworks.length === 0 ? (
                  <p className="small muted">None identified. See the open questions.</p>
                ) : (
                  <ul className="log">
                    {a.frameworks.map((f) => (
                      <li key={f.name}>
                        <BasisBadge basis={f.basis} /> <strong>{f.name}</strong> {f.version && <code>{f.version}</code>} <span className="small muted">{f.rationale}</span>
                        <EvidenceList items={f.evidence} max={2} />
                      </li>
                    ))}
                  </ul>
                )}
                <h3 style={{ marginTop: "1rem" }}>Interaction behaviour</h3>
                {a.interactions.length === 0 ? (
                  <p className="small muted">No animation libraries or CSS animation found.</p>
                ) : (
                  <ul className="log">
                    {a.interactions.map((i) => (
                      <li key={i.name}>
                        <BasisBadge basis={i.basis} /> <strong>{i.name}</strong> <span className="small muted">{i.rationale}</span>
                        <EvidenceList items={i.evidence} max={3} />
                      </li>
                    ))}
                  </ul>
                )}
                <h3 style={{ marginTop: "1rem" }}>Responsive behaviour</h3>
                <p className="small">
                  {a.responsive.mediaQueries} media queries, {a.responsive.containerQueries} container queries, {a.responsive.srcsetImages} images with srcset, {a.responsive.pictureElements} picture elements.
                  {a.responsive.pagesWithoutViewportMeta.length > 0 && ` ${a.responsive.pagesWithoutViewportMeta.length} page(s) lack a viewport meta tag.`}
                </p>
                {a.styles.breakpoints.length > 0 && (
                  <p className="small">
                    Breakpoints:{" "}
                    {a.styles.breakpoints.map((b) => (
                      <code key={`${b.feature}${b.px}`} style={{ marginRight: "0.5rem" }}>
                        {b.feature} {b.px}px ×{b.count}
                      </code>
                    ))}
                  </p>
                )}
              </section>

              <section className="card" aria-labelledby="inventory-heading">
                <h2 id="inventory-heading">Routes and components</h2>
                <h3>Routes ({a.routes.length})</h3>
                {a.routes.length === 0 ? (
                  <p className="small muted">No routes found.</p>
                ) : (
                  <ul className="log small">
                    {a.routes.map((r) => (
                      <li key={`${r.route}${r.file}`}>
                        <code>{r.route}</code> ← <code>{r.file}</code> <span className="muted">({r.origin.replace("_", " ")}{r.dynamic ? ", dynamic" : ""})</span>
                      </li>
                    ))}
                  </ul>
                )}
                {a.linkedButMissing.length > 0 && (
                  <p className="small">
                    Linked but not in the source: {a.linkedButMissing.map((l) => <code key={l.href} style={{ marginRight: "0.4rem" }}>{l.href}</code>)}
                  </p>
                )}
                <h3 style={{ marginTop: "1rem" }}>Components ({a.components.length})</h3>
                {a.components.length === 0 ? (
                  <p className="small muted">No component source files. Built or minified scripts do not reveal original components.</p>
                ) : (
                  <ul className="log small">
                    {a.components.map((c) => (
                      <li key={`${c.file}${c.name}`}>
                        <strong>{c.name}</strong> <code>{c.file}</code> <span className="muted">· used by {c.usedBy.length}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card" aria-labelledby="candidates-heading">
                <h2 id="candidates-heading">Template candidates ({a.templateCandidates.length})</h2>
                <p className="small muted">Reusable pieces the analysis found. Each says whether it is observed or inferred, and why. Add the ones worth keeping to the manifest.</p>
                {a.templateCandidates.length === 0 ? (
                  <p className="small muted">None found. Analysts can propose templates through the kit.</p>
                ) : (
                  <ul className="log">
                    {a.templateCandidates.map((c) => (
                      <li key={c.key}>
                        <div className="actions" style={{ justifyContent: "space-between" }}>
                          <span>
                            <span className="badge">{c.kind.replace("_", " ")}</span> <strong>{c.name}</strong> <BasisBadge basis={c.basis} />
                          </span>
                          {accepted.has(c.key) ? <span className="small muted">In manifest</span> : <AcceptCandidateButton projectId={projectId} sourceId={s.id} candidateKey={c.key} name={c.name} />}
                        </div>
                        <div className="small">{c.rationale}</div>
                        <div className="small muted">Files: {c.files.map((f) => <code key={f} style={{ marginRight: "0.4rem" }}>{f}</code>)}</div>
                        <EvidenceList items={c.evidence} max={3} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card" aria-labelledby="styles-heading">
                <h2 id="styles-heading">Styles</h2>
                <p className="small muted">Values as written in the source. They describe the reference, not the client&apos;s brand.</p>
                <h3>Colours</h3>
                <div className="actions">
                  {a.styles.colors.slice(0, 24).map((c) => (
                    <span key={c.value} className="small" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                      {SAFE_COLOUR.test(c.value) && <span aria-hidden style={{ width: "1rem", height: "1rem", borderRadius: 3, border: "1px solid var(--color-border)", background: c.value }} />}
                      <code>{c.value}</code> <span className="muted">×{c.count}</span>
                    </span>
                  ))}
                  {a.styles.colors.length === 0 && <span className="small muted">None.</span>}
                </div>
                <h3 style={{ marginTop: "1rem" }}>Fonts</h3>
                <p className="small">
                  {a.styles.fontFaces.length === 0 && a.styles.fontFamilies.length === 0 ? "None declared." : null}
                  {[...new Set([...a.styles.fontFaces.map((f) => f.family), ...a.styles.fontFamilies.map((f) => f.family)])].map((f) => (
                    <code key={f} style={{ marginRight: "0.5rem" }}>{f}</code>
                  ))}
                </p>
                <h3 style={{ marginTop: "1rem" }}>Custom properties ({a.styles.customProperties.length})</h3>
                {a.styles.customProperties.length === 0 ? (
                  <p className="small muted">None.</p>
                ) : (
                  <details className="small">
                    <summary>Show</summary>
                    <ul>
                      {a.styles.customProperties.slice(0, 100).map((p, i) => (
                        <li key={i}>
                          <code>{p.name}: {p.value}</code> <span className="muted">{p.path}:{p.line}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p className="small" style={{ marginTop: "0.75rem" }}>
                  {a.styles.keyframes.length} @keyframes, {a.styles.transitionCount} transition/animation declarations, {a.styles.reducedMotionQueries} reduced-motion queries.
                </p>
              </section>

              <section className="card" aria-labelledby="assets-heading">
                <h2 id="assets-heading">Assets ({a.assets.length})</h2>
                {a.assets.length > 0 && (
                  <details className="small">
                    <summary>Inventory</summary>
                    <ul>
                      {a.assets.map((x) => (
                        <li key={x.path}>
                          <code>{x.path}</code> {x.kind}, {formatBytes(x.sizeBytes)} · {x.referencedBy.length ? `referenced by ${x.referencedBy.length}` : <span className="muted">not referenced</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <h3 style={{ marginTop: "0.75rem" }}>Missing ({a.missingAssets.length})</h3>
                {a.missingAssets.length === 0 ? (
                  <p className="small muted">Every referenced local file is present.</p>
                ) : (
                  <ul className="log small">
                    {a.missingAssets.map((m) => (
                      <li key={m.ref}>
                        <code>{m.ref}</code>
                        <EvidenceList items={m.evidence} max={2} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card" aria-labelledby="deps-heading">
                <h2 id="deps-heading">Dependencies</h2>
                {a.dependencies.length === 0 ? (
                  <p className="small muted">None declared.</p>
                ) : (
                  <ul className="log small">
                    {a.dependencies.map((d) => (
                      <li key={`${d.scope}${d.name}${d.path}`}>
                        <code>{d.name}@{d.version}</code> <span className="muted">· {d.scope} · {d.path}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="small">Lockfiles: {a.lockfiles.length ? a.lockfiles.join(", ") : "none"}.</p>
                {a.externalResources.length > 0 && (
                  <details className="small">
                    <summary>{a.externalResources.length} external resources</summary>
                    <ul>
                      {a.externalResources.map((x) => (
                        <li key={x.url} style={{ overflowWrap: "anywhere" }}>
                          {x.kind}: <code>{x.url}</code> {x.kind === "script" && !x.integrity && <span className="badge warn">no integrity</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <h3 style={{ marginTop: "0.75rem" }}>Licences</h3>
                <ul className="log small">
                  {a.licenses.map((l) => (
                    <li key={l.path}>
                      <BasisBadge basis={l.basis} /> <code>{l.path}</code>: {l.identified ?? "not identified"}
                    </li>
                  ))}
                  {a.licenseBanners.length > 0 && <li>{a.licenseBanners.length} third-party licence notice(s) in bundled code.</li>}
                  {a.licenses.length === 0 && a.licenseBanners.length === 0 && <li className="muted">No licence information found.</li>}
                </ul>
              </section>

              <section className="card" aria-labelledby="risks-heading">
                <h2 id="risks-heading">Risks ({a.risks.length})</h2>
                {a.risks.length === 0 ? (
                  <p className="small muted">None found by the analysis.</p>
                ) : (
                  RiskKind.options
                    .filter((k) => a.risks.some((r) => r.kind === k))
                    .map((k) => (
                      <div key={k} style={{ marginBottom: "1rem" }}>
                        <h3>{RISK_LABELS[k]}</h3>
                        <ul className="log">
                          {a.risks
                            .filter((r) => r.kind === k)
                            .map((r) => (
                              <li key={r.key}>
                                <span className={`badge ${SEVERITY_TONE[r.severity]}`}>{r.severity}</span> <strong>{r.title}</strong> <span className="small muted">×{r.occurrences}</span> <BasisBadge basis={r.basis} />
                                <div className="small">{r.detail}</div>
                                <EvidenceList items={r.evidence} max={3} />
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))
                )}
              </section>
            </>
          )}

          <section className="card" aria-labelledby="findings-heading">
            <h2 id="findings-heading">Analyst findings</h2>
            <p className="small muted">From people and from Claude Code via the analysis kit. Facts cite the source; assumptions are conclusions.</p>
            <div className="two-col">
              {(["fact", "assumption"] as const).map((basis) => (
                <div key={basis}>
                  <h3>{basis === "fact" ? "Facts" : "Assumptions"}</h3>
                  {findings.filter((f) => f.basis === basis).length === 0 ? (
                    <p className="small muted">None.</p>
                  ) : (
                    <ul className="log small">
                      {findings
                        .filter((f) => f.basis === basis)
                        .map((f) => (
                          <li key={f.id}>
                            <span className="badge">{f.topic}</span> {f.statement}
                            <EvidenceList items={f.evidence.map((e) => ({ ...e, excerpt: null }))} max={3} />
                            <div className="muted">{f.origin === "analysis_kit" ? "From the analysis kit" : "Added here"}</div>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            {latest && (
              <div className="two-col" style={{ marginTop: "1rem" }}>
                <AddFindingForm projectId={projectId} sourceId={s.id} />
                <FindingsImportForm projectId={projectId} sourceId={s.id} />
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="questions-heading">
            <h2 id="questions-heading">Unresolved questions ({open.length})</h2>
            {open.length === 0 ? (
              <p className="small muted">None open.</p>
            ) : (
              <ul className="log">
                {open.map((q) => (
                  <li key={q.id}>
                    <div className="small">{q.text}</div>
                    <div className="small muted">{q.origin === "analyzer" ? "Raised by the analysis" : q.origin === "analysis_kit" ? "From the analysis kit" : "Added here"}</div>
                    <QuestionAnswer projectId={projectId} sourceId={s.id} questionId={q.id} resolved={false} />
                  </li>
                ))}
              </ul>
            )}
            {resolved.length > 0 && (
              <details className="small" style={{ marginTop: "0.75rem" }}>
                <summary>{resolved.length} resolved</summary>
                <ul className="log">
                  {resolved.map((q) => (
                    <li key={q.id}>
                      {q.text}
                      <div>
                        <strong>Answer:</strong> {q.answer}
                      </div>
                      <QuestionAnswer projectId={projectId} sourceId={s.id} questionId={q.id} resolved />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <AddQuestionForm projectId={projectId} sourceId={s.id} />
          </section>

          <section className="card" aria-labelledby="templates-heading">
            <h2 id="templates-heading">In the manifest ({templates.length})</h2>
            {templates.length === 0 ? (
              <p className="small muted">Nothing yet. Add template candidates, or import analyst templates.</p>
            ) : (
              <ul className="log">
                {templates.map((t) => (
                  <li key={t.id}>
                    <div>
                      <span className="badge">{t.kind.replace("_", " ")}</span> <strong>{t.name}</strong> <BasisBadge basis={t.basis} />
                    </div>
                    <div className="small muted">
                      {t.files.length} file{t.files.length === 1 ? "" : "s"} · {t.extraction.status === "extracted" ? `extracted to workspace/${t.extraction.workspacePath}` : "not extracted"} · {BUILD_LABELS[t.build.status]}
                    </div>
                    {t.build.note && <div className="small">Build: {t.build.note}</div>}
                    <TemplateActions projectId={projectId} templateId={t.id} name={t.name} canExtract={allowed} extracted={t.extraction.status === "extracted"} needsBuildRecord={t.build.status !== "not_applicable"} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="authority-heading">
            <h2 id="authority-heading">Authority</h2>
            {s.authorization.note && <p className="small">{s.authorization.note}</p>}
            <AuthorityForm projectId={projectId} sourceId={s.id} initial={s.authorization} />
          </section>
          <RemoveSourceButton projectId={projectId} sourceId={s.id} />
        </div>
      </div>
    </>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyTemplateOperationAction, reprocessTemplateAction, undoTemplateOperationAction, verifyTemplateAction } from "@/app/(dashboard)/projects/structure-actions";
import type { StructureView, ViewItem } from "@/server/templates";

// The template's structure, next to its live preview: page coverage and
// status, the selected page's sections by region (reorder, duplicate, insert,
// remove, merge, split, exclude by selector), design-token bindings, values
// that need direct edits, the overrides applied so far, and Web's checks.
// Every change is applied to the working copy; the preview rebuilds itself.

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
type Status = "processed" | "processed_with_limitations" | "requires_manual_work" | "inaccessible";
const STATUS: Record<Status, { label: string; cls: string }> = {
  processed: { label: "Processed", cls: "badge ok" },
  processed_with_limitations: { label: "With limitations", cls: "badge warn" },
  requires_manual_work: { label: "Manual work", cls: "badge danger" },
  inaccessible: { label: "Inaccessible", cls: "badge" },
};
const Badge = ({ status }: { status: Status | null }) => (status ? <span className={STATUS[status].cls} data-status={status}>{STATUS[status].label}</span> : null);

export function TemplateStructure({ projectId, jobId, pageId, view, canEdit }: { projectId: string; jobId: string; pageId: string | undefined; view: StructureView; canEdit: boolean }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string; retry?: () => void } | null>(null);
  const page = view.pages.find((p) => p.pageId === pageId) ?? view.pages[0];

  const run = (fn: () => Promise<Result<unknown>>, ok: (d: never) => string, retry?: () => void) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        setMessage({ ok: true, text: ok(r.data as never) });
        router.refresh();
      } else setMessage({ ok: false, text: r.message, retry: retry && /Confirm to copy it anyway/.test(r.message) ? retry : undefined });
    });
  const op = (operation: Record<string, unknown>, done: string) =>
    run(
      () => applyTemplateOperationAction(projectId, jobId, operation),
      (d: { warnings: string[] }) => [done, ...d.warnings].join(" "),
      () => op({ ...operation, force: true }, done),
    );

  return (
    <>
      {message && (
        <div className={`alert small ${message.ok ? "success" : "error"}`} role={message.ok ? "status" : "alert"} data-testid="structure-message">
          {message.text}
          {message.retry && (
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button type="button" className="button" disabled={busy} onClick={message.retry}>
                Copy anyway
              </button>
            </div>
          )}
        </div>
      )}

      <Coverage projectId={projectId} jobId={jobId} view={view} busy={busy} run={run} />

      {page && (
        <section className="card" aria-labelledby="sections-heading" data-testid="sections-panel">
          <h2 id="sections-heading">Sections: /{page.route === "index.html" ? "" : page.route.replace(/index\.html$/, "")}</h2>
          {!page.composable ? (
            <p className="small muted">This page&apos;s layout places no sections, so its structure cannot be edited here.</p>
          ) : (
            <>
              <p className="small muted">
                The page selected above, in page order. A region is a run of sections that sat side by side in one wrapper element. Sections move within their region, so the markup around them stays as captured.
                {!canEdit && " This template is read-only."}
              </p>
              {page.regions.map((r) => (
                <div key={r.id} className="field" data-testid="region" data-region={r.id}>
                  <h3 className="small" style={{ margin: "0.75rem 0 0.25rem" }}>
                    Region {r.id} · inside {r.parent}
                    {r.nestedIn && <> · parts of {r.nestedIn}</>}
                  </h3>
                  <ol className="rows" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {r.items.map((it, i) => (
                      <SectionRow key={it.id} item={it} first={i === 0} last={i === r.items.length - 1} next={r.items[i + 1]} index={i} pageId={page.pageId} canEdit={canEdit} busy={busy} op={op} />
                    ))}
                  </ol>
                </div>
              ))}
              {page.removed.length > 0 && (
                <div className="field">
                  <h3 className="small">Removed from this page</h3>
                  <ul className="rows" style={{ listStyle: "none", padding: 0 }}>
                    {page.removed.map((r) => (
                      <li key={r.id} className="row" data-testid="removed-item" data-section-id={r.id}>
                        <span>
                          {r.label} <span className="small muted">({r.id}{r.reason === "excluded" ? `, excluded by ${r.selector}` : ""})</span>
                        </span>
                        {canEdit && (
                          <button type="button" className="button" disabled={busy} onClick={() => op({ op: "restore", page: page.pageId, item: r.id }, `Restored ${r.id}.`)}>
                            Restore
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {canEdit && <PageForms page={page} library={view.library} busy={busy} op={op} />}
            </>
          )}
        </section>
      )}

      <Tokens view={view} canEdit={canEdit} busy={busy} op={op} />
      <SourceEdits view={view} />
      <Overrides projectId={projectId} jobId={jobId} view={view} canEdit={canEdit} busy={busy} run={run} />
    </>
  );
}

type Op = (operation: Record<string, unknown>, done: string) => void;
type Run = (fn: () => Promise<Result<unknown>>, ok: (d: never) => string) => void;

function SectionRow({ item, first, last, next, index, pageId, canEdit, busy, op }: { item: ViewItem; first: boolean; last: boolean; next?: ViewItem; index: number; pageId: string; canEdit: boolean; busy: boolean; op: Op }) {
  const [splitting, setSplitting] = useState(false);
  const [selector, setSelector] = useState("");
  return (
    <li className="row" data-testid="section-item" data-section-id={item.id} data-kind={item.kind} style={{ display: "block" }}>
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <span>
          <strong>{item.label}</strong> <span className="small muted">{item.id}</span> <Badge status={item.status} />
        </span>
        {canEdit && (
          <span className="actions">
            <button type="button" className="button" aria-label={`Move ${item.id} up`} disabled={busy || first} onClick={() => op({ op: "move", page: pageId, item: item.id, to: index - 1 }, `Moved ${item.id} up.`)}>
              ↑
            </button>
            <button type="button" className="button" aria-label={`Move ${item.id} down`} disabled={busy || last} onClick={() => op({ op: "move", page: pageId, item: item.id, to: index + 1 }, `Moved ${item.id} down.`)}>
              ↓
            </button>
            {item.kind === "section" && (
              <button type="button" className="button" aria-label={`Duplicate ${item.id}`} disabled={busy} onClick={() => op({ op: "duplicate", page: pageId, item: item.id }, `Duplicated ${item.id}.`)}>
                Duplicate
              </button>
            )}
            {item.kind === "section" && (
              <button type="button" className="button" aria-label={`Split ${item.id}`} aria-expanded={splitting} disabled={busy} onClick={() => setSplitting((v) => !v)}>
                Split
              </button>
            )}
            {next && (
              <button type="button" className="button" aria-label={`Merge ${item.id} with next`} disabled={busy} onClick={() => op({ op: "merge", page: pageId, items: [item.id, next.id] }, `Merged ${item.id} with ${next.id}.`)}>
                Merge with next
              </button>
            )}
            {item.kind === "group" && (
              <button type="button" className="button" aria-label={`Unmerge ${item.id}`} disabled={busy} onClick={() => op({ op: "unmerge", page: pageId, item: item.id }, `Unmerged ${item.id}.`)}>
                Unmerge
              </button>
            )}
            <button type="button" className="button danger" aria-label={`Remove ${item.id}`} disabled={busy} onClick={() => op({ op: "remove", page: pageId, item: item.id }, `Removed ${item.id} from the page.`)}>
              Remove
            </button>
          </span>
        )}
      </div>
      {item.reasons.length > 0 && (
        <ul className="small" style={{ margin: "0.25rem 0 0 1rem" }}>
          {item.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {item.notes.length > 0 && <p className="small muted" style={{ margin: "0.25rem 0 0" }}>{item.notes.join(" ")}</p>}
      {item.members && (
        <ul className="small" style={{ margin: "0.25rem 0 0 1rem" }}>
          {item.members.map((m) => (
            <li key={m.id}>
              {m.label} <span className="muted">{m.id}</span> <Badge status={m.status} />
            </li>
          ))}
        </ul>
      )}
      {splitting && item.kind === "section" && (
        <form
          className="actions"
          style={{ marginTop: "0.5rem", alignItems: "end" }}
          onSubmit={(e) => {
            e.preventDefault();
            setSplitting(false);
            op({ op: "split", page: pageId, item: item.id, selector }, `Split ${item.id} at ${selector}.`);
          }}
        >
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor={`split-${item.id}`}>Split at elements matching</label>
            <input id={`split-${item.id}`} type="text" placeholder=".card" value={selector} onChange={(e) => setSelector(e.target.value)} />
          </div>
          <button type="submit" className="button primary" disabled={busy || !selector.trim()}>
            Split section
          </button>
        </form>
      )}
    </li>
  );
}

function PageForms({ page, library, busy, op }: { page: StructureView["pages"][number]; library: StructureView["library"]; busy: boolean; op: Op }) {
  const [source, setSource] = useState(library[0] ? `${library[0].page}|${library[0].section}` : "");
  const [region, setRegion] = useState(page.regions[0]?.id ?? "");
  const [position, setPosition] = useState("end");
  const [selector, setSelector] = useState("");
  const target = page.regions.find((r) => r.id === region) ?? page.regions[0];
  return (
    <div className="two-col" style={{ marginTop: "1rem" }}>
      <form
        aria-labelledby="insert-heading"
        onSubmit={(e) => {
          e.preventDefault();
          const [fromPage, section] = source.split("|");
          const index = position === "end" ? (target?.items.length ?? 0) : Number(position);
          op({ op: "insert", page: page.pageId, from: { page: fromPage, section }, region: target?.id, index }, `Inserted a copy of ${section}.`);
        }}
      >
        <h3 id="insert-heading" className="small">Insert a section</h3>
        <div className="field">
          <label htmlFor="insert-source">Section (from any page)</label>
          <select id="insert-source" value={source} onChange={(e) => setSource(e.target.value)}>
            {library.map((l) => (
              <option key={`${l.page}|${l.section}`} value={`${l.page}|${l.section}`}>
                {l.section} — {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="insert-region">Region</label>
          <select id="insert-region" value={target?.id ?? ""} onChange={(e) => setRegion(e.target.value)}>
            {page.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · inside {r.parent}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="insert-position">Position</label>
          <select id="insert-position" value={position} onChange={(e) => setPosition(e.target.value)}>
            {(target?.items ?? []).map((it, i) => (
              <option key={it.id} value={String(i)}>
                Before {it.id}
              </option>
            ))}
            <option value="end">At the end</option>
          </select>
        </div>
        <button type="submit" className="button" disabled={busy || !source || !target}>
          Insert section
        </button>
      </form>
      <form
        aria-labelledby="exclude-heading"
        onSubmit={(e) => {
          e.preventDefault();
          op({ op: "exclude", page: page.pageId, selector }, `Excluded "${selector}" on this page.`);
        }}
      >
        <h3 id="exclude-heading" className="small">Exclude by selector</h3>
        <p className="small muted">Removes matching elements from this page (a whole section if the selector matches its root). Other pages keep shared markup.</p>
        <div className="field">
          <label htmlFor="exclude-selector">Selector</label>
          <input id="exclude-selector" type="text" placeholder=".cookie-banner" value={selector} onChange={(e) => setSelector(e.target.value)} />
        </div>
        <button type="submit" className="button" disabled={busy || !selector.trim()}>
          Exclude
        </button>
      </form>
    </div>
  );
}

function Coverage({ projectId, jobId, view, busy, run }: { projectId: string; jobId: string; view: StructureView; busy: boolean; run: Run }) {
  const s = view.coverage.summary;
  const v = view.verification;
  const row = (r: Record<Status, number>) => (Object.keys(STATUS) as Status[]).map((k) => `${r[k]} ${STATUS[k].label.toLowerCase()}`).join(" · ");
  return (
    <section className="card" aria-labelledby="coverage-heading" data-testid="coverage">
      <h2 id="coverage-heading">Coverage and checks</h2>
      <p className="small" data-testid="coverage-pages">
        <strong>Pages:</strong> {row(s.pages)}
      </p>
      <p className="small" data-testid="coverage-sections">
        <strong>Sections:</strong> {row(s.sections)}
      </p>
      {view.coverage.discovery.complete === false && (
        <p className="alert info small">
          Discovery was incomplete{view.coverage.discovery.limitsReached.length ? ` (limits reached: ${view.coverage.discovery.limitsReached.join(", ")})` : ""}; {view.coverage.discovery.remainingUrls} URL(s) were found but not captured.
        </p>
      )}
      <details>
        <summary className="small">Pages and their status</summary>
        <ul className="rows small" style={{ listStyle: "none", padding: 0 }}>
          {view.coverage.pages.map((p) => (
            <li key={`${p.id}|${p.url}`} className="row" data-testid="coverage-page" data-page={p.id ?? ""} style={{ display: "block" }}>
              <Badge status={p.status} /> {p.route ? `/${p.route.replace(/index\.html$/, "")}` : p.url} <span className="muted">{p.url}</span>
              {p.reasons.length > 0 && <div>{p.reasons.join(" ")}</div>}
              {p.notes.length > 0 && <div className="muted">{p.notes.join(" ")}</div>}
            </li>
          ))}
        </ul>
      </details>
      <p className="small muted">Sources: {view.coverage.sources.join("; ")}.</p>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => run(() => verifyTemplateAction(projectId, jobId), (d: { summary: { pages: number; passed: number; failed: number }; build: { ok: boolean; error: string | null } }) => (d.build.ok ? `Checks done: ${d.summary.passed} of ${d.summary.pages} page(s) passed.` : `The build failed: ${d.build.error}`))}
        >
          Run checks
        </button>
        <a className="button" href={`/api/projects/${projectId}/template-jobs/${jobId}/export`} download>
          Download edited template
        </a>
      </div>
      {v && (
        <div className="small" data-testid="verification" data-passed={v.summary.passed} data-failed={v.summary.failed}>
          <p>
            Last checks {new Date(v.at).toLocaleString()}: {v.build.ok ? `${v.summary.passed} of ${v.summary.pages} page(s) passed.` : `build failed: ${v.build.error}`}
          </p>
          <ul>
            {v.pages.map((p) => (
              <li key={p.page}>
                {p.passed ? "✓" : "✗"} {p.page}: sections {p.sections.passed ? "in composition order" : "NOT in composition order"}, {p.missingAssets.length} missing asset(s), {p.brokenLinks.length} broken link(s), {p.duplicateIds.length} duplicate id(s), {p.content.missing.length} of {p.content.checked} content value(s) not visible, {p.external.length} outside reference(s)
              </li>
            ))}
          </ul>
          <p className="muted">{v.note}</p>
        </div>
      )}
    </section>
  );
}

function Tokens({ view, canEdit, busy, op }: { view: StructureView; canEdit: boolean; busy: boolean; op: Op }) {
  const t = view.tokens;
  if (!t.total && !t.tokens.length) return null;
  return (
    <section className="card" aria-labelledby="tokens-heading">
      <h2 id="tokens-heading">Design tokens</h2>
      <p className="small muted">
        {t.total} declaration(s) use a token; {t.inline} more in markup. Each keeps its captured value as the fallback. Detach a declaration to keep its captured value when the brand changes; no other use of the colour is affected.
        {t.unaligned.length > 0 && ` Captured originals could not be matched for: ${t.unaligned.join(", ")} (the token's captured value is shown instead).`}
      </p>
      <details>
        <summary className="small">Declarations ({t.total})</summary>
        <table className="small" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th align="left">Where</th>
              <th align="left">Captured</th>
              <th align="left">Now</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {t.bindings.map((b) => (
              <tr key={b.id} data-testid="token-binding" data-binding={b.id} data-state={b.state}>
                <td>
                  {b.file} · {b.selector} {"{"} {b.property} {"}"}
                </td>
                <td>
                  <code>{b.original}</code>
                </td>
                <td>
                  <code>{b.current}</code>
                </td>
                <td>
                  {canEdit &&
                    (b.state === "bound" ? (
                      <button type="button" className="button" disabled={busy} onClick={() => op({ op: "token-detach", entry: b.id }, "Detached.")}>
                        Detach
                      </button>
                    ) : (
                      <button type="button" className="button" disabled={busy} onClick={() => op({ op: "token-attach", entry: b.id }, "Re-attached to the token.")}>
                        Use token
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.total > t.bindings.length && <p className="small muted">First {t.bindings.length} shown; all are in tokens/token-map.json.</p>}
      </details>
    </section>
  );
}

function SourceEdits({ view }: { view: StructureView }) {
  const e = view.sourceEdits;
  const total = Object.values(e.counts).reduce((a, b) => a + b, 0);
  return (
    <section className="card" aria-labelledby="source-edits-heading" data-testid="source-edits">
      <h2 id="source-edits-heading">Values needing direct edits</h2>
      <p className="small muted">
        Not editable through content or tokens: {e.counts.colour} hard-coded colour(s), {e.counts.font} font(s), {e.counts.text} text(s) written into the markup, {e.counts.image} image reference(s), {e.counts.script} script file(s).
      </p>
      {total > 0 && (
        <details>
          <summary className="small">List</summary>
          <ul className="small">
            {e.items.slice(0, 300).map((x, i) => (
              <li key={i}>
                {x.kind}: {x.file} · {x.where} · <code>{x.value}</code>
              </li>
            ))}
          </ul>
          {e.items.length > 300 && <p className="small muted">The full list is in reports/source-edits.json in the download.</p>}
        </details>
      )}
    </section>
  );
}

function Overrides({ projectId, jobId, view, canEdit, busy, run }: { projectId: string; jobId: string; view: StructureView; canEdit: boolean; busy: boolean; run: Run }) {
  const replayed = (d: { restored: number; failed: string[] }) => `Replayed from the generated template; ${d.restored} edited value(s) kept.${d.failed.length ? ` Could not re-apply: ${d.failed.join("; ")}` : ""}`;
  return (
    <section className="card" aria-labelledby="overrides-heading" data-testid="overrides">
      <h2 id="overrides-heading">Overrides</h2>
      <p className="small muted">Every change to structure and tokens, in order (overrides.json in the template). Undoing one rebuilds the working copy from the generated template and re-applies the rest; text and brand edits are kept wherever their field still exists.</p>
      {view.operations.length === 0 ? (
        <p className="small muted">None yet.</p>
      ) : (
        <ol className="small">
          {view.operations.map((o) => (
            <li key={o.index} data-testid="override" data-op={o.op} data-status={o.status}>
              <strong>{o.op}</strong> {"page" in o ? `on ${o.page}` : ""} {"item" in o ? o.item : ""} {"selector" in o ? `“${o.selector}”` : ""} {"entry" in o ? o.entry : ""} {o.as ? `→ ${o.as}` : ""}
              {o.status === "failed" && <span className="badge danger">failed: {o.error}</span>}
              {o.warnings.length > 0 && <span className="muted"> — {o.warnings.join(" ")}</span>}{" "}
              {canEdit && (
                <button type="button" className="button link" disabled={busy} onClick={() => run(() => undoTemplateOperationAction(projectId, jobId, o.index), replayed)}>
                  Undo
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {canEdit && (
        <button type="button" className="button" disabled={busy} onClick={() => run(() => reprocessTemplateAction(projectId, jobId), replayed)}>
          Reprocess from generated template
        </button>
      )}
    </section>
  );
}

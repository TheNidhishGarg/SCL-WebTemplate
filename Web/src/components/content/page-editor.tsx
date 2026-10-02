"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { saveBlockAction, savePageAction, transitionPageAction } from "@/app/(dashboard)/projects/content-actions";
import { pagePath, SECTION_LABELS, type PageContent, type PageStatus, type Section, type SectionType } from "@/domain/content";
import { validatePage, type ValidationContext } from "@/domain/content-validate";
import { Check, Field, MediaPicker, Pick, SectionFields, type PickerData } from "./section-fields";

type Props = {
  projectId: string;
  pageId: string;
  revision: number;
  status: PageStatus;
  published: boolean;
  initial: PageContent;
  // Everything the validator needs, so the checks shown here are the ones
  // the server applies on submit and publish.
  ctx: Omit<ValidationContext, "blocks" | "assetIds"> & { blocks: [string, Section][]; assetIds: string[] };
  data: PickerData;
  blocks: { id: string; name: string }[];
  templates: { id: string; name: string }[];
};

const uuid = () => crypto.randomUUID();

function newSection(type: SectionType, blockId?: string): Section {
  const id = uuid();
  switch (type) {
    case "hero":
      return { id, type, eyebrow: "", heading: "", body: "", media: null, ctas: [] };
    case "text":
      return { id, type, heading: "", body: "" };
    case "features":
      return { id, type, heading: "", intro: "", items: [] };
    case "gallery":
      return { id, type, heading: "", images: [] };
    case "faq":
      return { id, type, heading: "", items: [] };
    case "cta":
      return { id, type, heading: "", body: "", ctas: [] };
    case "contact":
      return { id, type, heading: "", body: "", email: "", phone: "", actionKind: null };
    case "block":
      return { id, type, blockId: blockId! };
  }
}

export function PageEditor({ projectId, pageId, revision, status, published, initial, ctx, data, blocks, templates }: Props) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: { path: string; message: string }[] } | null>(null);
  const [pending, start] = useTransition();
  const [addType, setAddType] = useState<string>("text");

  const edit = (fn: (d: PageContent) => void) => {
    setC((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const issues = useMemo(() => {
    const vctx: ValidationContext = {
      ...ctx,
      blocks: new Map(ctx.blocks),
      assetIds: new Set(ctx.assetIds),
      pages: ctx.pages.map((p) => (p.id === pageId ? { ...p, content: c } : p)),
    };
    return validatePage(pageId, vctx, status === "approved");
  }, [c, ctx, pageId, status]);
  const errors = issues.filter((i) => i.level === "error");
  const err = (path: string) => issues.find((i) => i.path === path && i.level === "error")?.message ?? (msg && !msg.ok ? msg.issues?.find((i) => i.path === path)?.message : undefined);

  const run = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; message: string; issues: { path: string; message: string }[] }>, success: string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setDirty(false);
        setMsg({ ok: true, text: success });
        router.refresh();
      } else setMsg({ ok: false, text: r.message, issues: r.issues });
    });

  const moveSection = (i: number, d: -1 | 1) =>
    edit((x) => {
      const j = i + d;
      if (j < 0 || j >= x.sections.length) return;
      [x.sections[i], x.sections[j]] = [x.sections[j], x.sections[i]];
    });

  return (
    <div className="grid grid-main-side">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          run(() => savePageAction(projectId, pageId, revision, c), "Saved. The page is a draft again until it is reviewed.");
        }}
      >
        {msg && (
          <div className={`alert ${msg.ok ? "success" : "error"}`} role={msg.ok ? "status" : "alert"}>
            {msg.text}
            {!msg.ok && msg.issues && msg.issues.length > 0 && (
              <ul>
                {msg.issues.slice(0, 15).map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <section className="card" aria-label="Page">
          <h2>Page</h2>
          <div className="two-col">
            <Field label="Title" required value={c.title} onChange={(title) => edit((x) => void (x.title = title))} error={err("title")} />
            <Field label="Path" value={c.slug} onChange={(slug) => edit((x) => void (x.slug = slug))} error={err("slug")} hint={`Shown at ${pagePath(c.slug)}. Empty for the home page.`} />
            <Field label="Navigation label" value={c.navLabel} onChange={(navLabel) => edit((x) => void (x.navLabel = navLabel))} error={err("navLabel")} />
            <Pick label="Layout" value={c.layout} options={[["standard", "Standard"], ["landing", "Landing"], ["article", "Article"]]} onChange={(v) => edit((x) => void (x.layout = v as PageContent["layout"]))} />
          </div>
          <Check label="Show in main navigation" checked={c.inNav} onChange={(v) => edit((x) => void (x.inNav = v))} />
          <Check label="Show in footer" checked={c.inFooter} onChange={(v) => edit((x) => void (x.inFooter = v))} />
          <Pick label="Follows WF-03 template" value={c.templateRef ?? ""} options={[["", "None"], ...templates.map((t): [string, string] => [t.id, t.name])]} onChange={(v) => edit((x) => void (x.templateRef = v || null))} />
        </section>

        <section className="card" aria-label="Search and sharing">
          <h2>Search and sharing</h2>
          <Field label="SEO title" required value={c.seo.title} onChange={(v) => edit((x) => void (x.seo.title = v))} error={err("seo.title")} hint={`${c.seo.title.length}/60 characters shown in results`} />
          <Field label="Meta description" required multiline value={c.seo.description} onChange={(v) => edit((x) => void (x.seo.description = v))} error={err("seo.description")} hint={`${c.seo.description.length}/160`} />
          <Field label="Canonical path override" value={c.seo.canonicalPath} onChange={(v) => edit((x) => void (x.seo.canonicalPath = v))} error={err("seo.canonicalPath")} hint="Leave empty to use this page's own path." />
          <Check label="Hide from search engines (noindex)" checked={c.seo.noindex} onChange={(v) => edit((x) => void (x.seo.noindex = v))} />
          <MediaPicker label="Social sharing image" value={c.seo.ogImage} onChange={(m) => edit((x) => void (x.seo.ogImage = m))} data={data} err={(p) => err(p ? `seo.ogImage.${p}` : "seo.ogImage")} />
        </section>

        {c.sections.map((s, i) => (
          <section key={s.id} className="card" aria-label={`Section ${i + 1}: ${SECTION_LABELS[s.type]}`} data-section-id={s.id}>
            <div className="actions" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>
                {i + 1}. {SECTION_LABELS[s.type]}
              </h2>
              <div className="actions">
                <button type="button" className="button" disabled={i === 0} onClick={() => moveSection(i, -1)} aria-label={`Move section ${i + 1} up`}>
                  ↑
                </button>
                <button type="button" className="button" disabled={i === c.sections.length - 1} onClick={() => moveSection(i, 1)} aria-label={`Move section ${i + 1} down`}>
                  ↓
                </button>
                {s.type !== "block" && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const name = window.prompt("Name for this reusable block");
                      if (name) run(() => saveBlockAction(projectId, null, { name, section: s }), `Saved "${name}" as a reusable block.`);
                    }}
                  >
                    Save as block
                  </button>
                )}
                <button type="button" className="button link danger small" onClick={() => edit((x) => void x.sections.splice(i, 1))} aria-label={`Remove section ${i + 1}`}>
                  Remove
                </button>
              </div>
            </div>
            <p className="small muted">
              id <code>{s.id}</code>
            </p>
            <SectionFields
              s={s}
              onChange={(n) => edit((x) => void (x.sections[i] = n))}
              data={data}
              blocks={blocks}
              err={(p) => err(p ? `sections.${i}.${p}` : `sections.${i}`)}
            />
          </section>
        ))}

        <section className="card" aria-label="Add a section">
          <div className="actions" style={{ alignItems: "end" }}>
            <Pick
              label="Add a section"
              value={addType}
              options={[...(Object.keys(SECTION_LABELS) as SectionType[]).filter((t) => t !== "block").map((t): [string, string] => [t, SECTION_LABELS[t]]), ...blocks.map((b): [string, string] => [`block:${b.id}`, `Reusable block: ${b.name}`])]}
              onChange={setAddType}
            />
            <button
              type="button"
              className="button"
              style={{ marginBottom: "1rem" }}
              onClick={() => edit((x) => void x.sections.push(addType.startsWith("block:") ? newSection("block", addType.slice(6)) : newSection(addType as SectionType)))}
            >
              Add
            </button>
          </div>
        </section>

        <div className="save-bar">
          <span className="save-status" role="status" aria-live="polite">
            {pending ? "Working…" : dirty ? "Unsaved changes" : `Revision ${revision} · ${status.replace("_", " ")}`}
          </span>
          <div className="actions">
            <button type="submit" className="button primary" disabled={pending || !dirty}>
              Save
            </button>
            {status === "draft" && (
              <button type="button" className="button" disabled={pending || dirty} onClick={() => run(() => transitionPageAction(projectId, pageId, "submit"), "Submitted for review.")}>
                Submit for review
              </button>
            )}
            {status === "in_review" && (
              <>
                <button type="button" className="button" disabled={pending} onClick={() => run(() => transitionPageAction(projectId, pageId, "approve"), "Approved.")}>
                  Approve
                </button>
                <button type="button" className="button" disabled={pending} onClick={() => run(() => transitionPageAction(projectId, pageId, "return"), "Returned to draft.")}>
                  Return to draft
                </button>
              </>
            )}
            {status === "approved" && (
              <button type="button" className="button primary" disabled={pending || dirty} onClick={() => run(() => transitionPageAction(projectId, pageId, "publish"), "Published.")}>
                Publish
              </button>
            )}
            {published && (
              <button type="button" className="button link danger small" disabled={pending} onClick={() => window.confirm("Take this page off the published site?") && run(() => transitionPageAction(projectId, pageId, "unpublish"), "Unpublished.")}>
                Unpublish
              </button>
            )}
          </div>
        </div>
      </form>

      <aside className="stack sticky-side" aria-label="Checks">
        <section className="card">
          <h2>Checks</h2>
          {issues.length === 0 ? (
            <p className="small">No problems found.</p>
          ) : (
            <>
              {errors.length > 0 && <p className="small">{errors.length} item(s) block {status === "approved" ? "publication" : "review"}:</p>}
              <ul className="small">
                {issues.map((i, n) => (
                  <li key={n} style={{ color: i.level === "error" ? "var(--color-danger)" : undefined }}>
                    {i.level === "warning" && "Warning: "}
                    {i.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}

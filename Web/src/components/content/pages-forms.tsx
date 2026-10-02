"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPageAction, deleteBlockAction, deletePageAction, generatePagesAction, movePageAction, saveBlockAction, updateSiteAction } from "@/app/(dashboard)/projects/content-actions";
import type { Section, SiteSettings } from "@/domain/content";
import { useAction } from "../use-action";
import { Field, Pick, SectionFields, type PickerData } from "./section-fields";

const Msg = ({ r, ok }: { r: { ok: boolean; message?: string } | null; ok?: string }) =>
  !r ? null : r.ok ? (ok ? <p className="alert success" role="status">{ok}</p> : null) : <p className="alert error" role="alert">{r.message}</p>;

export function SiteSettingsForm({ projectId, initial, brands }: { projectId: string; initial: SiteSettings; brands: { id: string; name: string }[] }) {
  const [v, setV] = useState(initial);
  const { run, result, pending, issue } = useAction(updateSiteAction);
  return (
    <form noValidate onSubmit={(e) => (e.preventDefault(), run(projectId, v))}>
      <h2>Site</h2>
      <Msg r={result} ok="Site settings saved." />
      <Field label="Site name" value={v.siteName} onChange={(siteName) => setV({ ...v, siteName })} error={issue("siteName")} />
      <Field label="Site address (for canonical URLs)" value={v.baseUrl} onChange={(baseUrl) => setV({ ...v, baseUrl })} error={issue("baseUrl")} hint="e.g. https://www.example.com" />
      <Field label="Language" value={v.locale} onChange={(locale) => setV({ ...v, locale })} error={issue("locale")} />
      <Pick label="Brand (WF-04)" value={v.brandId ?? ""} options={[["", "None"], ...brands.map((b): [string, string] => [b.id, b.name])]} onChange={(id) => setV({ ...v, brandId: id || null })} />
      <button type="submit" className="button" disabled={pending}>
        Save site settings
      </button>
    </form>
  );
}

export function GenerateButton({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const { run, result, pending } = useAction(generatePagesAction);
  return (
    <div>
      <Msg r={result} ok={result?.ok ? `${result.data.created} page draft(s) created${result.data.skipped ? `, ${result.data.skipped} already existed` : ""}. Each needs writing and review before it can be published.` : undefined} />
      <button type="button" className="button primary" disabled={pending || disabled} onClick={() => run(projectId)}>
        {pending ? "Generating…" : "Generate sitemap and drafts from the brief"}
      </button>
    </div>
  );
}

export function NewPageForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [v, setV] = useState({ title: "", slug: "" });
  const { run, result, pending, issue } = useAction(createPageAction);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(projectId, v);
        if (r.ok) router.push(`/projects/${projectId}/pages/${r.data}`);
      }}
    >
      <h2>New page</h2>
      <Msg r={result} />
      <Field label="Title" required value={v.title} onChange={(title) => setV({ ...v, title })} error={issue("title")} />
      <Field label="Path" value={v.slug} onChange={(slug) => setV({ ...v, slug })} error={issue("slug")} hint="e.g. about or work/case-studies" />
      <button type="submit" className="button" disabled={pending}>
        Create page
      </button>
    </form>
  );
}

export function PageRowActions({ projectId, pageId, title, first, last }: { projectId: string; pageId: string; title: string; first: boolean; last: boolean }) {
  const move = useAction(movePageAction);
  const del = useAction(deletePageAction);
  return (
    <span className="actions">
      <button type="button" className="button link small" disabled={first || move.pending} onClick={() => move.run(projectId, pageId, -1)} aria-label={`Move ${title} up`}>
        ↑
      </button>
      <button type="button" className="button link small" disabled={last || move.pending} onClick={() => move.run(projectId, pageId, 1)} aria-label={`Move ${title} down`}>
        ↓
      </button>
      <button type="button" className="button link danger small" disabled={del.pending} onClick={() => window.confirm(`Delete "${title}"? Links to it will be reported as broken.`) && del.run(projectId, pageId)} aria-label={`Delete ${title}`}>
        Delete
      </button>
    </span>
  );
}

export function BlockEditor({ projectId, block, data, issues }: { projectId: string; block: { id: string; name: string; section: Section }; data: PickerData; issues: Map<string, string> }) {
  const [name, setName] = useState(block.name);
  const [section, setSection] = useState(block.section);
  const save = useAction(saveBlockAction);
  const del = useAction(deleteBlockAction);
  return (
    <form noValidate onSubmit={(e) => (e.preventDefault(), save.run(projectId, block.id, { name, section }))}>
      <Msg r={save.result} ok="Block saved. Every page using it shows the change." />
      <Msg r={del.result} />
      <Field label="Block name" value={name} onChange={setName} />
      <SectionFields s={section} onChange={setSection} data={data} blocks={[]} err={(p) => issues.get(p)} />
      <div className="actions">
        <button type="submit" className="button" disabled={save.pending}>
          Save block
        </button>
        <button type="button" className="button link danger small" onClick={() => del.run(projectId, block.id)}>
          Delete block
        </button>
      </div>
    </form>
  );
}

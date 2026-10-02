"use client";

import { useId, type ReactNode } from "react";
import type { Cta, LinkTarget, MediaRef, Section } from "@/domain/content";

// Form controls for the content model. Each section type gets a form built
// from the same few controls; nothing here knows how a section will look.

export type PickerData = {
  pages: { id: string; title: string; sections: { id: string; label: string }[] }[];
  images: { id: string; label: string }[];
  actionKinds: string[];
};

const uuid = () => crypto.randomUUID();

export function Field({ label, value, onChange, multiline, error, hint, required }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; error?: string; hint?: string; required?: boolean }) {
  const id = useId();
  const props = { id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value), "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}-e` : hint ? `${id}-h` : undefined };
  return (
    <div className="field">
      <label htmlFor={id} className={required ? "required" : undefined}>
        {label}
      </label>
      {hint && <span className="hint" id={`${id}-h`}>{hint}</span>}
      {multiline ? <textarea {...props} /> : <input type="text" {...props} />}
      {error && <p className="field-error" id={`${id}-e`}>{error}</p>}
    </div>
  );
}

export function Pick({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="small" style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function MediaPicker({ label, value, onChange, data, err }: { label: string; value: MediaRef; onChange: (m: MediaRef) => void; data: PickerData; err: (p: string) => string | undefined }) {
  if (!value) {
    return (
      <div className="field">
        <span className="label">{label}</span>
        <button type="button" className="button" onClick={() => onChange({ id: uuid(), source: data.images[0] ? { kind: "asset", assetId: data.images[0].id } : { kind: "url", url: "" }, alt: "", decorative: false })}>
          Add image
        </button>
      </div>
    );
  }
  const src = value.source.kind === "asset" ? value.source.assetId : "__url";
  return (
    <fieldset className="field" style={{ border: "1px dashed var(--color-border)", padding: "0.5rem", borderRadius: 6 }}>
      <legend className="label">{label}</legend>
      {err("") && <p className="field-error">{err("")}</p>}
      <Pick label="Image" value={src} options={[...data.images.map((i): [string, string] => [i.id, `Register: ${i.label}`]), ["__url", "External https URL"]]} onChange={(v) => onChange({ ...value, source: v === "__url" ? { kind: "url", url: "" } : { kind: "asset", assetId: v } })} />
      {value.source.kind === "url" && <Field label="Image URL" value={value.source.url} onChange={(url) => onChange({ ...value, source: { kind: "url", url } })} error={err("source.url")} />}
      <Check label="Decorative (no description needed)" checked={value.decorative} onChange={(decorative) => onChange({ ...value, decorative })} />
      {!value.decorative && <Field label="Image description (alt text)" required value={value.alt} onChange={(alt) => onChange({ ...value, alt })} error={err("alt")} hint="What the image shows, for people who cannot see it." />}
      <button type="button" className="button link danger small" onClick={() => onChange(null)}>
        Remove image
      </button>
    </fieldset>
  );
}

function TargetPicker({ value, onChange, data, err }: { value: LinkTarget; onChange: (t: LinkTarget) => void; data: PickerData; err: (p: string) => string | undefined }) {
  const key = value.kind === "url" ? "__url" : value.kind === "section" ? `${value.pageId}#${value.sectionId}` : value.pageId;
  const options: [string, string][] = [
    ...data.pages.flatMap((p): [string, string][] => [[p.id, `Page: ${p.title}`], ...p.sections.map((s): [string, string] => [`${p.id}#${s.id}`, `  ${p.title} › ${s.label}`])]),
    ["__url", "External link (https, mailto, tel)"],
  ];
  if (!options.some(([v]) => v === key)) options.unshift([key, "(missing target)"]);
  return (
    <>
      <Pick
        label="Links to"
        value={key}
        options={options}
        onChange={(v) => {
          if (v === "__url") onChange({ kind: "url", url: "https://" });
          else if (v.includes("#")) {
            const [pageId, sectionId] = v.split("#");
            onChange({ kind: "section", pageId, sectionId });
          } else onChange({ kind: "page", pageId: v });
        }}
      />
      {err("") && <p className="field-error">{err("")}</p>}
      {value.kind === "url" && <Field label="URL" value={value.url} onChange={(url) => onChange({ kind: "url", url })} error={err("url")} />}
    </>
  );
}

export function CtaList({ ctas, onChange, data, err }: { ctas: Cta[]; onChange: (c: Cta[]) => void; data: PickerData; err: (p: string) => string | undefined }) {
  const set = (i: number, c: Cta) => onChange(ctas.map((x, j) => (j === i ? c : x)));
  return (
    <div>
      <span className="label">Buttons</span>
      {ctas.map((c, i) => (
        <div key={c.id} style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: "0.75rem", marginBlock: "0.5rem" }}>
          <div className="two-col">
            <Field label={`Button ${i + 1} label`} value={c.label} onChange={(label) => set(i, { ...c, label })} error={err(`${i}.label`)} />
            <Pick label="Style" value={c.style} options={[["primary", "Primary"], ["secondary", "Secondary"]]} onChange={(style) => set(i, { ...c, style: style as Cta["style"] })} />
          </div>
          <TargetPicker value={c.target} onChange={(target) => set(i, { ...c, target })} data={data} err={(p) => err(`${i}.target${p ? `.${p}` : ""}`)} />
          <Pick label="Tracks desired action (WF-09)" value={c.actionKind ?? ""} options={[["", "None"], ...data.actionKinds.map((k): [string, string] => [k, k])]} onChange={(v) => set(i, { ...c, actionKind: v || null })} />
          <button type="button" className="button link danger small" onClick={() => onChange(ctas.filter((_, j) => j !== i))}>
            Remove button {i + 1}
          </button>
        </div>
      ))}
      {ctas.length < 3 && (
        <button type="button" className="button" onClick={() => onChange([...ctas, { id: uuid(), label: "", style: ctas.length ? "secondary" : "primary", target: data.pages[0] ? { kind: "page", pageId: data.pages[0].id } : { kind: "url", url: "https://" }, actionKind: null }])}>
          Add button
        </button>
      )}
    </div>
  );
}

function List<T extends { id: string }>({ items, onChange, render, make, name }: { items: T[]; onChange: (t: T[]) => void; render: (t: T, set: (t: T) => void, i: number) => ReactNode; make: () => T; name: string }) {
  return (
    <div>
      {items.map((t, i) => (
        <div key={t.id} style={{ borderLeft: "3px solid var(--color-border)", paddingLeft: "0.75rem", marginBlock: "0.5rem" }}>
          {render(t, (n) => onChange(items.map((x, j) => (j === i ? n : x))), i)}
          <button type="button" className="button link danger small" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            Remove {name} {i + 1}
          </button>
        </div>
      ))}
      <button type="button" className="button" onClick={() => onChange([...items, make()])}>
        Add {name}
      </button>
    </div>
  );
}

// The form for one section. `err(path)` returns the issue at a path relative to the section.
export function SectionFields({ s, onChange, data, err, blocks }: { s: Section; onChange: (s: Section) => void; data: PickerData; err: (p: string) => string | undefined; blocks: { id: string; name: string }[] }) {
  const sub = (prefix: string) => (p: string) => err(p ? `${prefix}.${p}` : prefix);
  switch (s.type) {
    case "hero":
      return (
        <>
          <Field label="Eyebrow" value={s.eyebrow} onChange={(eyebrow) => onChange({ ...s, eyebrow })} />
          <Field label="Heading" required value={s.heading} onChange={(heading) => onChange({ ...s, heading })} error={err("heading")} />
          <Field label="Introduction" multiline value={s.body} onChange={(body) => onChange({ ...s, body })} error={err("body")} />
          <MediaPicker label="Image" value={s.media} onChange={(media) => onChange({ ...s, media })} data={data} err={sub("media")} />
          <CtaList ctas={s.ctas} onChange={(ctas) => onChange({ ...s, ctas })} data={data} err={sub("ctas")} />
        </>
      );
    case "text":
      return (
        <>
          <Field label="Heading" value={s.heading} onChange={(heading) => onChange({ ...s, heading })} error={err("heading")} />
          <Field label="Text" required multiline value={s.body} onChange={(body) => onChange({ ...s, body })} error={err("body")} hint="Plain text. Leave a blank line between paragraphs." />
        </>
      );
    case "features":
      return (
        <>
          <Field label="Heading" value={s.heading} onChange={(heading) => onChange({ ...s, heading })} error={err("heading")} />
          <Field label="Introduction" multiline value={s.intro} onChange={(intro) => onChange({ ...s, intro })} />
          {err("items") && <p className="field-error">{err("items")}</p>}
          <List
            items={s.items}
            name="feature"
            onChange={(items) => onChange({ ...s, items })}
            make={() => ({ id: uuid(), title: "", body: "", media: null })}
            render={(it, set, i) => (
              <>
                <Field label={`Feature ${i + 1} title`} required value={it.title} onChange={(title) => set({ ...it, title })} error={err(`items.${i}.title`)} />
                <Field label="Text" multiline value={it.body} onChange={(body) => set({ ...it, body })} error={err(`items.${i}.body`)} />
                <MediaPicker label="Image" value={it.media} onChange={(media) => set({ ...it, media })} data={data} err={sub(`items.${i}.media`)} />
              </>
            )}
          />
        </>
      );
    case "gallery":
      return (
        <>
          <Field label="Heading" value={s.heading} onChange={(heading) => onChange({ ...s, heading })} />
          {err("images") && <p className="field-error">{err("images")}</p>}
          {s.images.map((m, i) => (
            <MediaPicker key={m.id} label={`Image ${i + 1}`} value={m} onChange={(n) => onChange({ ...s, images: n ? s.images.map((x, j) => (j === i ? n : x)) : s.images.filter((_, j) => j !== i) })} data={data} err={sub(`images.${i}`)} />
          ))}
          <button type="button" className="button" onClick={() => onChange({ ...s, images: [...s.images, { id: uuid(), source: data.images[0] ? { kind: "asset", assetId: data.images[0].id } : { kind: "url", url: "" }, alt: "", decorative: false }] })}>
            Add image
          </button>
        </>
      );
    case "faq":
      return (
        <>
          <Field label="Heading" value={s.heading} onChange={(heading) => onChange({ ...s, heading })} />
          {err("items") && <p className="field-error">{err("items")}</p>}
          <List
            items={s.items}
            name="question"
            onChange={(items) => onChange({ ...s, items })}
            make={() => ({ id: uuid(), question: "", answer: "" })}
            render={(it, set, i) => (
              <>
                <Field label={`Question ${i + 1}`} value={it.question} onChange={(question) => set({ ...it, question })} error={err(`items.${i}`)} />
                <Field label="Answer" multiline value={it.answer} onChange={(answer) => set({ ...it, answer })} />
              </>
            )}
          />
        </>
      );
    case "cta":
      return (
        <>
          <Field label="Heading" required value={s.heading} onChange={(heading) => onChange({ ...s, heading })} error={err("heading")} />
          <Field label="Text" multiline value={s.body} onChange={(body) => onChange({ ...s, body })} />
          {err("ctas") && <p className="field-error">{err("ctas")}</p>}
          <CtaList ctas={s.ctas} onChange={(ctas) => onChange({ ...s, ctas })} data={data} err={sub("ctas")} />
        </>
      );
    case "contact":
      return (
        <>
          <Field label="Heading" required value={s.heading} onChange={(heading) => onChange({ ...s, heading })} error={err("heading")} />
          <Field label="Text" multiline value={s.body} onChange={(body) => onChange({ ...s, body })} error={err("body")} />
          <div className="two-col">
            <Field label="Email" value={s.email} onChange={(email) => onChange({ ...s, email })} error={err("email")} />
            <Field label="Phone" value={s.phone} onChange={(phone) => onChange({ ...s, phone })} />
          </div>
          <Pick label="Form for desired action (built in WF-09)" value={s.actionKind ?? ""} options={[["", "None"], ...data.actionKinds.map((k): [string, string] => [k, k])]} onChange={(v) => onChange({ ...s, actionKind: v || null })} />
        </>
      );
    case "block":
      return (
        <>
          <Pick label="Reusable block" value={s.blockId} options={[...blocks.map((b): [string, string] => [b.id, b.name]), ...(blocks.some((b) => b.id === s.blockId) ? [] : [[s.blockId, "(missing block)"] as [string, string]])]} onChange={(blockId) => onChange({ ...s, blockId })} />
          <p className="small muted">The block&apos;s content is edited once, on the Pages screen, and updates every page that uses it.</p>
        </>
      );
  }
}

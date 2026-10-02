"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type CSSProperties, type ReactNode } from "react";
import { approveBrandAction, saveBrandAction, suggestBrandAction } from "@/app/(dashboard)/projects/brand-actions";
import { BrandContent, COLOR_LABELS, COLOR_ROLES, LogoVariant, type TokenStatus } from "@/domain/brand";
import { brandIssues, brandVariables, contrastChecks } from "@/domain/brand-css";

// The WF-04 editor. The preview and the export call the same
// brandVariables(), so the preview shows exactly what will be exported.
// Variables are applied inline to the preview container only: a brand can
// never style the dashboard or another brand.

type Asset = { id: string; label: string; kind: string };
type Props = { projectId: string; brandId: string; brandKey: string; versionId: string; version: number; initial: BrandContent; assets: Asset[] };
type Tok = { value: unknown; status: TokenStatus; note: string };

const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);

export function BrandEditor({ projectId, brandId, brandKey, versionId, version, initial, assets }: Props) {
  const router = useRouter();
  const [b, setB] = useState<BrandContent>(initial);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: { path: string; message: string }[] } | null>(null);
  const [pending, start] = useTransition();

  // Validation runs live, with the same schema the server applies on save.
  const parsed = useMemo(() => BrandContent.safeParse(b), [b]);
  const fieldErrors = useMemo(() => new Map(parsed.success ? [] : parsed.error.issues.map((i) => [i.path.join("."), i.message])), [parsed]);
  const issues = useMemo(() => (parsed.success ? brandIssues(parsed.data) : []), [parsed]);
  const vars = useMemo(() => brandVariables(b), [b]);
  const contrast = useMemo(() => (parsed.success ? contrastChecks(parsed.data) : []), [parsed]);
  const errorAt = (path: string) => fieldErrors.get(path) ?? (msg && !msg.ok ? msg.issues?.find((i) => i.path === path)?.message : undefined);

  const edit = (fn: (d: BrandContent) => void) => {
    setB((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  };
  const setTok = (path: string, patch: Partial<Tok>) =>
    edit((d) => {
      const t = get(d, path) as Tok;
      Object.assign(t, patch);
      // Typing a value is deciding it, unless the person says otherwise.
      if ("value" in patch && !("status" in patch) && t.status === "default") t.status = "confirmed";
    });

  const run = (fn: () => Promise<{ ok: boolean; message?: string; issues?: { path: string; message: string }[] } & Record<string, unknown>>, success: (r: Record<string, unknown>) => string) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setDirty(false);
        setMsg({ ok: true, text: success(r) });
        router.refresh();
      } else setMsg({ ok: false, text: r.message ?? "Not saved.", issues: r.issues });
    });

  const save = () => run(() => saveBrandAction(projectId, brandId, versionId, b), () => "Saved.");
  const approve = () => run(() => approveBrandAction(projectId, brandId, versionId, b), () => `Version ${version} approved.`);
  const suggest = () =>
    start(async () => {
      const r = await suggestBrandAction(projectId, brandId, versionId);
      if (!r.ok) return setMsg({ ok: false, text: r.message, issues: r.issues });
      setMsg({ ok: true, text: r.data.applied.length ? `Filled ${r.data.applied.length} value(s) from the client's own material: ${r.data.applied.join(", ")}. Review them; they are marked inferred.` : "Nothing to suggest: no client-owned source or logo, or those values are already decided." });
      if (r.data.applied.length) window.location.reload();
    });

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  return (
    <div className="grid grid-main-side">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {msg && (
          <div className={`alert ${msg.ok ? "success" : "error"}`} role={msg.ok ? "status" : "alert"}>
            {msg.text}
            {!msg.ok && msg.issues && msg.issues.length > 0 && (
              <ul>
                {msg.issues.slice(0, 12).map((i, n) => (
                  <li key={n}>
                    <code>{i.path}</code>: {i.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="actions" style={{ marginBottom: "1rem" }}>
          <button type="button" className="button" onClick={suggest} disabled={pending || dirty} title={dirty ? "Save first" : undefined}>
            Suggest from client&apos;s own material
          </button>
          <span className="small muted">Uses the client&apos;s logos and sources they own (WF-03). Never study-only references. Never overwrites decided values.</span>
        </div>

        <Card title="Colours">
          {COLOR_ROLES.map((r) => (
            <TokenRow key={r} label={COLOR_LABELS[r]} tok={b.colors[r]} error={errorAt(`colors.${r}.value`)} onPatch={(p) => setTok(`colors.${r}`, p)}>
              {(id, describedBy) => (
                <div className="actions" style={{ flexWrap: "nowrap" }}>
                  <input type="color" aria-label={`${COLOR_LABELS[r]} picker`} value={/^#[0-9a-f]{6}$/i.test(b.colors[r].value ?? "") ? b.colors[r].value! : "#000000"} onChange={(e) => setTok(`colors.${r}`, { value: e.target.value })} style={{ width: "2.5rem", height: "2.5rem", padding: 0, border: 0, background: "none" }} />
                  <input id={id} type="text" value={b.colors[r].value ?? ""} placeholder="missing" aria-describedby={describedBy} aria-invalid={errorAt(`colors.${r}.value`) ? true : undefined} onChange={(e) => setTok(`colors.${r}`, { value: e.target.value === "" ? null : e.target.value })} />
                </div>
              )}
            </TokenRow>
          ))}
        </Card>

        <Card title="Typography">
          {(["heading", "body", "mono"] as const).map((slot) => (
            <div key={slot}>
              <TextTok label={`${slot[0].toUpperCase()}${slot.slice(1)} font family`} path={`typography.${slot}.family`} b={b} setTok={setTok} errorAt={errorAt} placeholder={slot === "mono" ? "optional" : "missing"} />
              <div className="two-col">
                <Select label="Fallback" value={b.typography[slot].fallback} options={["sans-serif", "serif", "monospace", "system-ui"]} onChange={(v) => edit((d) => void (d.typography[slot].fallback = v as never))} />
                <Select label="Font source" value={b.typography[slot].source} options={["google", "self_hosted", "adobe", "system", "other"]} onChange={(v) => edit((d) => void (d.typography[slot].source = v as never))} />
              </div>
            </div>
          ))}
          {(
            [
              ["typography.weights.regular", "Regular weight", ""],
              ["typography.weights.medium", "Medium weight", ""],
              ["typography.weights.bold", "Bold weight", ""],
              ["typography.baseSize", "Base size", "px"],
              ["typography.scaleRatio", "Type scale ratio", "×"],
              ["typography.lineHeight.body", "Body line height", ""],
              ["typography.lineHeight.heading", "Heading line height", ""],
              ["typography.letterSpacing.body", "Body letter spacing", "em"],
              ["typography.letterSpacing.heading", "Heading letter spacing", "em"],
              ["typography.letterSpacing.caps", "Caps letter spacing", "em"],
            ] as const
          ).map(([path, label, unit]) => (
            <NumTok key={path} path={path} label={label} unit={unit} b={b} setTok={setTok} errorAt={errorAt} />
          ))}
        </Card>

        <Card title="Layout">
          {(
            [
              ["layout.spaceUnit", "Spacing unit", "px"],
              ["layout.contentWidth", "Content width", "px"],
              ["layout.narrowWidth", "Narrow content width", "px"],
              ["layout.gridColumns", "Grid columns", ""],
              ["layout.gridGutter", "Grid gutter", "px"],
              ["layout.breakpoints.sm", "Breakpoint sm", "px"],
              ["layout.breakpoints.md", "Breakpoint md", "px"],
              ["layout.breakpoints.lg", "Breakpoint lg", "px"],
              ["layout.breakpoints.xl", "Breakpoint xl", "px"],
            ] as const
          ).map(([path, label, unit]) => (
            <NumTok key={path} path={path} label={label} unit={unit} b={b} setTok={setTok} errorAt={errorAt} />
          ))}
        </Card>

        <Card title="Shape and elevation">
          {(["sm", "md", "lg"] as const).map((k) => (
            <NumTok key={k} path={`shape.radius.${k}`} label={`Corner radius ${k}`} unit="px" b={b} setTok={setTok} errorAt={errorAt} />
          ))}
          {(["sm", "md", "lg"] as const).map((k) => (
            <TextTok key={k} path={`shape.shadow.${k}`} label={`Shadow ${k}`} b={b} setTok={setTok} errorAt={errorAt} />
          ))}
        </Card>

        <Card title="Motion">
          <NumTok path="motion.durationFast" label="Fast duration" unit="ms" b={b} setTok={setTok} errorAt={errorAt} />
          <NumTok path="motion.durationBase" label="Base duration" unit="ms" b={b} setTok={setTok} errorAt={errorAt} />
          <NumTok path="motion.durationSlow" label="Slow duration" unit="ms" b={b} setTok={setTok} errorAt={errorAt} />
          <TextTok path="motion.easing" label="Easing" b={b} setTok={setTok} errorAt={errorAt} />
          <TokenRow label="Motion intensity" tok={b.motion.intensity} error={errorAt("motion.intensity.value")} onPatch={(p) => setTok("motion.intensity", p)}>
            {(id) => (
              <select id={id} value={b.motion.intensity.value ?? ""} onChange={(e) => setTok("motion.intensity", { value: e.target.value || null })}>
                <option value="">missing</option>
                {["subtle", "standard", "expressive"].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
          </TokenRow>
          <Select label="When the visitor prefers reduced motion" value={b.motion.reducedMotion} options={["shorten", "remove"]} onChange={(v) => edit((d) => void (d.motion.reducedMotion = v as never))} />
        </Card>

        <Card title="Logos, images and icons">
          <AssetList
            title="Logos"
            items={b.assets.logos}
            assets={assets}
            kindOptions={LogoVariant.options}
            kindLabel="Variant"
            getKind={(l) => l.variant}
            errorAt={(i) => errorAt(`assets.logos.${i}.ref`) ?? errorAt(`assets.logos.${i}.ref.assetId`) ?? errorAt(`assets.logos.${i}.ref.url`)}
            onChange={(items) => edit((d) => void (d.assets.logos = items))}
            make={(ref) => ({ variant: d0(b.assets.logos) ? ("secondary" as const) : ("primary" as const), ref, background: "any" as const, minWidthPx: null, status: "confirmed" as const, note: "" })}
            setKind={(l, k) => ({ ...l, variant: k as never })}
          />
          <AssetList
            title="Images"
            items={b.assets.images}
            assets={assets}
            kindOptions={["hero", "texture", "people", "product", "place", "other"]}
            kindLabel="Role"
            getKind={(l) => l.role}
            errorAt={(i) => errorAt(`assets.images.${i}.ref`) ?? errorAt(`assets.images.${i}.ref.url`)}
            onChange={(items) => edit((d) => void (d.assets.images = items))}
            make={(ref) => ({ role: "hero" as const, ref, status: "confirmed" as const, note: "" })}
            setKind={(l, k) => ({ ...l, role: k as never })}
          />
          <TokenRow label="Icon library" tok={b.assets.icons.library} error={errorAt("assets.icons.library.value")} onPatch={(p) => setTok("assets.icons.library", p)}>
            {(id) => (
              <select id={id} value={b.assets.icons.library.value ?? ""} onChange={(e) => setTok("assets.icons.library", { value: e.target.value || null })}>
                <option value="">missing</option>
                {["lucide", "heroicons", "phosphor", "material-symbols", "custom", "none"].map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            )}
          </TokenRow>
          <Select label="Icon style" value={b.assets.icons.style} options={["outline", "solid", "duotone"]} onChange={(v) => edit((d) => void (d.assets.icons.style = v as never))} />
          {b.assets.icons.library.value === "custom" && (
            <Select
              label="Custom icon set (from the asset register)"
              value={b.assets.icons.customRef?.kind === "asset" ? b.assets.icons.customRef.assetId : ""}
              options={["", ...assets.map((a) => a.id)]}
              labels={Object.fromEntries([["", "choose"], ...assets.map((a) => [a.id, a.label])])}
              onChange={(v) => edit((d) => void (d.assets.icons.customRef = v ? { kind: "asset", assetId: v } : null))}
              error={errorAt("assets.icons.customRef")}
            />
          )}
        </Card>

        <div className="save-bar">
          <span className="save-status" role="status" aria-live="polite">
            {pending ? "Working…" : dirty ? "Unsaved changes" : "All changes saved"}
            {fieldErrors.size > 0 && ` · ${fieldErrors.size} invalid value${fieldErrors.size === 1 ? "" : "s"}`}
          </span>
          <div className="actions">
            <button type="submit" className="button" disabled={pending || !dirty}>
              Save draft
            </button>
            <button type="button" className="button primary" disabled={pending} onClick={approve}>
              Approve version {version}
            </button>
          </div>
        </div>
      </form>

      <aside className="stack sticky-side" aria-label="Preview and checks">
        <section className="card" aria-labelledby="preview-heading">
          <h2 id="preview-heading">Live preview</h2>
          <BrandPreview vars={vars} brandKey={brandKey} />
          <p className="small muted" style={{ marginTop: "0.5rem" }}>
            Uses the exported CSS variables. Fonts show only if installed on this computer.
          </p>
        </section>
        <section className="card" aria-labelledby="checks-heading">
          <h2 id="checks-heading">Checks</h2>
          {fieldErrors.size === 0 && errors.length === 0 && warnings.length === 0 && <p className="small">No problems found.</p>}
          {fieldErrors.size > 0 && <p className="small" style={{ color: "var(--color-danger)" }}>{fieldErrors.size} invalid value(s): see the highlighted fields.</p>}
          {errors.length > 0 && (
            <>
              <h3>Blocks approval</h3>
              <ul className="small">{errors.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
            </>
          )}
          {warnings.length > 0 && (
            <>
              <h3>Warnings</h3>
              <ul className="small">{warnings.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
            </>
          )}
          <h3>Contrast</h3>
          <ul className="checklist">
            {contrast.map((c) => (
              <li key={`${c.fg}-${c.bg}`}>
                <span>
                  {COLOR_LABELS[c.fg]} / {COLOR_LABELS[c.bg].toLowerCase()}
                </span>
                <span className={`badge ${c.passes ? "ok" : c.level === "error" ? "danger" : "warn"}`}>
                  {c.ratio}:1 {c.passes ? "pass" : `needs ${c.min}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

const d0 = (arr: unknown[]) => arr.length > 0;

// -------------------------------------------------------------- preview

function BrandPreview({ vars, brandKey }: { vars: Record<string, string>; brandKey: string }) {
  const v = (name: string, fallback: string) => `var(--scl-${name}, ${fallback})`;
  const box: CSSProperties = { ...(vars as CSSProperties), background: v("color-background", "#fff"), color: v("color-text", "#111"), fontFamily: v("font-body", "sans-serif"), fontSize: v("font-size-base", "1rem"), lineHeight: v("line-height-body", "1.5"), letterSpacing: v("letter-spacing-body", "0"), padding: v("space-5", "24px"), borderRadius: v("radius-md", "8px"), border: `1px solid ${v("color-border", "#ddd")}` };
  return (
    <div data-scl-brand={brandKey} data-testid="brand-preview" style={box}>
      <nav style={{ display: "flex", gap: v("space-4", "16px"), fontSize: v("font-size-sm", "0.875rem"), marginBottom: v("space-5", "24px") }}>
        <strong style={{ fontFamily: v("font-heading", "sans-serif"), color: v("color-primary", "#00f") }}>Brand</strong>
        <span>Work</span>
        <span>About</span>
      </nav>
      <p style={{ margin: 0, fontSize: v("font-size-xs", "0.75rem"), letterSpacing: v("letter-spacing-caps", "0.08em"), textTransform: "uppercase", color: v("color-accent", "#c00") }}>Eyebrow</p>
      <h3 data-testid="preview-heading" style={{ margin: `${v("space-2", "8px")} 0`, fontFamily: v("font-heading", "sans-serif"), fontSize: v("font-size-3xl", "2rem"), fontWeight: v("font-weight-bold", "700"), lineHeight: v("line-height-heading", "1.15"), letterSpacing: v("letter-spacing-heading", "0") }}>
        A heading in the brand
      </h3>
      <p style={{ margin: 0 }}>
        Body text, with a <span style={{ color: v("color-primary", "#00f"), textDecoration: "underline" }}>link</span>. <span style={{ color: v("color-text-muted", "#666") }}>Muted supporting text.</span>
      </p>
      <div style={{ display: "flex", gap: v("space-3", "12px"), flexWrap: "wrap", margin: `${v("space-5", "24px")} 0` }}>
        <span data-testid="preview-button" style={{ background: v("color-primary", "#00f"), color: v("color-on-primary", "#fff"), padding: `${v("space-2", "8px")} ${v("space-4", "16px")}`, borderRadius: v("radius-sm", "4px"), fontWeight: v("font-weight-medium", "500"), boxShadow: v("shadow-sm", "none"), transition: `transform ${v("duration-fast", "150ms")} ${v("easing-standard", "ease")}` }}>Primary action</span>
        <span style={{ border: `1px solid ${v("color-secondary", "#555")}`, color: v("color-secondary", "#555"), padding: `${v("space-2", "8px")} ${v("space-4", "16px")}`, borderRadius: v("radius-sm", "4px") }}>Secondary</span>
      </div>
      <div style={{ background: v("color-surface", "#f6f6f6"), borderRadius: v("radius-lg", "16px"), boxShadow: v("shadow-md", "none"), padding: v("space-4", "16px") }}>
        <strong style={{ fontFamily: v("font-heading", "sans-serif") }}>A card</strong>
        <div style={{ marginTop: v("space-2", "8px"), border: `1px solid ${v("color-border", "#ccc")}`, borderRadius: v("radius-sm", "4px"), padding: v("space-2", "8px"), background: v("color-background", "#fff") }}>Form field</div>
      </div>
      <div style={{ display: "grid", gap: v("space-1", "4px"), marginTop: v("space-4", "16px"), fontSize: v("font-size-sm", "0.875rem") }}>
        {(["success", "warning", "danger", "info"] as const).map((s) => (
          <span key={s} style={{ color: v(`color-${s}`, "#333") }}>
            {s[0].toUpperCase() + s.slice(1)} message
          </span>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- controls

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const STATUS_HINT: Record<TokenStatus, string> = { confirmed: "confirmed", inferred: "inferred", default: "default (undecided)" };

function TokenRow({ label, tok, error, onPatch, children }: { label: string; tok: Tok; error?: string; onPatch: (p: Partial<Tok>) => void; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  const missing = tok.value === null;
  return (
    <div className="field" style={{ borderBottom: "1px dashed var(--color-border)", paddingBottom: "0.75rem" }}>
      {/* The badge sits outside the label so the input's name is just the label. */}
      <div className="actions">
        <label htmlFor={id}>{label}</label>
        {missing ? <span className="badge danger">missing</span> : <span className={`badge ${tok.status === "confirmed" ? "ok" : "warn"}`}>{STATUS_HINT[tok.status]}</span>}
      </div>
      <div className="two-col">
        <div>
          {children(id, error ? `${id}-e` : undefined)}
          {error && (
            <p className="field-error" id={`${id}-e`}>
              {error}
            </p>
          )}
        </div>
        <div className="actions" style={{ flexWrap: "nowrap" }}>
          <select aria-label={`${label} status`} value={tok.status} onChange={(e) => onPatch({ status: e.target.value as TokenStatus })} style={{ maxWidth: "9rem" }}>
            <option value="confirmed">confirmed</option>
            <option value="inferred">inferred</option>
            <option value="default">default</option>
          </select>
          <input type="text" aria-label={`${label} note`} value={tok.note} placeholder="source / note" onChange={(e) => onPatch({ note: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

type TokProps = { path: string; label: string; b: BrandContent; setTok: (path: string, p: Partial<Tok>) => void; errorAt: (p: string) => string | undefined };

function NumTok({ path, label, unit, b, setTok, errorAt }: TokProps & { unit: string }) {
  const tok = get(b, path) as Tok;
  const [text, setText] = useState(tok.value === null ? "" : String(tok.value));
  // Shows exactly what was typed (e.g. "1." mid-edit); the token holds the number.
  return (
    <TokenRow label={`${label}${unit ? ` (${unit})` : ""}`} tok={tok} error={errorAt(`${path}.value`)} onPatch={(p) => setTok(path, p)}>
      {(id, describedBy) => (
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={text}
          placeholder="missing"
          aria-describedby={describedBy}
          aria-invalid={errorAt(`${path}.value`) ? true : undefined}
          onChange={(e) => {
            const t = e.target.value.trim();
            setText(t);
            setTok(path, { value: t === "" ? null : Number.isNaN(Number(t)) ? (t as never) : Number(t) });
          }}
        />
      )}
    </TokenRow>
  );
}

function TextTok({ path, label, b, setTok, errorAt, placeholder = "missing" }: TokProps & { placeholder?: string }) {
  const tok = get(b, path) as Tok;
  return (
    <TokenRow label={label} tok={tok} error={errorAt(`${path}.value`)} onPatch={(p) => setTok(path, p)}>
      {(id, describedBy) => (
        <input id={id} type="text" value={(tok.value as string | null) ?? ""} placeholder={placeholder} aria-describedby={describedBy} aria-invalid={errorAt(`${path}.value`) ? true : undefined} onChange={(e) => setTok(path, { value: e.target.value === "" ? null : e.target.value })} />
      )}
    </TokenRow>
  );
}

function Select({ label, value, options, onChange, labels, error }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void; labels?: Record<string, string>; error?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

type Ref = { kind: "asset"; assetId: string } | { kind: "url"; url: string };
type Item = { ref: Ref; status: TokenStatus; note: string };

function AssetList<T extends Item>({ title, items, assets, kindOptions, kindLabel, getKind, setKind, make, onChange, errorAt }: { title: string; items: T[]; assets: Asset[]; kindOptions: readonly string[]; kindLabel: string; getKind: (t: T) => string; setKind: (t: T, k: string) => T; make: (ref: Ref) => T; onChange: (items: T[]) => void; errorAt: (i: number) => string | undefined }) {
  const update = (i: number, t: T) => onChange(items.map((x, j) => (j === i ? t : x)));
  return (
    <div style={{ marginBottom: "1rem" }}>
      <h3>{title}</h3>
      {items.length === 0 && <p className="small muted">None recorded.</p>}
      {items.map((t, i) => (
        <div key={i} className="row-wrap" style={{ borderBottom: "1px dashed var(--color-border)", paddingBottom: "0.5rem", marginBottom: "0.5rem" }}>
          <div className="two-col">
            <Select label={`${title.slice(0, -1)} ${i + 1}: ${kindLabel.toLowerCase()}`} value={getKind(t)} options={kindOptions} onChange={(k) => update(i, setKind(t, k))} />
            <Select
              label="Location"
              value={t.ref.kind === "asset" ? t.ref.assetId : "__url"}
              options={[...assets.map((a) => a.id), "__url"]}
              labels={Object.fromEntries([...assets.map((a) => [a.id, `Register: ${a.label} (${a.kind})`]), ["__url", "External https URL"]])}
              onChange={(v) => update(i, { ...t, ref: v === "__url" ? { kind: "url", url: t.ref.kind === "url" ? t.ref.url : "" } : { kind: "asset", assetId: v } })}
            />
          </div>
          {t.ref.kind === "url" && (
            <div className="field">
              <label htmlFor={`${title}-${i}-url`}>URL</label>
              <input id={`${title}-${i}-url`} type="text" value={t.ref.url} onChange={(e) => update(i, { ...t, ref: { kind: "url", url: e.target.value } })} placeholder="https://" />
            </div>
          )}
          {errorAt(i) && <p className="field-error">{errorAt(i)}</p>}
          <div className="actions">
            <select aria-label={`${title.slice(0, -1)} ${i + 1} status`} value={t.status} onChange={(e) => update(i, { ...t, status: e.target.value as TokenStatus })} style={{ maxWidth: "9rem" }}>
              <option value="confirmed">confirmed</option>
              <option value="inferred">inferred</option>
              <option value="default">default</option>
            </select>
            <input type="text" aria-label={`${title.slice(0, -1)} ${i + 1} note`} value={t.note} placeholder="note" onChange={(e) => update(i, { ...t, note: e.target.value })} style={{ flex: 1 }} />
            <button type="button" className="button link danger small" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${title.slice(0, -1).toLowerCase()} ${i + 1}`}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="button" onClick={() => onChange([...items, make(assets[0] ? { kind: "asset", assetId: assets[0].id } : { kind: "url", url: "" })])}>
        Add {title.slice(0, -1).toLowerCase()}
      </button>
    </div>
  );
}

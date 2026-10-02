import { Fragment, type CSSProperties, type ReactNode } from "react";
import { sectionAnchor, type Cta, type LinkTarget, type MediaRef, type PageContent, type Section, type SiteSettings } from "@/domain/content";

// Shared presentation components for WF-05 pages. They take content as data
// and render it with semantic HTML; every visual decision comes from the
// brand's --scl-* variables (with neutral fallbacks in site.css). Content
// edits never touch this file; a new look is a new component or brand, not a
// content change.
//
// Stable ids from the content model appear as data-scl-* attributes and
// section anchors, for WF-08 to target.

// What every site route shares (WF-05 pages and WF-08 journeys): one header,
// navigation, footer and brand, so the cinematic and conventional tracks are
// one website.
export type ShellInput = {
  projectId: string;
  root: string; // "/site/<projectId>" or "/preview/<projectId>"
  site: SiteSettings;
  pagePaths: Map<string, string>;
  navigation: { primary: { pageId: string; label: string; path: string }[]; footer: { pageId: string; label: string; path: string }[] };
  brand: { vars: Record<string, string>; reduced: Record<string, string>; version: number; key: string } | null;
  preview: boolean;
};

// A WF-08 journey offered on its entry page (or entry section).
export type Launcher = { key: string; name: string; sectionId: string | null; poster: string | null };

export type RenderInput = ShellInput & {
  page: { id: string; revision: number; status: string; content: PageContent };
  blocks: Map<string, Section>;
  journeys?: Launcher[];
};

const href = (r: RenderInput, t: LinkTarget): string => {
  if (t.kind === "url") return t.url;
  const path = r.pagePaths.get(t.pageId);
  const base = path === undefined ? "#" : `${r.root}${path === "/" ? "" : path}` || r.root;
  return t.kind === "section" ? `${base}#${sectionAnchor(t.sectionId)}` : base;
};

const mediaSrc = (r: RenderInput, m: NonNullable<MediaRef>) => (m.source.kind === "asset" ? `/api/projects/${r.projectId}/media/${m.source.assetId}` : m.source.url);

function Img({ r, m, className }: { r: RenderInput; m: MediaRef; className?: string }) {
  if (!m) return null;
  // eslint-disable-next-line @next/next/no-img-element -- content images from the register; sizes are unknown
  return <img className={className} src={mediaSrc(r, m)} alt={m.decorative ? "" : m.alt} data-scl-media-id={m.id} loading="lazy" decoding="async" />;
}

// Plain text only: paragraphs split on blank lines. Content cannot inject markup.
const Paragraphs = ({ text }: { text: string }) => (
  <>
    {text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p, i) => (
        <p key={i}>{p}</p>
      ))}
  </>
);

function Ctas({ r, ctas }: { r: RenderInput; ctas: Cta[] }) {
  if (!ctas.length) return null;
  return (
    <div className="scl-ctas">
      {ctas.map((c) => (
        <a key={c.id} className={`scl-button scl-button--${c.style}`} href={href(r, c.target)} data-scl-cta-id={c.id} data-scl-action={c.actionKind ?? undefined}>
          {c.label}
        </a>
      ))}
    </div>
  );
}

// The page's first hero heading is its h1; every other section heading is an h2.
function H({ main, children }: { main: boolean; children: ReactNode }) {
  return main ? <h1 className="scl-h1">{children}</h1> : <h2 className="scl-h2">{children}</h2>;
}

function SectionView({ r, section, isFirstHero }: { r: RenderInput; section: Section; isFirstHero: boolean }) {
  const s = section.type === "block" ? r.blocks.get(section.blockId) : section;
  if (!s) return null;
  const wrap = (cls: string, body: ReactNode) => (
    <section id={sectionAnchor(section.id)} className={`scl-section scl-${cls}`} data-scl-section-id={section.id} data-scl-section-type={s.type} data-scl-block-id={section.type === "block" ? section.blockId : undefined}>
      <div className="scl-container">{body}</div>
    </section>
  );
  switch (s.type) {
    case "hero":
      return wrap(
        "hero",
        <div className={s.media ? "scl-split" : undefined}>
          <div>
            {s.eyebrow && <p className="scl-eyebrow">{s.eyebrow}</p>}
            <H main={isFirstHero}>{s.heading}</H>
            {s.body && <p className="scl-lead">{s.body}</p>}
            <Ctas r={r} ctas={s.ctas} />
          </div>
          <Img r={r} m={s.media} className="scl-media" />
        </div>,
      );
    case "text":
      return wrap("text", <div className="scl-prose">{s.heading && <H main={isFirstHero}>{s.heading}</H>}<Paragraphs text={s.body} /></div>);
    case "features":
      return wrap(
        "features",
        <>
          {s.heading && <H main={isFirstHero}>{s.heading}</H>}
          {s.intro && <p className="scl-lead">{s.intro}</p>}
          <ul className="scl-grid">
            {s.items.map((it) => (
              <li key={it.id} className="scl-card" data-scl-item-id={it.id}>
                <Img r={r} m={it.media} className="scl-media" />
                <h3 className="scl-h3">{it.title}</h3>
                {it.body && <p>{it.body}</p>}
              </li>
            ))}
          </ul>
        </>,
      );
    case "gallery":
      return wrap(
        "gallery",
        <>
          {s.heading && <H main={isFirstHero}>{s.heading}</H>}
          <ul className="scl-gallery">
            {s.images.map((m) => (
              <li key={m.id}>
                <Img r={r} m={m} className="scl-media" />
              </li>
            ))}
          </ul>
        </>,
      );
    case "faq":
      return wrap(
        "faq",
        <>
          {s.heading && <H main={isFirstHero}>{s.heading}</H>}
          {s.items.map((it) => (
            <details key={it.id} className="scl-faq-item" data-scl-item-id={it.id}>
              <summary>{it.question}</summary>
              <Paragraphs text={it.answer} />
            </details>
          ))}
        </>,
      );
    case "cta":
      return wrap("cta", <div className="scl-band">{<H main={isFirstHero}>{s.heading}</H>}{s.body && <p>{s.body}</p>}<Ctas r={r} ctas={s.ctas} /></div>);
    case "contact":
      return wrap(
        "contact",
        <>
          <H main={isFirstHero}>{s.heading}</H>
          <Paragraphs text={s.body} />
          <ul className="scl-contact" data-scl-action={s.actionKind ?? undefined}>
            {s.email && (
              <li>
                Email: <a href={`mailto:${s.email}`}>{s.email}</a>
              </li>
            )}
            {s.phone && (
              <li>
                Phone: <a href={`tel:${s.phone.replace(/[^\d+]/g, "")}`}>{s.phone}</a>
              </li>
            )}
          </ul>
          {s.actionKind && <p className="scl-note">The enquiry form for this section is added in WF-09.</p>}
        </>,
      );
    default:
      return null;
  }
}

const sitePath = (s: ShellInput, path: string) => `${s.root}${path === "/" ? "" : path}` || s.root;

export function SiteShell({ s, scope, currentPageId, banner, className, attrs, children }: { s: ShellInput; scope: string; currentPageId: string | null; banner: string | null; className?: string; attrs?: Record<`data-${string}`, string | number>; children: ReactNode }) {
  const style = { ...(s.brand?.vars ?? {}) } as CSSProperties;
  return (
    <div className={`scl-site ${className ?? ""}`.trim()} data-scl-brand={s.brand?.key} data-scl-scope={scope} lang={s.site.locale} style={style} {...attrs}>
      {s.brand && Object.keys(s.brand.reduced).length > 0 && (
        // Reduced-motion overrides for this brand, scoped to this wrapper.
        <style>{`@media (prefers-reduced-motion: reduce){[data-scl-scope="${scope}"]{${Object.entries(s.brand.reduced)
          .map(([k, v]) => `${k}:${v}`)
          .join(";")}}}`}</style>
      )}
      <a className="scl-skip" href="#scl-main">
        Skip to content
      </a>
      {banner && (
        <p className="scl-preview-banner" role="note">
          {banner}
        </p>
      )}
      <header className="scl-header">
        <div className="scl-container scl-header-inner">
          <a className="scl-brandname" href={s.root}>
            {s.site.siteName}
          </a>
          {s.navigation.primary.length > 0 && (
            <nav aria-label="Main">
              <ul className="scl-nav">
                {s.navigation.primary.map((n) => (
                  <li key={n.pageId}>
                    <a href={sitePath(s, n.path)} aria-current={n.pageId === currentPageId ? "page" : undefined}>
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </header>
      {children}
      <footer className="scl-footer">
        <div className="scl-container">
          {s.navigation.footer.length > 0 && (
            <nav aria-label="Footer">
              <ul className="scl-nav">
                {s.navigation.footer.map((n) => (
                  <li key={n.pageId}>
                    <a href={sitePath(s, n.path)}>{n.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <p>© {s.site.siteName}</p>
        </div>
      </footer>
    </div>
  );
}

// A plain link to the journey's own URL: works without JavaScript, and the
// page around it stays fully usable if the journey cannot play.
function JourneyLauncher({ r, j }: { r: RenderInput; j: Launcher }) {
  return (
    <aside className="scl-section scl-journey-launch" aria-labelledby={`launch-${j.key}`} data-scl-journey-key={j.key}>
      <div className="scl-container">
        <div className="scl-band">
          {j.poster && (
            // eslint-disable-next-line @next/next/no-img-element -- approved still from WF-07
            <img className="scl-media" src={j.poster} alt="" loading="lazy" />
          )}
          <h2 className="scl-h2" id={`launch-${j.key}`}>
            {j.name}
          </h2>
          <div className="scl-ctas">
            <a className="scl-button scl-button--primary" href={`${r.root}/journeys/${j.key}`}>
              Start the journey
            </a>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function SitePage({ r }: { r: RenderInput }) {
  const c = r.page.content;
  const firstHeroIndex = c.sections.findIndex((s) => (s.type === "block" ? r.blocks.get(s.blockId)?.type : s.type) === "hero");
  const firstIsHero = firstHeroIndex === 0;
  const journeys = r.journeys ?? [];
  // Section entry points sit before their section; page entry points after the first section.
  const launchersAt = (i: number, sectionId: string) => journeys.filter((j) => j.sectionId === sectionId || (j.sectionId === null && i === 1));
  return (
    <SiteShell s={r} scope={r.page.id} currentPageId={r.page.id} className={`scl-layout-${c.layout}`} attrs={{ "data-scl-page-id": r.page.id, "data-scl-revision": r.page.revision }} banner={r.preview ? `Preview of revision ${r.page.revision} (${r.page.status})${r.brand ? ` · brand v${r.brand.version}` : " · no brand applied"}. Not the published site.` : null}>
      <main id="scl-main" tabIndex={-1}>
        {!firstIsHero && (
          <div className="scl-container scl-page-title">
            <h1 className="scl-h1">{c.title}</h1>
          </div>
        )}
        {c.sections.map((s, i) => (
          <Fragment key={s.id}>
            {launchersAt(i, s.id).map((j) => (
              <JourneyLauncher key={j.key} r={r} j={j} />
            ))}
            <SectionView r={r} section={s} isFirstHero={firstIsHero && i === firstHeroIndex} />
          </Fragment>
        ))}
        {c.sections.length < 2 && journeys.filter((j) => j.sectionId === null).map((j) => <JourneyLauncher key={j.key} r={r} j={j} />)}
      </main>
    </SiteShell>
  );
}

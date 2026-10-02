import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JourneyPlayer } from "@/runtime/journey/player";
import { getDashboardStore } from "@/server/store";
import { SiteShell, type ShellInput } from "./render";

// /site/<project>/journeys/<key> and /preview/<project>/journeys/<key>: a
// WF-08 journey inside the same shell as the conventional pages. Without a
// playable bundle (not published, withdrawn, or invalid) the route still
// renders the site and sends visitors to the conventional pages.

type Params = Promise<{ projectId: string; journeyKey: string }>;
type Resolved = { shell: ShellInput; name: string; found: NonNullable<ReturnType<ReturnType<typeof getDashboardStore>["experience"]["live"]>> };

async function resolve(params: Params, mode: "preview" | "published"): Promise<Resolved | null> {
  const { projectId, journeyKey } = await params;
  const store = getDashboardStore();
  if (!store.getProject(projectId)) return null;
  const key = decodeURIComponent(journeyKey);
  let found;
  try {
    found = mode === "preview" ? store.experience.preview(projectId, key) : store.experience.live(projectId, key);
  } catch (e) {
    // Assembly failed outright: treat as unavailable rather than breaking the site.
    console.error("journey unavailable", e);
    found = { name: key, bundle: null, issues: [{ level: "error" as const, sceneId: null, message: "The journey could not be assembled." }] };
  }
  if (!found) return null;
  const shell = { projectId, root: `/${mode === "preview" ? "preview" : "site"}/${projectId}`, preview: mode === "preview", ...store.content.shell(projectId, mode) };
  return { shell, name: found.name, found };
}

export async function journeyMetadata(params: Params, mode: "preview" | "published"): Promise<Metadata> {
  const r = await resolve(params, mode);
  if (!r) return { title: "Not found", robots: { index: false } };
  return { title: `${r.name} · ${r.shell.site.siteName}`, robots: mode === "preview" || !r.found.bundle ? { index: false, follow: true } : undefined };
}

export async function JourneyRoute({ params, mode }: { params: Params; mode: "preview" | "published" }) {
  const r = await resolve(params, mode);
  if (!r) notFound();
  const { shell, found } = r;
  const b = found.bundle;
  const exitHref = b ? (b.exit.href === "/" ? shell.root : `${shell.root}${b.exit.href}`) : shell.root;
  const banner = mode === "preview" ? `Preview of the approved journey${b ? ` (version ${b.journey.version})` : ""}. Not the published site.` : null;
  return (
    <SiteShell s={shell} scope={`journey-${found.bundle?.journey.id ?? r.name}`} currentPageId={null} banner={banner}>
      <main id="scl-main" tabIndex={-1}>
        <div className="scl-container scl-page-title">
          <h1 className="scl-h1">{r.name}</h1>
        </div>
        <div className="scl-container">
          {mode === "preview" && found.issues.length > 0 && (
            <details className="scl-journey-issues">
              <summary>{found.issues.length} item(s) from assembly (preview only)</summary>
              <ul>
                {found.issues.map((i, n) => (
                  <li key={n}>
                    {i.level === "error" ? "Error" : "Warning"}: {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {b ? (
            <>
              <JourneyPlayer bundle={b} root={shell.root} debug={mode === "preview"} />
              <noscript>
                <p className="scl-note">
                  This journey needs JavaScript. <a href={exitHref}>Continue to the website</a>.
                </p>
              </noscript>
            </>
          ) : (
            <section className="scl-band" aria-label="Journey unavailable">
              <p>This journey isn&apos;t available right now.</p>
              <div className="scl-ctas">
                <a className="scl-button scl-button--primary" href={exitHref}>
                  Continue to the website
                </a>
              </div>
            </section>
          )}
        </div>
      </main>
    </SiteShell>
  );
}

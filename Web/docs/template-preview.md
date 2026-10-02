# Live template preview

You can preview and edit a generated website template inside the dashboard.

1. On the project page, in the **Website Template Pipeline** panel, choose **Preview and edit template**. That opens `/projects/:projectId/templates/:jobId`.
2. Click **Start preview**. Web starts a preview process for that template, and the page shows it in an isolated frame.
3. Edit the brand or page content. The template is rebuilt with its own runtime, and the frame reloads when the new build is ready.
4. Rearrange and refine sections, tokens and overrides on the same page: see `docs/template-structure.md`.

## Local development previews vs remote previews

| | Local development (`PREVIEW_MODE=local`) | Remote (`PREVIEW_MODE=remote`) |
| --- | --- | --- |
| Where the preview runs | A process on the computer running Web | An isolated server environment |
| Address | `http://127.0.0.1:<port>`: the computer running **your browser** | A separate preview domain with short-lived authenticated URLs |
| Who can view it | A browser on the same computer as Web | Anyone holding a valid preview URL |
| Status | **Built** | **Not built.** The mode exists and says it isn't available; nothing is faked. |

**Local previews only work when the dashboard and the browser are on the same computer.** `localhost` and `127.0.0.1` always mean the computer running the browser. If you open the dashboard from another machine, the page says so and doesn't show a frame, because that frame would load the viewer's own computer.

**Remote previews: the contract for when they're built.** A capture worker (see `docs/save-all-resources.md` → Production) would:
- run the same preview host in a container with no access to Web's data or network
- serve it on its own domain
- accept only signed, short-lived URLs issued by Web for one template and one viewer

The dashboard component already takes a preview URL, so only the manager's remote implementation would change.

`PREVIEW_MODE` defaults to `local` in development and `off` otherwise. `off` disables previews; the template stays downloadable.

## How it works

```
Dashboard page (templates/[jobId])            Web server                          Preview process (one per template)
  Start ───────────── startPreviewAction ──▶ preview manager                       node scripts/preview-host.mjs
                                              ├ workspace: extract template/ ──┐    ├ runs the template's own build.mjs
                                              │  from the stored ZIP (once)    │    │  (at start, then after each change)
                                              ├ verify runtime == SAR_HOME's   │    ├ serves dist/ on 127.0.0.1:<port>
                                              ├ free port, spawn, record pid ──┼──▶ ├ writes preview-state.json
  status every 1.2 s ◀── previewStatusAction ─┤ read state, touch heartbeat    │    └ exits if the heartbeat goes stale
  iframe reloads when buildId changes         │                                │
  Save brand/page ──── save…Action ──────────▶ writes site.config.json /       │
                                                content/pages/<id>.json ────────┘ (the host sees the change and rebuilds)
```

- **Working copy:** `$SCL_DATA_DIR/template-workspaces/<jobId>/template/`. It is extracted from the stored `website-template.zip`, without the prebuilt `dist/` and without `raw-capture/`. The stored ZIP never changes. **Reset to generated template** discards all edits and extracts again.
- **Runtime:**
  - **Static SaveAllResources templates** (`build.mjs` + `pages/`): the host runs `node build.mjs` and serves `dist/` with its own static server. Processing (brand CSS, content) is the template's own build, so the preview shows what the template really produces.
  - **Framework templates** (a `package.json` depending on Next, Nuxt, Astro, Vite, SvelteKit, Gatsby, CRA, Remix or Angular) are detected and refused with "not supported yet". No workflow produces them today, and starting their dev server means running arbitrary `npm install` code.
- **Runtime verification:** a template's runtime is code from inside a ZIP. It's only run if every file of the installation's `$SAR_HOME/app/processing/template-runtime/` (except `README.md`) is byte-for-byte identical in the template: `build.mjs`, `serve.mjs`, `lib/`, `runtime/`, `package.json`. A ZIP imported by hand with a changed `build.mjs` is refused with the file named. Without `SAR_HOME`, nothing is run.
- **Editing:**
  - Brand: name, the template's colours (hex only) and font families.
  - Page content: title, description, and the text and link fields of each section. Links must be site paths, `#anchors`, `http(s)`, `mailto:` or `tel:`.
  - Images, `srcset` and structure stay as captured.
  - Only values the template already has can change. Everything is validated, and invalid input is refused with the reason.
- **Authority (WF-03's rule):** a template from a **study-only** source can be previewed but **not edited**, because study-only sources are analysed, never reused. The page says so and the edit actions refuse. Change the source's authority in WF-03 to edit it.
- **Viewing:** page picker (every generated route), Desktop/Mobile (390 px), Refresh, **Open preview in new tab**, and the status (Starting, Building, Ready, Build failed with the build's error output). A failed build keeps showing the last good one.
- **Missing assets:** while a preview runs, the card lists local files the current build refers to but does not have, and files the page asked for that do not exist.
- **Composition:** before each build the host writes the page layouts from `composition/` (Web's `template-compose.mjs`), and changes under `composition/` trigger a rebuild like any other source.

## Isolation

**Captured pages never run with dashboard privileges:**

| Protection | What it does |
| --- | --- |
| Separate origin | Served by a separate process on `127.0.0.1:<port>`. The dashboard is usually `localhost:<port>`, so the host and therefore the cookie jar differ. The preview server never sets cookies. |
| `sandbox="allow-scripts"` on the iframe (no `allow-same-origin`, `allow-forms` or `allow-top-navigation`) | Opaque origin, so no cookies or storage and no access to the dashboard. Forms can't submit, and the page can't navigate the dashboard. |
| CSP header on every response | `connect-src 'self'` (no calls to the original site's APIs), `form-action 'none'`, `frame-ancestors` limited to the dashboard (`http://localhost:*`, `http://127.0.0.1:*`, `APP_BASE_URL`), `object-src 'none'`. The template's own meta CSP and SaveAllResources' runtime guard apply on top. |
| Read-only server | Only `GET`/`HEAD`; path traversal is refused. |
| No `Cross-Origin-Resource-Policy` header | Deliberate: inside the sandbox the page's origin is opaque, so `same-origin` would block its own CSS, images and scripts. A test caught this. |

**Open preview in new tab** has no sandbox. It still has the separate origin, the CSP and the template's runtime guard.

## Process management

- **Ports:** the first free port in `PREVIEW_PORT_MIN`–`PREVIEW_PORT_MAX` (default 4310–4399) that isn't held by another preview. Ports in use by anything else are skipped. SaveAllResources' own port 4100 is outside the range.
- **Limit:** `PREVIEW_MAX_RUNNING` previews at once (default 3). The next one asks you to stop one first.
- **Registry:** table `template_previews` (migration 11): pid, port, status, start time, last seen. Before acting on a pid, Web checks it's really that template's preview host, because pids get reused.
- **Start / Stop / Restart:**
  - Stop sends SIGTERM, then SIGKILL after 3 seconds, and only to a verified pid.
  - Restart is stop, then start.
  - Edits live in the working copy, so they survive both.
- **Abandoned processes are cleaned up three ways:**
  - The dashboard touches a heartbeat file on every status poll. A preview nobody has looked at for `PREVIEW_IDLE_MINUTES` (default 30) **stops itself**, even if Web is down.
  - Web stops idle previews and forgets dead ones when it starts and before starting another.
  - A Web restart finds running previews through the registry.

## Setup (local development)

1. Generate templates as usual: `SAR_HOME`, or a sibling `../SaveAllResources` checkout in development (see `docs/save-all-resources.md`). The same installation is used to verify template runtimes.
2. Nothing else is required. In development `PREVIEW_MODE` is `local`. Optionally set `PREVIEW_PORT_MIN`, `PREVIEW_PORT_MAX`, `PREVIEW_MAX_RUNNING` and `PREVIEW_IDLE_MINUTES` in `.env.local`.
3. Run `npm run dev`, then open a project and choose **Preview and edit template** on a generated template.
4. To use previews with `next start` locally, set `PREVIEW_MODE=local`. Production deployments should leave it `off` until remote previews exist.

## Code

| Piece | File |
| --- | --- |
| Preview host (separate process) | `scripts/preview-host.mjs` |
| Workspace: extraction, runtime verification, strategy detection, editable data | `src/server/preview/workspace.ts` |
| Process management: ports, start/stop/restart, status, cleanup | `src/server/preview/preview-manager.ts` |
| Configuration, singleton, authority check | `src/server/preview/index.ts` |
| Registry (migration 11) | `src/server/store/template-previews.ts` |
| Actions | `src/app/(dashboard)/projects/preview-actions.ts` |
| Page and UI | `src/app/(dashboard)/projects/[projectId]/templates/[jobId]/page.tsx`, `src/components/projects/template-preview.tsx` |

## Tests

- `src/server/preview/preview.test.ts`: uses a stub template runtime that bakes colour, title and heading into the HTML. Covers:
  - extraction of `template/` only
  - runtime verification (tampered, unverifiable, framework, no template)
  - editor validation
  - a running preview: isolation headers, no cookies, read-only, path traversal
  - a section edit, a brand-colour edit and a page-content edit each rebuilding the preview
  - a failed build keeping the last good one
  - stop, reset and restart
  - port conflicts, the running limit, registry recovery and idle cleanup
  - self-shutdown without a heartbeat
  - remote and off modes
- `e2e/wf-02d-template-preview.spec.ts`: the **real** SaveAllResources runtime, on a template generated by the real CLI from a test site. Covers:
  - start, a sandboxed frame with the template's CSS applied, isolation headers
  - the captured order form not reaching its endpoint
  - page and viewport controls, open in new tab
  - editing a section heading, changing a brand colour (the template's `--sar-color-*` variable) and updating the page title, each visible in the frame
  - an invalid colour refused
  - stop, start (edits kept) and restart
  - a study-only template previewable but not editable

## Limits

- **Remote previews aren't built** (see above).
- **Framework templates aren't supported** (see above).
- **Editing quality depends on SaveAllResources' field extraction.** For some sites it produces awkward fields; for example.com, a sentence became 43 one-character fields. Fixing that is a SaveAllResources change.
- **Files over the per-file extraction limit** (the 200 MB template limit) **or unsafe paths are skipped.** The page says how many were skipped.
- **Edits aren't versioned.** The working copy is the latest state. The stored ZIP stays the original, and **Reset** returns to it.
- **Licensing:** previewing runs SaveAllResources' runtime from the template. The same licensing note as for generated templates applies (`docs/save-all-resources.md`).

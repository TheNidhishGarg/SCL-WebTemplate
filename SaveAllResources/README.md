# Save All Resources → reusable website template

Reference URL → discover pages → capture with **Save All Resources** → package → templatise every
page and section → verify → export a reusable website-template ZIP.

```
npm run capture -- https://www.example.com
```

## Answers up front

| Question | Answer |
|---|---|
| Is a custom extension build required? | **Yes.** The Web Store build (2.0.6) exposes no programmatic API and only collects while its DevTools panel is open. `extension/` builds *Save All Resources (Automation Build)*, which adds an `externally_connectable` messaging interface, persistent jobs, discovery, per-page upload and recovery. |
| Must DevTools stay open? | **No.** The upstream panel reads `chrome.devtools.inspectedWindow.getResources()` and `chrome.devtools.network` (HAR), which exist only inside an open DevTools window, and an extension cannot open DevTools itself. The automation build obtains the same DevTools-protocol data (resource tree, network responses) through `chrome.debugger` from its service worker and passes it through the **unchanged** Save All Resources collection, de-duplication and zip code. The original DevTools panel still works as before. |
| Is it unattended? | **Verified unattended** in Chrome for Testing with the extension loaded (`--browser cft`, the default, and all e2e tests). In your installed Chrome (`--browser system`) the only manual step is the one-time *Load unpacked* of the extension; jobs then run without clicks. |
| Pixel-perfect clone / backend / original source? | **No.** Templates are reconstructions from browser-delivered resources. Backend behaviour, server-side features and original source code are not recovered. The verification report quantifies visual differences. |

## Repository layout

```
extension/                 automation build of Save All Resources (GPL-3.0-or-later)
  src/background/          service worker: messaging, jobs, discovery, capture, upload
  src/shared/              protocol + URL scope (also imported by the app and tests)
  build.mjs                builds extension/dist from the upstream build + src
vendor/save-all-resources-2.0.6/
  dist/                    upstream 2.0.6 build (unmodified)
  recovered-src/           original sources recovered from the 2.0.6 source map
app/
  public/sar-client.js     application-side integration module
  public/capture.html      launch page (exists only because messaging must come from a page)
  server.mjs               job API, launch-code exchange, job-scoped upload endpoints, queue
  cli.mjs                  the one command
  processing/              package → reconstruct → templatise → verify → report → export
  processing/template-runtime/  build/serve/engine/runtime guard shipped inside every template
test/fixtures/             reproducible fixture website
test/unit, test/e2e        tests
```

## How it works

```
cli.mjs ──POST job──► server.mjs ──launch URL (one-time code)──► capture.html (app origin)
                                                                       │ sar-client.js
                                                                       ▼ chrome.runtime.sendMessage
                                         Save All Resources (Automation Build) service worker
                                         ├─ validate sender origin + payload + upload destination
                                         ├─ discover: robots.txt, sitemaps, entry page nav/footer, links
                                         ├─ per page: dedicated tab → chrome.debugger → load → scroll →
                                         │   safe interaction recipes → original + rendered HTML →
                                         │   desktop/mobile screenshots → completion fetch →
                                         │   SAR processStatic/NetworkResourceToStore → SAR store →
                                         │   SAR resolveDuplicatedResources → SAR addItemsToZipWriter
                                         └─ PUT zip to /api/capture-jobs/<job>/pages/<page> (job token)
server worker thread: Packaging → Templatising → Verifying → export ZIP
```

### Application-side module (`app/public/sar-client.js`)

```js
import { createSaveAllResourcesClient } from './sar-client.js';
const sar = createSaveAllResourcesClient({ extensionId });
await sar.isExtensionAvailable();                       // { available, version, devtoolsRequired:false } | { available:false, reason }
await sar.startWebsiteCapture({ jobId, url, options, upload }); // { duplicate, status }
await sar.getCaptureStatus(jobId);
await sar.cancelCapture(jobId);
await sar.getCaptureResult(jobId);                      // page inventory, statuses, limits
await sar.retryUploads(jobId);                          // re-send captures parked after upload failures
```

Errors carry a `code`: `EXTENSION_UNAVAILABLE`, `UNAUTHORIZED_ORIGIN`, `INVALID_MESSAGE`,
`INVALID_UPLOAD_DESTINATION`, `UNKNOWN_JOB`, `DUPLICATE_JOB`, `EXTENSION_BUSY`, `TIMEOUT`.

### Messaging security
* `externally_connectable.matches` is generated from the configured app origins (`scheme://host/*`).
* Every message is checked at runtime against the exact configured origins (including port), then schema-validated (unknown options rejected, numeric bounds, recipe whitelist).
* Upload endpoints must be on a configured upload origin, scoped to the job id, without query/fragment; redirects are refused; tokens expire.
* Upload tokens are kept in `chrome.storage.session` (memory only) and are never written to manifests.
* The server accepts uploads only with the job-scoped HMAC token and from the extension origin; a separate control token lets the launch page read status/cancel; a one-time launch code keeps tokens out of URLs.

### Capture details
* Discovery: entry page, `robots.txt` (`Sitemap:` lines, `Disallow` respected by default), sitemaps and sitemap indexes (`.xml.gz` supported), navigation/footer/content links, `data-href`/`routerlink` client routes and `#/` hash routes. Scope defaults to the entry origin; extra origins via `allowedOrigins`.
* Canonicalisation keeps distinct content (path case, trailing slash, non-tracking query) and removes tracking parameters; equivalent pages are detected after capture (redirect target, `rel=canonical`, identical rendered DOM) and recorded as `alias`.
* Crawl traps: query variants per path, parameter count, numeric path patterns (calendars), URL length; unsafe links (`logout`, `delete`, `cart/add`, `checkout`, …) are never requested.
* Limits: `maxPages`, `maxDepth`, `maxDurationMs`, `maxTotalBytes`, per-resource and media size; reaching one marks discovery incomplete and records the remaining URLs.
* Login walls/CAPTCHAs are not bypassed: 401/403 pages are `inaccessible`; pages with password fields are flagged.
* Each page: dedicated tab in a job window, Network + Page enabled before navigation (the point where the panel starts recording), cache and service workers bypassed, bounded load timeout (partial capture with warning), incremental scroll for lazy media, configured click/hover/focus recipes (refuses forms, submit controls, navigating links, transactional labels), CSSOM-inserted styles materialised in the rendered DOM, desktop 1366×900 and mobile 390×844 screenshots, completion pass for referenced-but-unloaded assets (srcset candidates, `data-src`, other media queries), failures recorded, tab closed in `finally`.
* XHR/fetch response bodies are not saved by default (`includeApiResponses`); request headers and cookies are never recorded; sensitive query values are redacted.
* Retries per page (`maxRetries`), upload retries with backoff, failed uploads parked in IndexedDB and retried at the end or via `retryUploads`, watchdog alarm resumes jobs after service-worker restarts.

### Processing
* **Packaging** — per-page SAR zips preserved verbatim in `raw-capture/sar-page-zips/`; bodies de-duplicated by sha256 with every URL mapping retained; query variants and path collisions get distinct paths; versioned `manifest.json`.
* **Reconstruction** — cheerio/parse5 for HTML, postcss + postcss-value-parser for CSS (`url()`, `@import`, `image-set`, `@font-face`), spec srcset parser, `<base>` resolution, internal links to local routes (aliases followed), SVG `<use>`, lazy-loading attributes. JavaScript is copied unchanged and only scanned (dynamic imports, service workers, network APIs, realtime, streaming). Trackers removed, forms disconnected, preconnect/canonical removed, SRI dropped for rewritten files.
* **Templatising** — section detection/classification (navigation, hero, cards, gallery, testimonials, pricing, form, FAQ, CTA, content, footer), field extraction (text, rich text, links, images/srcset, placeholders, repeated items as lists only when every item yields the identical template), shared components for identical markup across pages, variants for structurally identical navigation/footer that differ in markup, page-level overrides, brand config (name, logo, favicon, contact, social, shared images), colour/font/size tokens as CSS variables, editable content per page and section, integrations placeholders. Sections that cannot be converted keep their markup and are flagged `needs_manual_review`.
* **Verification** — isolated preview origin and fresh browser context per page, no extensions/cookies, every non-local request blocked and recorded, local resource resolution, internal links, desktop/mobile screenshots compared with source screenshots under the same viewport parameters, console errors (blocked-dependency messages separated), form guard, disclosure widgets, configured recipes, and a configuration-change test (colour, brand name, a page field per page, a shared field) checking that changes appear exactly where expected.

## Install and run locally

Requirements: Node.js ≥ 20, Google Chrome or Chromium; ~400 MB for Chrome for Testing.

```bash
npm install
npx puppeteer browsers install chrome
npm run build:extension
npm run capture -- https://www.example.com --max-pages 25
```

The export is copied to `exports/<job>-website-template.zip`. Options: `npm run capture -- --help`;
all capture options are in `app/capture-options.example.json`.

Using your installed Chrome instead of Chrome for Testing:
1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`.
2. `npm run capture -- https://www.example.com --browser system`
   Use a dedicated Chrome profile without signed-in sessions: captures load pages with that profile's cookies.

Running the server on its own (for integration into another application):

```bash
npm start                      # http://localhost:4100
curl -X POST http://localhost:4100/api/jobs -H "Authorization: Bearer $SAR_APP_API_TOKEN" \
     -H "Content-Type: application/json" -d '{"url":"https://www.example.com","options":{"maxPages":10}}'
# → { jobId, launchUrl }  open launchUrl in the browser that has the extension
curl -H "Authorization: Bearer $SAR_APP_API_TOKEN" http://localhost:4100/api/jobs/<jobId>
curl -H "Authorization: Bearer $SAR_APP_API_TOKEN" -o site.zip http://localhost:4100/api/jobs/<jobId>/export
```

Without `SAR_APP_API_TOKEN`/`SAR_UPLOAD_TOKEN_SECRET`, local secrets are generated once in `data/secrets.json`.

### Configuration
* `extension/extension.config.example.json` → copy to `extension.config.json` (or env `SAR_ALLOWED_APP_ORIGINS`, `SAR_ALLOWED_UPLOAD_ORIGINS`) and rebuild. Non-localhost origins must be https.
* `app/config.example.json` → copy to `app/config.json` (or env `PORT`, `SAR_PUBLIC_ORIGIN`, `SAR_DATA_DIR`, `SAR_EXTENSION_ID`).
* `app/capture-options.example.json` → `--options file.json`.

## Deployment requirements
* App server: Node ≥ 20 behind HTTPS at the origin compiled into the extension; request body limit ≥ `maxUploadBytes` at the proxy; persistent disk for `dataDir` (budget roughly 3 × captured bytes per job).
* Secrets via environment: `SAR_APP_API_TOKEN`, `SAR_UPLOAD_TOKEN_SECRET`.
* Verification needs Chrome for Testing on the server (`npx puppeteer browsers install chrome`) and its system libraries on Linux.
* Processing runs in worker threads with a single-host queue that resumes after restarts; for multiple hosts replace `ProcessingQueue` with a shared queue.
* Extension distribution: build with production origins; ship unpacked, or pack a CRX with **your own** key (replace `extension/manifest-key.txt` with your public key) and force-install via enterprise policy. `chrome.debugger` shows Chrome's "is debugging this browser" bar during captures (suppressible only with `--silent-debugger-extension-api`).
* Licensing: the extension build is derived from Save All Resources (GPL-3.0-or-later, per its package.json); distribute it with source. The application talks to it only through messaging.

## Tests

```bash
npm test            # unit: URL scope, protocol/messaging validation, client, sitemap/robots, CSS/srcset/HTML reconstruction, sections, fields, engine, build + config changes, server auth/uploads
npm run test:e2e    # real extension in Chrome for Testing against the fixture site
```

Fixture coverage (`test/fixtures`): multiple pages with shared assets, lazy images (native and IntersectionObserver), relative paths, `<base>`, CSS `@import` (url and string), `srcset`, query-string variants (`theme.css?v=1|2`), shared/variant/unique sections, responsive CSS, a missing image, a redirect, a 403 page, robots-disallowed sitemap entry, calendar and query crawl traps, a logout link, a form posting to a third-party endpoint, analytics, an operational API call, and a never-finishing page.

E2E coverage: full pipeline and export (plus rebuilding the exported template with config edits), configured vs unauthorized origins, invalid payloads, unconfigured upload destination, duplicate jobs, extension unavailable, load timeout, cancellation, transient and persistent upload failures with recovery.

Results of the last run are in `TEST-RESULTS.md`.

## Known limitations
* The capture tab uses the browser profile it runs in (cookies included). Chrome for Testing mode uses a fresh profile; for `--browser system` use a dedicated profile.
* Upload credentials live in session memory: a job survives service-worker restarts but not a full browser restart (it fails with a clear error; start a new job).
* One active job per extension instance (`EXTENSION_BUSY`).
* Templates are built from the **rendered** DOM and keep the site's scripts. Script-rendered sites (SPAs) may re-render and overwrite edited content; the configuration-change check reports such sections. Shadow DOM, canvas/WebGL, cross-origin iframes and streaming media (HLS/DASH) are not templatised and are reported.
* JavaScript is never rewritten: absolute-path dynamic imports, runtime-built asset URLs and API calls inside scripts may not resolve; they are reported, and API calls are blocked by the runtime guard and CSP.
* Section classification and field naming are heuristic; review `section-inventory.json`. Lists are created only when every item has identical markup, so items differing in a class (e.g. "active") stay individual fields or become component variants.
* Client-side routes that are never linked from the DOM, sitemaps or menus cannot be discovered.
* Verification takes roughly 20–25 s per page; screenshot differences are indicative, not a pixel-perfect guarantee.
* Data URIs are not saved as files (they stay inline). Resources above `maxResourceBytes`/`maxMediaBytes` are skipped and listed.

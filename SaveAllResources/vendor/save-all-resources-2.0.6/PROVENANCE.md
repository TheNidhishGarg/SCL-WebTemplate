# Save All Resources 2.0.6 — provenance

* Extension: "Save All Resources" by up209d, Chrome Web Store id `abpdnfjocnmdomablahdcfnoggeeiedb`,
  homepage https://github.com/up209d/ResourcesSaverExt, license GPL-3.0+ (package.json).
* `dist/` — the installed 2.0.6 build copied from the Chrome profile, unchanged, without `_metadata/`
  (Web Store signatures) and without source maps.
* `recovered-src/` — the extension's own sources (`src/devtoolApp/**`, `src/devtool.app.js`,
  `package.json`) extracted verbatim from `sourcesContent` of `devtool.app.d.js.map` in the same build.
  Third-party `node_modules` sources were not extracted.

## What the automation build reuses unchanged
| Upstream module | Used for |
|---|---|
| `utils/resource.js` — `processStaticResourceToStore`, `processNetworkResourceToStore` | collecting resources (incl. its fetch fallback for resources without cached content) |
| `store/reducers.js` and slices | the resource store (same reducer semantics as the panel's `useReducer`) |
| `utils/url.js` — `resolveURLToPath` | URL → folder-preserving path (via the processors) |
| `utils/file.js` — `resolveDuplicatedResources`, `addItemsToZipWriter`, `getContentRead` | duplicate resolution and zip packaging (zip.js), optional beautify |

## What differs
| Upstream | Automation build | Why |
|---|---|---|
| `chrome.devtools.inspectedWindow.getResources()` / `onResourceAdded` | `Page.getResourceTree` + `Page.getResourceContent` via `chrome.debugger` | `chrome.devtools.*` exists only while DevTools is open |
| `chrome.devtools.network.getHAR()` / `onRequestFinished` | `Network.*` events + `Network.getResponseBody` | same |
| `downloadCompleteZip` (anchor download) | zip Blob uploaded to a job-scoped endpoint | no per-page manual downloads |
| `resolveURLToPath` drops the query string | an additional deterministic `__q<hash>` suffix for URLs with a query | `?v=1` / `?v=2` otherwise collide |
| empty `background.js` | automation service worker | messaging, jobs, discovery |

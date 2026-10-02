# SCL Web

Website and cinematic-journey production system, built module by module (WF-01 to WF-10).

| Module | Status | Docs |
| --- | --- | --- |
| WF-01 Client brief and specification | Implemented | [docs/wf-01.md](docs/wf-01.md) |
| WF-02 Reference website acquisition | Implemented (SaveMyResources capture is manual; SaveAllResources: Generate Website Template from a URL, with extension capture and ZIP import as alternatives) | [docs/wf-02.md](docs/wf-02.md), [docs/save-all-resources.md](docs/save-all-resources.md) |
| Template preview (generated website templates) | Implemented for local development: live preview with the template's own runtime, brand and content editing; remote previews not built | [docs/template-preview.md](docs/template-preview.md) |
| Template structure (deterministic, no models) | Implemented: page composition by region (reorder, duplicate, insert, remove, merge, split, exclude by selector), token provenance with fallbacks and per-declaration overrides, four-state page/section status, checks, missing assets in the preview, edited-template export | [docs/template-structure.md](docs/template-structure.md) |
| WF-03 Source analysis and template extraction | Implemented (deep analysis is done in VS Code with Claude Code via the analysis kit) | [docs/wf-03.md](docs/wf-03.md) |
| WF-04 Brand configuration and design tokens | Implemented | [docs/wf-04.md](docs/wf-04.md) |
| WF-05 Content and page generation | Implemented (own content store; no SCL CMS API available) | [docs/wf-05.md](docs/wf-05.md) |
| WF-06 Cinematic journey planning | Implemented (planning only; no video, no runtime) | [docs/wf-06.md](docs/wf-06.md) |
| WF-07 AI video asset production | Implemented (Runway and Veo adapters untested against live APIs: no credentials yet; Flow via manual upload) | [docs/wf-07.md](docs/wf-07.md) |
| WF-08 Journey integration and composite website | Implemented (Chromium-tested only; no captions or forms yet: no transcript field in WF-06, forms are WF-09) | [docs/wf-08.md](docs/wf-08.md) |
| WF-09 to WF-10 | Not started | |

## Requirements

Node 24 (see `.nvmrc`; uses the built-in `node:sqlite`) and npm.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Dashboard at http://localhost:3000. Data goes to `.data/` |
| `npm run typecheck` | Generate route types, then `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit and store tests (Vitest; the store tests use a real SQLite file) |
| `npm run test:e2e` | Production build, then the Playwright suite against it, on a throwaway `.e2e-data/`. The first time, run `npx playwright install chromium` |
| `npm run check` | typecheck + lint + unit tests |
| `npm run build` / `npm start` | Production build and server. `start` needs `APP_BASE_URL` (https) and, until sign-in exists, `DASHBOARD_ALLOW_UNAUTHENTICATED=true` |

## Configuration

Copy `.env.example` to `.env.local`. Every variable is optional for local development. Each provider block is all-or-nothing: leave it empty and the integration stays off, fill it partially and the server refuses to start with a list of what is missing.

## Layout

```
src/domain/        Typed, validated domain model (Zod). Shared by server and client; no I/O.
src/server/        Server-only: env, access check, the store (SQLite + uploads), the WF-02 URL check, the WF-03 scanner.
src/app/(dashboard) Dashboard pages and Server Actions.
src/app/api/       Route handlers: uploads, downloads, and each module's handoff.
src/app/(site)     The rendered website: /preview and /site.
src/site/          Shared page components (content in, branded HTML out) and the site shell.
src/runtime/       The WF-08 journey runtime: bundle contract, Journey Controller, player. Provider- and project-independent.
src/components/    Dashboard UI components.
e2e/               Playwright acceptance tests.
docs/              Module documentation.
```

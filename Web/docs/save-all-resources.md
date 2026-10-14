# SaveAllResources in SCL Web

## The primary flow: Generate Website Template

1. Open a project.
2. Enter a website URL.
3. Click **Generate Website Template**.

Web runs **SaveAllResources** in the background and shows its progress. When it finishes, Web stores the website-template.zip it produced, then moves it through the workflows on its own:

| Stage | What happens |
| --- | --- |
| SaveAllResources | Captures and reconstructs the site |
| Artifact | Web stores the website-template.zip it produced |
| **WF-02** | Registers it as a capture |
| **WF-03** | Registers it as a source and runs the analysis |
| **WF-04 / WF-05** | Continue only as far as their existing approvals allow |

There's no terminal step, no download or upload, and no workflow to start by hand. The **Website Template Pipeline** panel on the project page shows every stage: done, running, waiting for a person (with a link), blocked, failed or cancelled. It also has **Cancel** and, where safe, **Retry registration**.

```
Project page form (URL, authority, max pages/depth)
  → template job (SQLite `template_jobs`, holds the one-run lock)
  → runner: SaveAllResources' own CLI as a separate process
       node $SAR_HOME/app/cli.mjs <url> --max-pages N --max-depth D --max-minutes M --out <run>/out
       (SaveAllResources starts its own server, Chrome for Testing and extension, captures,
        reconstructs template/, verifies, and writes <out>/<sarJob>-website-template.zip)
  → Web stores that exact ZIP as an artifact (SHA-256, downloadable)
  → WF-02  reference (found or created) + capture, tool "SaveAllResources", SaveAllResources job id
  → WF-03  source (study_only, or client_owned if declared with who authorised it) + analysis
  → WF-04  only from a client_owned source: brand draft + existing suggestions; never approved by the pipeline
  → WF-05  only with an approved brief: page drafts from the brief; never published by the pipeline
```

### Alternatives, on the References page

- **Capture with the browser extension:** for pages only the user's own browser can open. The extension sends page packages straight to Web. It captures but **doesn't reconstruct a template**. It needs `SAR_EXTENSION_ID` and `SAR_UPLOAD_ORIGIN`; setup is in the last section.
- **Import a Save All Resources ZIP:** accepts two kinds of ZIP, under the same WF-02 limit.
  - A website-template.zip that already exists, for example one made on another machine or kept for debugging. It goes through the same importer.
  - A download from the **Chrome Web Store build** of Save All Resources (DevTools → Save All Resources). It has no `manifest.json`, only one folder per host (`www.example.com/index.html`, `fonts.gstatic.com/…`). Web recognises it (`detectSarDownload`) and starts a template job from it: the runner calls `node $SAR_HOME/app/cli.mjs --import <zip> --entry-url <url> --out <run>/out`, and the job then continues exactly like a generated one (artifact, WF-02, WF-03, preview). The site is the host named by the ZIP file, or the host folder with the most HTML pages, over https; the form's optional *Page address* overrides it. Every HTML file of that host becomes a page. Because the download records no URLs, query strings, rendered DOM or screenshots, references are matched by Save All Resources' own path rule, and screenshot comparison is skipped. Importing needs `SAR_HOME` with dependencies installed, but not the extension build.

## Code

| Piece | File |
| --- | --- |
| Runner: starts, watches, cancels and times out the CLI; finds the ZIP; reattaches after a restart; cleans up | `src/server/integrations/sar-runner.ts` |
| Job persistence and the stored artifact | `src/server/store/template-jobs.ts` (migration 10, `template_jobs`) |
| Pipeline: a state machine over `sar → artifact → wf02 → wf03 → wf04 → wf05`, calling existing workflow functions only | `src/server/pipeline/template-pipeline.ts`, `src/server/pipeline/index.ts` |
| SaveAllResources ZIP importer (validation, WF-02 capture metadata, WF-03 registration data) | `src/server/integrations/save-all-resources.ts` |
| UI: form and pipeline panel | `src/components/projects/generate-template.tsx` |
| Actions and download | `src/app/(dashboard)/projects/template-actions.ts`, `GET /api/projects/:id/template-jobs/:jobId/artifact` |
| Gates reopening: approving the brief, or changing a source's authority, continues waiting pipelines | `saveAndApproveAction`, `updateAuthorizationAction` |

The workflows themselves are unchanged. The pipeline calls the same store functions a person's clicks call:
- `references.add`, `references.addCapture`
- `sources.registerFromCapture`, `sources.runScan`
- `brands.create`, `brands.suggest`
- `content.generateFromBrief`

## Setup

**Requirements:**
- Node 20 or later
- a SaveAllResources checkout with `npm ci` run, Chrome for Testing (`npx puppeteer browsers install chrome`, about 150 MB) and `npm run build:extension`

The extension build is compiled for `localhost:4100`, where SaveAllResources' CLI runs its own server.

**Configuration (`.env.local`):**

```
SAR_HOME=/absolute/path/to/SaveAllResources
SAR_MAX_PAGES=10     # defaults; the form can change pages and depth
SAR_MAX_DEPTH=3
SAR_MAX_MINUTES=15   # capture time limit; Web allows 20 more minutes for processing, then stops the run
```

- **Development:** if `SAR_HOME` isn't set, Web uses a sibling `../SaveAllResources` checkout if one exists.
- **Production:** `SAR_HOME` must be set explicitly.
- **If it's missing or unusable:** the app still runs, and the card explains what's missing (folder, `app/cli.mjs`, `package.json`, installed dependencies, extension build). The alternatives stay available.

Web passes SaveAllResources only `SAR_DATA_DIR` (a per-run folder) plus basic variables: `PATH`, `HOME`, locale, temp folders and the Puppeteer cache. It never passes Web's own settings or secrets.

## Behaviour

**One run at a time.** SaveAllResources owns port 4100, so only one generation runs per machine. This is enforced three ways:
- a unique `run_lock` in the database, so it survives restarts and isn't just a flag in memory
- the runner's own check
- a probe of port 4100, which catches a capture started outside Web

A second request gets "SaveAllResources is busy".

**Progress** comes from SaveAllResources' `job.json`. It's read defensively, because it's internal to SaveAllResources and not a contract. Web shows a stage (starting, capturing, packaging, templatising, verifying, finishing) and real page counts when they're available. It never shows a made-up percentage.

**Cancel** sends SIGINT, SaveAllResources' own graceful cancel. The job stays "running" until the process has actually ended, and only then becomes cancelled. If the process doesn't stop within 90 seconds, its whole process group, Chrome included, is killed. A cancelled job never reaches WF-02 or WF-03.

**Timeout:** after `SAR_MAX_MINUTES` plus 20 minutes, Web interrupts the run and then kills it. The job fails with the reason.

**Restart:**
- A run whose process survived a Web restart is reattached. Web checks it's really that run's command, follows it to the end, and judges the result by SaveAllResources' recorded status and the ZIP.
- Otherwise the job is marked **interrupted**, with nothing registered and the lock released, so no job is left showing "running" forever.
- A job that had already stored its ZIP resumes registration without duplicating anything.

**Handoff.** The pipeline only proceeds after **exit code 0 and a ZIP in the run's `out` folder**. It then:
1. checks the ZIP with the existing importer
2. stores it **byte for byte** (`uploads/<project>/template-jobs/<job>/…`)
3. checks that its SHA-256 matches the file SaveAllResources wrote

The stored artifact is the source artifact of record. It's never rebuilt or repackaged.

**Size limit: 200 MB, one constant.** Maximum website template size is **200 MB**: `MAX_CAPTURE_BYTES` in `src/domain/reference.ts`.
- **Semantics:** binary megabytes, **inclusive**. Exactly 209,715,200 bytes is accepted; 209,715,201 is refused. This is the same convention as the former 50 MB limit (52,428,800 bytes).
- **What derives from it:**

  | Use | Value |
  | --- | --- |
  | WF-02 capture uploads and their request-size checks | the limit |
  | The manual ZIP import, with its client-side check and messages | the limit |
  | WF-03 registration of a capture as a source | the limit (direct repository uploads keep their own 100 MB, `MAX_SOURCE_BYTES`) |
  | The extension path's per-job upload total and packaged size | the limit |
  | The extension's capture budget | 40% of the limit |
  | WF-03's expansion guard for any archive (`readArchive`) | 2× the limit = 400 MB. Real SaveAllResources templates expand about 1.3×. |
  | The pipeline's retention ceiling for oversized artifacts (`MAX_TEMPLATE_ARTIFACT_BYTES`) | 2.5× the limit = 500 MB |

- **Over the limit:** a generated artifact over 200 MB is **kept and downloadable**, up to the retention ceiling. WF-02 is marked *blocked* with the exact size and limit, and nothing is registered.
- **Typical sizes:**

  | Template | Size |
  | --- | --- |
  | Real one-page site | 42.5 MB |
  | Test site with 5 large images | 140 MB, went through WF-02 and WF-03 |
  | Test site with 10 large images | 280 MB, blocked |

  Image-heavy pages grow fast, because SaveAllResources stores each image several times: raw capture, page package and template assets.

**Memory.** Large files are handled without unnecessary copies:
- the runner hashes the ZIP in 4 MB chunks
- validation unpacks only `manifest.json` (every entry is still listed and checked)
- artifact, capture and source-archive downloads are streamed from disk

What still holds a whole file in memory is the existing byte-based WF-02 and WF-03 code:
- `addCapture` and `register` read the file whole
- WF-03 unpacks it fully to validate and to analyse
- the manual-import and extension upload routes buffer the request body

At 200 MB, expect several hundred MB of peak memory during registration and analysis. Streaming WF-02 and WF-03 storage would be a separate change.

**Request and proxy limits.** Next.js applies no body limit to these Route Handlers here: `next.config.ts` sets none and there's no middleware or proxy. Server Actions (1 MB) carry no files. A reverse proxy in front of Web must allow **at least 200 MB** request bodies for `POST …/references/import/save-all-resources`, `POST …/references/:id/captures` and the extension's `PUT …/capture-jobs/:job/pages/:page`, and enough time for them. The generated-template path itself makes no upload: the ZIP never crosses HTTP.

**Idempotent.** Every step checks what the job already recorded and what exists (a capture or source with the same SHA-256), so retries, reopened gates and restarts never create a second capture or source. The automated ZIP analyses to the same digest as a manual import of the same file, which is tested.

**Authority.**
- New sources are `study_only` unless the form declares **client-owned** and says who authorised it. Ownership is never inferred from a URL.
- `study_only` sources are analysed but never extracted, and WF-04 waits.
- Raising a source's authority later in WF-03 continues WF-04.

**Gates:**
- WF-04 waits for client-owned authority. When it continues, it prepares a brand draft, and suggestions only fill open fields.
- WF-05 waits for brief approval.
- Approving the brief continues WF-05, which creates page drafts.
- Nothing is approved or published by the pipeline.

**Cleanup.** Each run uses `<SCL_DATA_DIR>/sar-runs/<jobId>/`, isolated by a validated job ID, with:
- `out/`: the ZIP as SaveAllResources wrote it
- `sar-data/`: SaveAllResources' working data
- `sar.log`

After a successful handoff, `sar-data/` (the bulky part) is deleted, and the log and ZIP copy stay for debugging. Run folders older than **7 days** are pruned when the pipeline starts up or starts a run. Failed runs keep everything until then. Job rows and stored artifacts are never deleted by cleanup.

**Security:**
- URLs must be http(s), without credentials, at most 2,000 characters.
- SaveAllResources is started with an **argument list**, never a shell string. A validated URL can't be read as an option.
- Run folders are named from validated job IDs, so they can't escape their parent folder.
- Error messages are cleaned of filesystem paths, and the UI never shows internal paths.
- Every action checks dashboard access and that the job belongs to the project. Another project's job is reported as not found and can't be cancelled.

## Production

The local child process needs SaveAllResources, Chrome for Testing and the port on the **same machine** as Web.

For production, put a **capture worker** behind the same `TemplateRunner` interface:
1. A host with Node, Chrome for Testing and SaveAllResources installed takes queued jobs from Web.
2. It runs the same CLI.
3. It uploads the ZIP back to Web over HTTPS with a short-lived token tied to that one job. That token design is already used and tested for extension uploads in `sar-captures.ts`.

The pipeline and workflows don't change. **Not built yet.**

## Licensing and the process boundary

- **No SaveAllResources code is copied into Web, imported by Web, or vendored.** Web starts SaveAllResources' command-line tool as a separate operating-system process. It exchanges only a URL and options going in, and an exit code, the files it writes (the ZIP and `job.json` for progress) and signals coming back. SaveAllResources stays its own repository, unchanged and independently runnable.
- SaveAllResources (and the extension it's built from) is licensed GPL-3.0(-or-later).
- **Generated SaveAllResources templates may contain SaveAllResources runtime code. Licensing/distribution of generated templates requires project/legal review before commercial client delivery.** The template's `template/` folder includes SaveAllResources' `build.mjs`, `serve.mjs`, `lib/` and `runtime/sar-runtime.js`.
- Captured sites belong to their owners. That's why captures default to `study_only`.

This document describes a technical boundary. It isn't a legal conclusion.

## Discrepancies found and fixed in this change

| Before | After |
| --- | --- |
| The project page's top card was the extension capture, and the brief's "Next" pointed to it | The project page's single primary card is **Generate Website Template** (`#generate`). The extension capture is on the References page, labelled as an alternative. |
| The ZIP import said "exports/<job>-website-template.zip", implying a manual SaveAllResources run | Labelled **Manual fallback**, with copy pointing to the primary flow |
| `sarSourceRegistration()` always registered `study_only` | It takes an explicit authority (default `study_only`), so a declared client-owned source goes through WF-03's normal validation |
| These docs described the extension as primary | Rewritten (this file, `wf-02.md`, README) |

`sar_capture_jobs` (extension uploads) and `template_jobs` (CLI runs) are kept apart on purpose. They are different mechanisms with different authentication. They aren't duplicate status models.

## Tests

- `src/server/integrations/sar-runner.test.ts`: uses a stub SaveAllResources with the same command-line interface and no browser. Covers:
  - `SAR_HOME` and CLI checks
  - starting the process, success, failed exit, missing ZIP
  - cancel (graceful, only after exit), timeout (interrupt, then kill)
  - one run at a time, the port probe
  - reattach after restart (alive, dead and foreign pids)
  - progress parsing, a clean environment, cleanup and pruning
- `src/server/pipeline/template-pipeline.test.ts`: the real store and runner with the stub. Covers:
  - success through WF-02 and WF-03, with gates holding at WF-04 and WF-05
  - gates reopening (brief approval, then authority) with no duplicates
  - client-owned declared or refused
  - URL validation
  - failures (SaveAllResources failed, no ZIP, malformed ZIP) registering nothing
  - cancel, the durable lock, restart recovery and resumption
  - the size rule: 49 MB, a realistic 150 MB and exactly 200 MB all go through WF-02 **and** WF-03; 200 MB + 1 byte is kept and blocked
  - a large malformed ZIP fails without storing anything
  - the artifact limit
- `e2e/wf-02c-template-generation.spec.ts`: the **real** SaveAllResources CLI against a small test site, from the project page. Covers:
  - the ZIP is a real SaveAllResources export
  - Web's shown SHA-256 = the served artifact = SaveAllResources' output file
  - WF-02 capture and WF-03 source and analysis, with no duplicates
  - WF-04 and WF-05 waiting
  - the same digest as a manual import
  - a **real** 140 MB template passing WF-02 and WF-03, with SaveAllResources' output = stored = served SHA-256
  - a **real** artifact over 200 MB (about 280 MB), kept and blocked with its exact size
  - the fallback refusing a ZIP of 200 MB + 1 byte
- `e2e/wf-02b-sar-capture.spec.ts`: the extension alternative and the ZIP fallback.

## The extension alternative: setup

Build the extension from the SaveAllResources repository for Web's address:

```
SAR_ALLOWED_APP_ORIGINS=… SAR_ALLOWED_UPLOAD_ORIGINS=… SAR_EXTENSION_OUT=<Web>/.sar-extension npm run build:extension
```

Then run `git checkout -- extension/src/background/build-config.js` in that repository, because the build rewrites that tracked file. Install the build unpacked in Chrome, and set `SAR_EXTENSION_ID` and `SAR_UPLOAD_ORIGIN`.

The page packages are uploaded with a short-lived token tied to one job and repackaged in Web (`sar-captures.ts`, `sar-package.ts`).

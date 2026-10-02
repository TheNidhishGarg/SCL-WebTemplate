# Template structure: sections, composition, tokens, status and export

A website template generated from a reference URL becomes an editable site in Web: separate pages and sections, editable text, brand tokens, a page composition you can rearrange, a status for every page and section, checks and a downloadable deliverable. Everything is deterministic: **no language model, AI service or inference is used anywhere in this pipeline**, and the result is edited and built without one.

It sits on the existing template page, under the live preview: **Projects → a project → Website Template Pipeline → Preview and edit template**. There is no separate dashboard.

## The pipeline, and who does what

```
Reference URL ─▶ discover pages ─▶ capture resources ─▶ repair local references ─▶ sections, content, tokens   (SaveAllResources, unchanged)
                                                                                         │ website-template.zip
                                                                                         ▼
   composition + regions ─▶ token provenance and fallbacks ─▶ explicit overrides ─▶ status per page and section   (Web)
          ─▶ live preview (missing assets shown) ─▶ checks ─▶ export
```

SaveAllResources is the capture provider. Web runs its CLI as a separate process and consumes the ZIP it produces (see `docs/save-all-resources.md`). **The integration boundary is unchanged:** same CLI, same arguments, same ZIP. Nothing in the SaveAllResources repository was modified, and no SaveAllResources code is copied into Web.

### What Web receives, and what it is used for

| In the ZIP (from SaveAllResources) | Used by Web for |
| --- | --- |
| `template/` (pages/, components/, layouts/, content/, assets/, site.config.json, site.config.reference.json, build.mjs and runtime) | The editable working copy. Its own `build.mjs` builds every preview and check, unchanged. |
| `template/layouts/<page>.html` (`{{@section}}` placeholders) | The page composition: runs of sibling placeholders become regions |
| `manifest.json` → `resources[]` (`localPath` ↔ `templatePath`) | Matching each generated stylesheet to the captured one, for token provenance |
| `raw-capture/resources/**.css` | The captured declarations behind each token use |
| `section-inventory.json` (type, classification, source selector, processing and verification status, interaction dependencies, unsupported content) | Section status; copy safety (interactions) |
| `page-inventory.json` (capture and template status, HTTP status, skipped URLs, limits, discovery) | Page status, including pages that were not captured |
| `verification-report.json` (generation-time checks: load, resources, links, console, screenshot comparison, interactions) | Page status ("at generation") |
| `raw-capture/` (original and rendered HTML, screenshots, per-page packages) | Kept as is in the export |

Nothing needed for this pipeline was missing from the ZIP, so the integration did not have to change.

### Requirements and where they are met

| Requirement | Where |
| --- | --- |
| Start, progress, cancel, retries, upload | Web's runner and capture jobs (`docs/save-all-resources.md`) |
| Whether DevTools must stay open | **No.** The CLI drives the automation build of the extension through `chrome.debugger` (each page's `captureEngine` says "collector via chrome.debugger"). The browser-extension alternative is the one where DevTools is involved. |
| Discovery: origins, de-duplication, limits, incomplete discovery, lazy scrolling, safe interactions, no form submissions | SaveAllResources. Web reports incomplete discovery, limits reached and URLs left over on the template page. |
| Repairing local references (assets, `<base>`, `srcset`, CSS `@import` and `url()`, internal links) and blocking analytics, forms and outside calls | SaveAllResources' reconstruction and runtime guard. Web adds the preview's CSP. |
| Separating pages and sections, stable IDs, shared partials | SaveAllResources' segmentation; Web reads it and never re-segments |
| Explicit selector overrides (split, merge, exclude) | **Web** (below) |
| Reordering, removing, duplicating and inserting sections through the page composition configuration | **Web**: `composition/<page>.json` |
| Duplicate IDs and script dependencies when copying | **Web** |
| Tokens mapped back to the original declarations, original values kept as defaults, explicit overrides, no global replacement by Web | **Web**: `tokens/token-map.json` |
| A report of values that still need direct source edits | **Web**: `reports/source-edits.json` |
| A status for every page and section (four states) | **Web**: `reports/coverage.json` |
| Live preview: rebuild on change, start/stop/open, page picker, separate origin, build errors | Web (`docs/template-preview.md`) |
| Live preview: missing assets | **Web** |
| Verifying section insertion, removal, reordering, duplication and content/token changes | **Web**: Run checks, plus the unit and end-to-end tests |
| Export: raw capture, runnable template, manifests, reports, editing guide | **Web**: Download edited template |

## Composition: regions

A generated layout places sections with `{{@section <id>}}` placeholders. Placeholders separated only by whitespace are siblings inside one wrapper element; that run is a **region**. When the template is opened, Web writes:

- `composition/skeletons/<page>.html`: the generated layout with each run replaced by `{{@region rN}}`. Everything else is byte-for-byte the generated layout.
- `composition/<page>.json`: the page's regions and the ordered items in each. An item is a section, a merged group, or the frame of a split section.

`compose.mjs` (Web's script, copied into the template) writes `layouts/<page>.html` from these, and the generated `build.mjs` builds from the layouts as before. Composing an unchanged composition reproduces the generated layout byte-for-byte, whitespace included. This has been checked on real generated templates.

Sections move **within their region**. A move into another region would change the markup around it (for example from inside `<main>` to after it), so it is not offered. Edit the skeleton for that.

## Section operations and overrides

Everything is on the **Sections** card for the page selected in the preview. Each change is applied to the template's own source files and recorded in `overrides.json`.

| Operation | What happens |
| --- | --- |
| Move ↑/↓ | Reorders the item within its region |
| Remove / Restore | Takes the item off the page (kept in the composition's `removed` list) or puts it back |
| Duplicate | An independent copy right after the original: its own component (`components/pages/<page>/<id>-copyN.html`) and its own content |
| Insert section | A copy of any page's section, at a chosen position in a chosen region |
| Merge with next / Unmerge | Adjacent items in one region become one unit that moves together; the markup is not changed |
| Split | Splits a section at elements matching a selector (they must be siblings). The section's wrapper (its root, down to their parent) stays as a **frame** around a new region; each piece becomes a section. Content is divided by the fields each piece uses; the frame's own text moves to `content.page.frames.<section>` and stays editable. |
| Exclude by selector | Removes matching elements on this page. If the selector matches a section's root, the section is removed. Shared markup (header, footer) is copied for this page first, so other pages keep theirs. |

**Duplicate IDs.** A copy's ids get a suffix (`features` → `features-s03-cards-copy1`), and references inside the copy are updated too: `for`, `aria-labelledby`/`-describedby`/`-controls` and the like, `href="#…"`, `data-target`, `url(#…)`.

**Unsafe operations are flagged.** Copying asks for confirmation (**Copy anyway**) when:
- the section contains a script
- the generator recorded interactions for it (forms, menus, tabs)
- scripts refer to one of its ids (which the copy renames)
- its ids are built from content

The reasons are kept with the override.

**Refused, with the reason:**
- splitting elements repeated from a list (`{{@each}}`); edit the list's items in the content instead
- splitting at elements that aren't siblings
- splitting a section without a single root element
- a selector that matches nothing
- a merge across regions or of non-adjacent items

**Selectors** support tag, `*`, `#id`, `.class`, `[attr]` and `[attr=value]` (also `~=`, `^=`, `$=`, `*=`), descendant and child (`>`) combinators, and comma-separated lists. Anything else is refused rather than guessed. They match the template's markup, which keeps the captured page's classes and structure. Text inside rich-text content fields is not searched.

**Undo and reprocess.** **Undo** on an override, or **Reprocess from generated template**, rebuilds the working copy from the stored ZIP and replays the remaining overrides in order. Text and brand edits are then put back wherever their field still exists. An override that no longer applies is kept and marked failed, with the reason. A running preview is restarted on the new copy.

## Design tokens

The generated stylesheets use `var(--sar-color-*)` and `var(--sar-font-*)` wherever the captured CSS had that colour or font. When a template is opened, Web:

- **adds the captured value as each var()'s fallback**: `color: var(--sar-color-primary, #b45309)`. The stylesheet still renders as captured if a token is removed from the configuration.
- **records every declaration that uses a token** in `tokens/token-map.json`:
  - file, selector (including enclosing `@media`), property and line
  - the token(s)
  - the **captured declaration's value** and the raw stylesheet it came from
  - its current value and state

  The generated stylesheet is the captured one with values rewritten in place. When both have the same declarations in the same order, they are matched one to one ("raw-capture"); otherwise the token's captured value from `site.config.reference.json` is used, the binding says "reference-config", and the stylesheet is listed as unmatched. On a real 258-declaration site every declaration was matched.
- lets each declaration be **detached** (back to its captured value), **re-attached**, or **set** to an explicit value, from the **Design tokens** card. No other use of the same colour is affected; Web never replaces values globally. Brand colours and fonts are still edited on the **Brand** card and reach every bound declaration.

`var()` inside markup (style attributes, `<style>`) gets fallbacks too, and is counted, but is edited in the component.

## Values needing direct edits

`reports/source-edits.json` (and the card of the same name) lists what is not content or a token:
- hard-coded colours (CSS declarations including the site's own custom properties, style attributes, SVG `fill`/`stroke`)
- font families
- text written into the markup rather than bound to content
- image references in the markup
- script files

Each entry gives the file and where in it.

## Status of every page and section

| State | Meaning |
| --- | --- |
| Processed | Templatised, nothing known missing |
| Processed with limitations | Usable, with listed gaps: interactions or unsupported content, hidden when rendered, uncertain classification (no rule matched), failed generation checks, a cut-off screenshot, a large screenshot difference, missing assets, broken links, duplicate ids |
| Requires manual work | Not templatised, missing in the output, a configuration change not visible, a missing component, or failing Web's section-order check. Also sections the generator found but did not put in the template. |
| Inaccessible | Not captured: failed, blocked (e.g. HTTP 403), skipped (robots.txt, limits) |

The inputs are the generator's inventories and verification, labelled "at generation", plus Web's latest checks. Copies and split parts take their status from the original's record. The **Coverage and checks** card shows the counts, every page with its reasons, and discovery that was incomplete.

## Checks

**Run checks** composes and builds the current template with its own `build.mjs` into a separate folder, then checks every page:

- **load:** the route was built
- **assets:** every local file the page and its stylesheets refer to exists
- **links:** internal links lead to built pages. Links to pages that weren't captured count here.
- **sections:** `data-sar-section` appears in exactly the composition's order. This covers insertion, removal, reordering, duplication, splitting and merging.
- **duplicate ids**
- **content:** each text value a section's markup uses appears in the page. This covers content edits.
- **tokens:** every token used without a fallback is defined in the built `brand.css`
- **outside references:** listed, and blocked in previews

The results go to `reports/verification.json` and are shown on the card.

These are file-level checks. Browser checks (desktop and mobile screenshots compared with the capture, console errors, blocked outside requests, interactions) are made by SaveAllResources when the template is generated and shown in the page status. The screenshot comparison gives a pixel-difference ratio, not a pixel-perfect claim. Browser checks of edits are covered by the end-to-end tests below rather than repeated in the app.

## Missing assets in the preview

The preview card lists missing assets while a preview runs:
- local files the current build refers to but doesn't contain (scanned once per build)
- files the page asked the preview server for that don't exist (recorded by the preview host)

Browsers' own `/favicon.ico` request is ignored.

## Export

**Download edited template** (`/api/projects/:projectId/template-jobs/:jobId/export`) gives `website-template-<job>-edited.zip`:

```
website-template/
  raw-capture/ …                      as captured (original and rendered HTML, resources, screenshots, page packages)
  manifest.json, page-inventory.json, section-inventory.json, verification-report.json, verification/   (generator)
  template/                           the current template, without dist/
    build.mjs serve.mjs lib/ runtime/ package.json      generated runtime (unchanged)
    compose.mjs                       Web's composition script
    composition/<page>.json, composition/skeletons/, composition/frames/
    overrides.json                    the explicit overrides, in order
    tokens/token-map.json
    pages/ layouts/ components/ content/ assets/ site.config.json site.config.reference.json
  reports/coverage.json, reports/source-edits.json, reports/verification.json (if run)
  EDITING.md                          what to edit where, build commands, interactions and limits
```

Build it anywhere with Node.js:

    cd website-template/template
    node compose.mjs   # after editing composition/
    node build.mjs     # writes dist/
    node serve.mjs     # serves dist/ locally

The stored `website-template.zip` never changes. The export is built from it and the working copy.

## Code

| Piece | File |
| --- | --- |
| Composition script (also shipped in templates) | `scripts/template-compose.mjs` |
| Regions from a layout | `src/server/templates/composition.ts` |
| Markup: parse5 positions, selectors, id suffixing, token paths | `src/server/templates/markup.ts` |
| Operations, overrides log, replay | `src/server/templates/operations.ts` |
| Token provenance and fallbacks | `src/server/templates/tokens.ts` |
| Status, coverage, source edits | `src/server/templates/reports.ts` |
| Checks | `src/server/templates/verify.ts` |
| Processing, dashboard view, export | `src/server/templates/index.ts` |
| Extraction, upgrade of older working copies, reprocess with edits kept | `src/server/preview/workspace.ts` |
| Actions | `src/app/(dashboard)/projects/structure-actions.ts` |
| Export route | `src/app/api/projects/[projectId]/template-jobs/[jobId]/export/route.ts` |
| UI | `src/components/projects/template-structure.tsx` (inside `template-preview.tsx`) |

Every change to markup is made by cutting the original text at parse5's source positions, never by re-serialising a parsed tree, so markup Web doesn't touch stays byte-for-byte as generated. CSS changes go through postcss, which keeps untouched rules as written.

Working copies made before this existed are processed once when opened. Their edits are kept.

## Tests

- `src/server/templates/templates.test.ts`: a template in the generator's format (a **test fixture** written in the test) covers:
  - selectors, id suffixing and token paths
  - regions, and a byte-for-byte layout round trip
  - move, remove, restore, duplicate (unique ids, independent content), copy safety (scripts, interactions, confirmation), insert across pages, merge and unmerge
  - split, including frame content and the refusals
  - exclude, including page-scoped shared markup
  - token fallbacks and provenance (matched and unmatched), detach, set and attach
  - four-state status, including pages not captured and sections not templatised
  - source edits

  The tests that build use **the real template runtime** of the SaveAllResources installation (copied at test time, never stored in Web; skipped if it isn't installed). They cover:
  - the checks
  - section operations and content and token changes seen in built pages
  - missing assets and duplicate ids
  - undo by replay, with edits kept
  - the export, and building the exported template after a hand-edited composition
- `e2e/wf-02e-template-structure.spec.ts`: a template generated by **the real SaveAllResources CLI** from a test fixture site, edited in the browser:
  - status and reasons
  - reorder, duplicate (with the script warning and confirmation), remove, insert from another page, split (and the refusal for a repeated list) and exclude, each checked in the live preview's DOM
  - editing a split part's text
  - mobile viewport
  - no console errors
  - token detach surviving a brand-colour change
  - missing assets shown with the preview
  - Web's checks passing
  - undo with edits kept
  - the exported ZIP's contents

## Limits

- **Segmentation is the generator's.** Web refines it with overrides; it never re-segments from the raw capture, so a page the generator could not templatise stays "requires manual work".
- **Moves across regions** are not offered (above). Neither is duplicating a merged group or a split section's frame: unmerge, or duplicate the parts.
- **Rich-text content** (`{{@html}}` fields) is edited as text in the content files; selectors don't search inside it.
- **Captured scripts are kept as they were.** A copy whose markup scripts depend on may not behave like the original; Web warns, but cannot rewrite scripts.
- **Exports are built in memory** from the stored ZIP, so a template near the 200 MB limit needs that much memory to download.
- **Undo replays from the generated template:** an edit made to a field that the undone override created (for example a split part's text, when undoing the split) is not kept.

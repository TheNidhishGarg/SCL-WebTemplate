# Test results — 2026-10-01

Environment: Windows 10, Node.js 24.18.0, Chrome for Testing 154.0.8037.57 (puppeteer 25.12.0),
extension `Save All Resources (Automation Build)` 2.0.6.1, id `jfpfjjalojpaffneaemkcjbdnmbaognl`.

| Suite | Command | Result |
|---|---|---|
| Unit | `npm test` | 36 / 36 passed |
| E2E messaging | `node --test test/e2e/messaging.test.mjs` | 5 / 5 passed (~35 s) |
| E2E failure modes | `node --test test/e2e/failure-modes.test.mjs` | 4 / 4 passed (~3 min) |
| E2E full pipeline | `node --test test/e2e/full-pipeline.test.mjs` | 8 / 8 passed (~7.3 min) |
| One-command CLI | `npm run capture -- http://127.0.0.1:4200/ --max-pages 4` | completed_with_warnings (page limit reached, as configured); 36/36 verification checks; configuration change test passed |

The first full-pipeline run had one failing assertion. The privacy check `/cookie|authorization/`
matched the manifest's own `privacy.cookiesExported: false` declaration. The test now asserts the
privacy flags explicitly and scans everything else; the rerun passed 8/8.

## Full-pipeline run on the fixture site (maxPages 15)
* 15 URLs discovered (entry, sitemap, nav, footer, links); 12 captured and templatised; `/private/` reported `inaccessible` (403); `/old-pricing` (301) and `/blog/?page=2&sort=new` deduplicated as aliases.
* Skipped and reported: `/logout` (unsafe link, never requested), `/drafts/secret.html` (robots), calendar pages (pattern limit), blog query combinations (variant/parameter limits).
* 29 sections identified, all templatised; navigation shared with 2 variants (the About page's active item), footer shared, all other sections page-specific.
* 0 unresolved template resources; `/img/missing.png` reported as a missing dependency (404 at source).
* Verification: all page checks passed (load, sections, resources, internal navigation, external requests, console, interactions, desktop and mobile screenshot comparison). Most pages had a mismatch ratio of 0.
* Runtime guard blocked `/api/newsletter-count` and the contact-form submission; no request reached the reference site's form endpoint.
* Configuration change test: primary colour, brand name, one field per page and one shared navigation field appeared exactly on the expected pages and sections.
* The exported ZIP was unpacked, edited (brand name and colour) and rebuilt with `node build.mjs`, and the changes appeared in `dist/`.

## Not covered by automated tests
* Branded Google Chrome (`--browser system`). Since Chrome 137, branded Chrome cannot load unpacked extensions from the command line, so this mode needs the one-time manual *Load unpacked* and was not automated.
* Real third-party websites (no network-dependent tests). SPA-heavy sites, shadow DOM, and service-worker-controlled sites are handled by design and reported, but no fixture covers them.
* Resume after a forced service-worker termination (the code path exists: persisted job state, watchdog alarm, re-queue of the in-flight page) is not exercised by a test.

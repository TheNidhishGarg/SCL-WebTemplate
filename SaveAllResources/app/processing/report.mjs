// Reporting: page inventory, section inventory, final manifest, verification report (JSON + HTML)
// and the export README. Everything that did not work is listed, nothing is summarised away.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const uniqBy = (arr, key) => [...new Map(arr.map((x) => [key(x), x])).values()];

export function buildReports({ outDir, manifest, templ, verify, job, errors, stages }) {
  const capture = manifest.capture;
  const pages = manifest.pages;
  const count = (fn) => pages.filter(fn).length;
  const sections = templ?.sections || [];
  const missingRefs = uniqBy(templ?.report.missing || [], (m) => `${m.url}`);
  const failedRequests = uniqBy(manifest.failedRequests.filter((f) => !f.blockedReason), (f) => `${f.url} ${f.error}`);
  manifest.missingDependencies = missingRefs;

  const unsupported = {
    removedTrackers: Object.entries(templ?.report.pages || {}).flatMap(([page, r]) => r.removedTrackers.map((t) => ({ page, ...t }))),
    disabledForms: Object.entries(templ?.report.pages || {}).flatMap(([page, r]) => r.disabledForms.map((f) => ({ page, ...f }))),
    operationalRequests: uniqBy(pages.flatMap((p) => (p.operationalRequests || []).map((url) => ({ page: p.id, url }))), (x) => x.url),
    scriptDependencies: templ?.report.scriptDependencies || [],
    externalFrames: Object.entries(templ?.report.pages || {}).flatMap(([page, r]) => r.externalFrames.map((url) => ({ page, url }))),
    uncapturedInternalLinks: uniqBy(Object.entries(templ?.report.pages || {}).flatMap(([page, r]) => r.uncapturedLinks.map((url) => ({ page, url }))), (x) => x.url),
    pageLevel: pages.filter((p) => p.unsupported).map((p) => ({ page: p.id, ...p.unsupported })).filter((u) => u.shadowHosts || u.canvases || u.serviceWorkerControlled || u.crossOriginFrames),
    cssParseErrors: templ?.report.cssParseErrors || [],
    serverSide: 'Server-side functionality (form handlers, APIs, search, authentication, databases) is not recoverable from a browser capture and is not reproduced.',
  };

  const verificationChecks = [];
  for (const p of verify?.pages || []) {
    for (const [name, c] of Object.entries(p.checks)) verificationChecks.push({ page: p.page, check: name, passed: c.passed !== false, detail: c });
  }
  const checksPassed = verificationChecks.filter((c) => c.passed).length;

  const summary = {
    pages: {
      discovered: pages.length,
      captured: count((p) => p.status === 'captured'),
      templatised: count((p) => p.templateStatus === 'templatised'),
      aliases: count((p) => p.status === 'alias'),
      failed: count((p) => ['failed', 'inaccessible', 'capture_not_uploaded', 'corrupt_capture', 'redirected_out_of_scope'].includes(p.status)),
      notCapturedDueToLimits: count((p) => p.status === 'not_captured'),
      cancelled: count((p) => p.status === 'cancelled'),
    },
    sections: {
      identified: sections.length,
      templatised: sections.filter((s) => s.processingStatus === 'templatised').length,
      requiringManualWork: sections.filter((s) => s.processingStatus !== 'templatised' || ['missing_in_output'].includes(s.verificationStatus) || s.configEditVerified === false).length,
      shared: sections.filter((s) => s.shared).length,
      sharedComponents: new Set(sections.filter((s) => s.shared).map((s) => s.component)).size,
    },
    limits: { reached: capture.limits?.reached || [], remainingUrls: capture.limits?.remainingUrls || [], discoveryComplete: capture.discoveryComplete },
    missingAssets: missingRefs.length,
    failedRequests: failedRequests.length,
    verification: verify
      ? { checks: verificationChecks.length, passed: checksPassed, failed: verificationChecks.length - checksPassed, configChangePassed: verify.configChange?.passed ?? null }
      : { performed: false, reason: stages.verifying?.error || stages.verifying?.reason || 'not run' },
    errors,
  };
  summary.hasWarnings =
    errors.length > 0 ||
    summary.pages.failed > 0 ||
    summary.pages.notCapturedDueToLimits > 0 ||
    summary.limits.reached.length > 0 ||
    summary.limits.discoveryComplete === false ||
    summary.sections.requiringManualWork > 0 ||
    summary.missingAssets > 0 ||
    (verify ? summary.verification.failed > 0 || !summary.verification.configChangePassed : true);

  const pageInventory = {
    jobId: job.jobId,
    entryUrl: job.url,
    scope: { origins: [new URL(job.url).origin, ...(job.options.allowedOrigins || [])] },
    limits: summary.limits,
    discovery: capture.discovery,
    pages: pages.map((p) => ({
      id: p.id,
      requestedUrl: p.requestedUrl,
      finalUrl: p.finalUrl,
      localPath: p.localPath || null,
      route: p.route || null,
      captureStatus: p.status,
      templateStatus: p.templateStatus || null,
      reason: p.reason,
      httpStatus: p.httpStatus,
      depth: p.depth,
      discoveredVia: p.discoveredVia,
      aliasOf: p.aliasOf,
      redirects: p.redirects,
      linksFound: p.links?.length ?? null,
      templateSource: p.templateSource || null,
      screenshots: p.screenshots || {},
      warnings: p.captureWarnings,
    })),
    skippedUrls: capture.skippedUrls,
  };

  const verificationReport = {
    generatedAt: new Date().toISOString(),
    disclaimer: 'This is a reconstruction from browser-delivered resources. It is not a pixel-perfect clone, does not recover backend functionality, and does not recover original source code.',
    summary,
    stages,
    checks: verify ? { pages: verify.pages, configChange: verify.configChange, previewIsolation: verify.previewIsolation } : null,
    missingAssets: missingRefs,
    failedRequests,
    unsupported,
  };

  manifest.verification = verify ? { summary: summary.verification, report: 'verification-report.json' } : null;
  manifest.processing = { ...manifest.processing, summary };
  if (templ) for (const p of manifest.pages) p.localPath = p.localPath || null;

  const w = (name, data) => writeFileSync(join(outDir, name), JSON.stringify(data, null, 2) + '\n');
  mkdirSync(outDir, { recursive: true });
  w('manifest.json', manifest);
  w('raw-capture/manifest.json', manifest);
  w('page-inventory.json', pageInventory);
  w('section-inventory.json', { jobId: job.jobId, sections });
  w('verification-report.json', verificationReport);
  writeFileSync(join(outDir, 'verification-report.html'), renderHtmlReport(verificationReport, pageInventory, sections));
  writeFileSync(join(outDir, 'README.md'), renderReadme({ job, summary, templ, unsupported }));
  return { summary };
}

function renderHtmlReport(r, inv, sections) {
  const s = r.summary;
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const ok = (b) => (b ? '<span class="ok">pass</span>' : '<span class="bad">fail</span>');
  const checkRows = (r.checks?.pages || [])
    .map((p) =>
      row([
        esc(p.page),
        ok(p.checks.load?.passed),
        ok(p.checks.sections?.passed),
        ok(p.checks.resources?.passed),
        ok(p.checks.internalNavigation?.passed),
        ok(p.checks.externalRequests?.passed) + ` (${p.checks.externalRequests?.blocked.length || 0})`,
        ok(p.checks.console?.passed),
        ok(p.checks.interactions?.passed),
        p.checks.desktopRendering?.compared ? `${(p.checks.desktopRendering.mismatchRatio * 100).toFixed(1)}%` : 'n/a',
        p.checks.mobileRendering?.compared ? `${(p.checks.mobileRendering.mismatchRatio * 100).toFixed(1)}%` : 'n/a',
      ])
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Verification report</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px auto;max-width:1100px;padding:0 16px;color:#1d2433;background:#fff}table{border-collapse:collapse;width:100%;margin:8px 0 24px}td,th{border:1px solid #d8dee9;padding:4px 8px;text-align:left;vertical-align:top}.ok{color:#18794e}.bad{color:#b00020;font-weight:600}code{font-size:12px}</style></head><body>
<h1>Verification report</h1><p>${esc(r.disclaimer)}</p>
<h2>Summary</h2><table>
${row(['Pages', `discovered ${s.pages.discovered}, captured ${s.pages.captured}, templatised ${s.pages.templatised}, failed ${s.pages.failed}, aliases ${s.pages.aliases}, not captured (limits) ${s.pages.notCapturedDueToLimits}`])}
${row(['Sections', `identified ${s.sections.identified}, templatised ${s.sections.templatised}, shared ${s.sections.shared} (${s.sections.sharedComponents} components), requiring manual work ${s.sections.requiringManualWork}`])}
${row(['Limits reached', esc(s.limits.reached.join(', ') || 'none') + (s.limits.discoveryComplete === false ? ' — discovery incomplete' : '')])}
${row(['Missing assets', s.missingAssets])}
${row(['Verification checks', s.verification.checks != null ? `${s.verification.passed}/${s.verification.checks} passed; configuration change test ${s.verification.configChangePassed ? 'passed' : 'FAILED'}` : esc(s.verification.reason)])}
${row(['Errors', esc(s.errors.join('; ') || 'none')])}
</table>
<h2>Page checks</h2><table><tr><th>Page</th><th>Load</th><th>Sections</th><th>Resources</th><th>Navigation</th><th>External requests blocked</th><th>Console</th><th>Interactions</th><th>Desktop diff</th><th>Mobile diff</th></tr>${checkRows}</table>
<h2>Page inventory</h2><table><tr><th>Page</th><th>URL</th><th>Capture</th><th>Template</th><th>Reason</th></tr>${inv.pages.map((p) => row([esc(p.id), esc(p.finalUrl || p.requestedUrl), esc(p.captureStatus), esc(p.templateStatus || ''), esc(p.reason || '')])).join('')}</table>
<h2>Sections</h2><table><tr><th>Section</th><th>Type</th><th>Component</th><th>Status</th><th>Verification</th><th>Fields</th></tr>${sections.map((x) => row([esc(x.sectionId), esc(x.type), `<code>${esc(x.component)}</code>`, esc(x.processingStatus), esc(x.verificationStatus) + (x.configEditVerified === false ? ' (config edit not visible)' : ''), x.editableFields.length])).join('')}</table>
<h2>Missing assets</h2><table>${r.missingAssets.map((m) => row([esc(m.kind), esc(m.url), esc(m.page || m.from)])).join('') || row(['none'])}</table>
<h2>Unsupported functionality</h2><pre>${esc(JSON.stringify(r.unsupported, null, 2))}</pre>
</body></html>`;
}

function renderReadme({ job, summary, templ, unsupported }) {
  const s = summary;
  return `# Website template — ${job.url}

Generated from a Save All Resources capture (automation build) on ${new Date().toISOString().slice(0, 10)}.
This is a reconstruction from browser-delivered HTML, CSS, JavaScript and media. It is **not** a
pixel-perfect clone, it does **not** include the original backend, and it is **not** the original source code.

## Contents

| Path | What it is |
|---|---|
| \`raw-capture/\` | Untouched capture: the per-page Save All Resources zips (\`sar-page-zips/\`), original and rendered HTML, screenshots, de-duplicated resource bodies and the capture manifest |
| \`template/\` | Runnable, editable multi-page template (see below) |
| \`manifest.json\` | Versioned resource manifest: pages, resources (URL → local path, type, size, sha256), redirects, failed requests, missing dependencies, processing and verification results |
| \`page-inventory.json\` | Every discovered URL with its capture/template outcome |
| \`section-inventory.json\` | Every identified section: component, content location, editable fields, assets, tokens, interactions, status |
| \`verification-report.json\` / \`.html\` | Checks performed and their results |
| \`verification/screenshots/\` | Template screenshots and diff images against the source screenshots |

## Quick start

Requires Node.js 18 or newer. No dependencies to install.

\`\`\`bash
cd template
npm run preview      # builds dist/ and serves it on http://127.0.0.1:8080
npm run dev          # same, rebuilding on every change
\`\`\`

\`template/dist/\` is the built static site; deploy it to any static host.

## Customising

* **Brand** — \`template/site.config.json\`
  * \`brand.name\`, \`brand.logo\`, \`brand.favicon\`, \`brand.contact\`, \`brand.social\`: referenced from content as \`{{brand.…}}\` and from components.
  * \`colors\`, \`fonts\`, \`typography\`: emitted as CSS variables (\`--sar-color-*\`, \`--sar-font-*\`, \`--sar-size-*\`) in \`dist/brand/brand.css\`; the captured stylesheets reference these variables.
  * \`images\`: images shared by several pages, referenced from content as \`{{images.image-N}}\`.
  * \`integrations\`: \`allowedOrigins\` (CSP + runtime guard allowlist), \`forms\` (set \`action\` to connect a form), \`analytics.headHtml\` (inserted into every page when \`enabled\`), \`blockedEndpoints\`.
  * \`site.config.reference.json\` keeps the initial values from the reference site.
* **Content** — \`template/content/pages/<page>.json\` (page title/description and page-specific sections, in page order) and \`template/content/shared.json\` (shared sections such as navigation and footer; page files may override individual fields).
* **Markup** — \`template/components/shared/\` and \`template/components/pages/<page>/\`; page skeletons in \`template/layouts/\`; section order in \`template/pages/<page>.json\`.
* **Assets** — \`template/assets/site/\` (reference origin) and \`template/assets/ext/<host>/\` (third-party hosts).

Template tokens: \`{{@ field}}\` text, \`{{@html field}}\` rich text, \`{{@url field}}\` links/images (site-root paths such as \`/assets/…\` are made relative per page), \`{{@each list}}…{{@end}}\` repeated items.

## What was disabled

* Analytics/tracking removed: ${unsupported.removedTrackers.length ? [...new Set(unsupported.removedTrackers.map((t) => t.vendor))].join(', ') : 'none detected'}.
* Forms disconnected: ${unsupported.disabledForms.length} (submissions are blocked until \`integrations.forms.<id>.action\` is set).
* Operational requests blocked: ${unsupported.operationalRequests.length} endpoint(s); the runtime guard (\`runtime/sar-runtime.js\`) and a Content-Security-Policy block requests to any origin not listed in \`integrations.allowedOrigins\`.

## Results

* Pages: ${s.pages.discovered} discovered, ${s.pages.captured} captured, ${s.pages.templatised} templatised, ${s.pages.failed} failed, ${s.pages.notCapturedDueToLimits} not captured because of limits.
* Sections: ${s.sections.identified} identified, ${s.sections.templatised} templatised, ${s.sections.requiringManualWork} requiring manual work.
* Limits reached: ${s.limits.reached.join(', ') || 'none'}${s.limits.discoveryComplete === false ? ' (discovery incomplete — see page-inventory.json)' : ''}.
* Missing assets: ${s.missingAssets}. Verification: ${s.verification.checks != null ? `${s.verification.passed}/${s.verification.checks} checks passed, configuration change test ${s.verification.configChangePassed ? 'passed' : 'failed'}` : 'not performed'}.

See \`verification-report.html\` for details.
${templ ? '' : '\n> Template processing failed; only the raw capture is included.\n'}`;
}

#!/usr/bin/env node
// One command: reference URL -> discovery -> Save All Resources capture -> template export.
//
//   npm run capture -- https://example.com [--max-pages 25] [--max-depth 3] [--options opts.json]
//                      [--browser cft|system] [--headful] [--out exports] [--no-verify]
//
// --browser cft     (default) launches Chrome for Testing with the automation build of Save All
//                    Resources loaded from extension/dist; runs unattended.
// --browser system  opens the launch page in your installed Chrome, which must have the
//                    automation build installed (chrome://extensions → Load unpacked).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createAppServer } from './server.mjs';
import { TERMINAL } from './lib/job-store.mjs';
import { ROOT } from './lib/config.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) args._.push(a);
    else if (['--headful', '--no-verify', '--help'].includes(a)) args[a.slice(2)] = true;
    else args[a.slice(2)] = argv[++i];
  }
  return args;
}

const HELP = `Usage: npm run capture -- <url> [options]
  --max-pages N        pages to capture (default 25)
  --max-depth N        link depth from the entry page (default 3)
  --max-minutes N      overall capture time limit (default 20)
  --options FILE       JSON file with capture options (see app/capture-options.example.json)
  --browser cft|system cft: Chrome for Testing + extension, unattended (default); system: your Chrome
  --headful            show the Chrome for Testing window
  --out DIR            where to copy the export (default ./exports)
  --no-verify          skip browser verification of the generated template`;

function openInSystemBrowser(url) {
  const platform = process.platform;
  if (platform === 'win32') return spawn('cmd', ['/c', 'start', '', 'chrome', url], { detached: true, stdio: 'ignore' });
  if (platform === 'darwin') return spawn('open', ['-a', 'Google Chrome', url], { detached: true, stdio: 'ignore' });
  return spawn('google-chrome', [url], { detached: true, stdio: 'ignore' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args._[0];
  if (args.help || !url) {
    console.log(HELP);
    process.exit(args.help ? 0 : 64);
  }
  const extDir = join(ROOT, 'extension/dist');
  if (!existsSync(join(extDir, 'extension-id.txt'))) {
    console.error('The extension has not been built. Run: npm run build:extension');
    process.exit(1);
  }
  const options = args.options ? JSON.parse(readFileSync(resolve(args.options), 'utf8')) : {};
  if (args['max-pages']) options.maxPages = Number(args['max-pages']);
  if (args['max-depth']) options.maxDepth = Number(args['max-depth']);
  if (args['max-minutes']) options.maxDurationMs = Number(args['max-minutes']) * 60_000;

  const app = createAppServer(args['no-verify'] ? { verification: { enabled: false } } : {}, { log: () => {} });
  try {
    await app.listen();
  } catch (e) {
    console.error(`Cannot listen on ${app.config.publicOrigin}: ${e.message}. Stop the other server or set PORT (and rebuild the extension for that origin).`);
    process.exit(1);
  }
  let job;
  let launchUrl;
  try {
    ({ job, launchUrl } = app.createJob({ url, options }));
  } catch (e) {
    console.error(`Invalid job: ${e.message}`);
    await app.close();
    process.exit(64);
  }
  const jobId = job.jobId;
  const started = Date.now();
  console.log(`Job ${jobId}\n  url: ${job.url}\n  server: ${app.config.publicOrigin}\n  data: ${app.store.dir(jobId)}`);

  let browser = null;
  const browserMode = args.browser || 'cft';
  if (browserMode === 'system') {
    console.log('Opening the launch page in your Chrome. The Save All Resources automation build must be installed.');
    console.log('Tip: use a dedicated Chrome profile without signed-in sessions; captures use that profile\'s cookies.');
    openInSystemBrowser(launchUrl);
  } else {
    const puppeteer = (await import('puppeteer')).default;
    browser = await puppeteer.launch({ headless: !args.headful, pipe: true, enableExtensions: [extDir], args: ['--no-first-run'] });
    const page = await browser.newPage();
    await page.goto(launchUrl);
  }

  let cancelling = false;
  process.on('SIGINT', () => {
    if (cancelling) process.exit(130);
    cancelling = true;
    console.log('\nCancelling… (press Ctrl+C again to quit immediately)');
    app.store.update(jobId, (j) => {
      if (!TERMINAL.includes(j.status)) {
        j.cancelRequested = true;
        if (['awaiting_extension', 'capturing'].includes(j.status)) j.status = 'cancelled';
      }
    });
  });

  let last = '';
  for (;;) {
    const j = app.store.get(jobId);
    const p = j.capture?.progress;
    const line = `${j.status}${p ? ` — pages: ${p.captured} captured / ${p.discovered} discovered, ${p.failed} failed, ${p.pending} pending` : ''}`;
    if (line !== last) console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${line}`);
    last = line;
    if (j.status === 'awaiting_extension' && Date.now() - started > 60_000 && !j.capture) {
      console.error('The extension did not pick up the job within 60s (is it installed and allowed for this origin?).');
      app.store.update(jobId, (x) => {
        x.status = 'failed';
        x.errors.push('extension did not respond within 60s');
      });
    }
    if (TERMINAL.includes(j.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (cancelling) {
    // Give the extension time to stop, report, and let the raw capture be packaged.
    for (let i = 0; i < 45 && !app.store.get(jobId).capture?.status; i++) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 500));
  }
  await app.queue.whenIdle();
  const final = app.store.get(jobId);
  await browser?.close().catch(() => {});
  await app.close();

  const s = final.summary;
  if (s) {
    console.log(`\nPages: ${s.pages.discovered} discovered, ${s.pages.captured} captured, ${s.pages.templatised} templatised, ${s.pages.failed} failed, ${s.pages.notCapturedDueToLimits} not captured (limits)`);
    console.log(`Sections: ${s.sections.identified} identified, ${s.sections.templatised} templatised, ${s.sections.requiringManualWork} need manual work`);
    console.log(`Limits reached: ${s.limits.reached.join(', ') || 'none'}; missing assets: ${s.missingAssets}`);
    if (s.verification.checks != null) console.log(`Verification: ${s.verification.passed}/${s.verification.checks} checks passed; configuration change test ${s.verification.configChangePassed ? 'passed' : 'FAILED'}`);
  }
  for (const e of final.errors) console.log(`error: ${e}`);
  if (final.exportFile && existsSync(final.exportFile)) {
    const outDir = resolve(args.out || 'exports');
    mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, `${jobId}-website-template.zip`);
    copyFileSync(final.exportFile, dest);
    console.log(`\nExport: ${dest}`);
  }
  console.log(`Status: ${final.status}`);
  process.exit(final.status === 'failed' ? 1 : final.status === 'cancelled' ? 130 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

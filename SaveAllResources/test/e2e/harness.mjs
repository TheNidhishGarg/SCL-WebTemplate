// End-to-end harness: fixture site + app server + Chrome for Testing with the automation build of
// Save All Resources loaded. Jobs are started through the real launch page and integration module.
import puppeteer from 'puppeteer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/fixture-server.mjs';
import { createAppServer } from '../../app/server.mjs';
import { TERMINAL } from '../../app/lib/job-store.mjs';
import { ROOT } from '../../app/lib/config.mjs';

export const EXT_DIR = join(ROOT, 'extension/dist');
export const EXT_ID = readFileSync(join(EXT_DIR, 'extension-id.txt'), 'utf8').trim();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: process.env.HEADFUL ? false : true,
    pipe: true,
    enableExtensions: [EXT_DIR],
    args: [
      // Third-party hosts referenced by the fixture resolve to a closed local port: deterministic failures, no internet needed.
      '--host-resolver-rules=MAP www.googletagmanager.com 127.0.0.1:9, MAP api.northwind.invalid 127.0.0.1:9, MAP instagram.com 127.0.0.1:9, MAP www.linkedin.com 127.0.0.1:9',
      '--no-first-run',
    ],
  });
  await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${EXT_ID}/`), { timeout: 20_000 });
  return browser;
}

export async function startStack({ faults = {}, verification = {}, port = 4100 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sar-e2e-'));
  const fixture = await startFixtureServer();
  const logs = [];
  const app = createAppServer(
    { port, host: 'localhost', dataDir, appApiToken: 'test-app-token-123456', uploadTokenSecret: 'test-secret-abcdefghijklmnop', verification: { pageTimeoutMs: 20_000, ...verification } },
    { faults, log: (...a) => logs.push(a.join(' ')) }
  );
  await app.listen();
  const browser = await launchBrowser();

  async function startJob(url, options = {}) {
    const { job, launchUrl } = app.createJob({ url, options });
    const page = await browser.newPage();
    await page.goto(launchUrl);
    return { jobId: job.jobId, page };
  }

  async function waitForJob(jobId, { timeoutMs = 600_000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const job = app.store.get(jobId);
      if (TERMINAL.includes(job.status)) {
        await app.queue.whenIdle();
        return app.store.get(jobId);
      }
      await sleep(500);
    }
    throw new Error(`job ${jobId} did not finish; last status ${app.store.get(jobId).status}`);
  }

  async function runJob(url, options = {}, waitOpts) {
    const { jobId, page } = await startJob(url, options);
    const job = await waitForJob(jobId, waitOpts);
    return { job, page };
  }

  async function close() {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await fixture.close().catch(() => {});
    if (!process.env.KEEP_DATA) rmSync(dataDir, { recursive: true, force: true });
  }

  return { dataDir, fixture, app, browser, logs, startJob, waitForJob, runJob, close };
}

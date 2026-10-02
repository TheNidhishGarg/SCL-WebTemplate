// Timeout, cancellation and upload failure recovery with the real extension.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { startStack, EXT_ID, sleep } from './harness.mjs';

let stack;
before(async () => {
  stack = await startStack({ verification: { enabled: false } });
});
after(async () => stack?.close());

const ext = (page, msg) => page.evaluate((id, m) => new Promise((r) => chrome.runtime.sendMessage(id, m, (res) => r(res))), EXT_ID, msg);
async function waitExt(page, jobId, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await ext(page, { v: 1, type: 'getStatus', jobId });
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(s.status.status)) return s.status;
    await sleep(1000);
  }
  throw new Error('extension job did not finish');
}

test('page load timeout is bounded; the page is captured partially and others succeed', async () => {
  const { job, page } = await stack.runJob(`${stack.fixture.url}/timeout-entry.html`, { maxPages: 3, useSitemaps: false, pageLoadTimeoutMs: 4000, maxRetries: 0 }, { timeoutMs: 300_000 });
  const pages = job.capture.pages;
  const slow = pages.find((p) => p.url.endsWith('/slow.html'));
  assert.ok(slow, 'slow page discovered');
  assert.equal(slow.status, 'captured');
  assert.ok(slow.warnings.some((w) => /load event not fired/.test(w)), JSON.stringify(slow.warnings));
  assert.equal(pages.find((p) => p.url.endsWith('/about/')).status, 'captured');
  assert.ok(['completed', 'completed_with_warnings'].includes(job.status));
  await page.close();
});

test('cancellation stops the capture and keeps the raw artifacts already uploaded', async () => {
  const { jobId, page } = await stack.startJob(`${stack.fixture.url}/`, { maxPages: 10, useSitemaps: false });
  for (let i = 0; i < 120; i++) {
    if (Object.keys(stack.app.store.get(jobId).uploads).length >= 1) break;
    await sleep(500);
  }
  assert.ok(Object.keys(stack.app.store.get(jobId).uploads).length >= 1, 'at least one page uploaded before cancelling');
  await page.click('#cancel');
  const extStatus = await waitExt(page, jobId, 120_000);
  assert.equal(extStatus.status, 'cancelled');
  assert.ok(extStatus.progress.captured < 10);
  const job = await stack.waitForJob(jobId, { timeoutMs: 120_000 });
  for (let i = 0; i < 60 && !stack.app.store.get(jobId).exportFile; i++) await sleep(500);
  await stack.app.queue.whenIdle();
  const final = stack.app.store.get(jobId);
  assert.equal(final.status, 'cancelled');
  assert.ok(final.exportFile, 'raw capture exported for a cancelled job');
  const files = unzipSync(new Uint8Array(readFileSync(final.exportFile)));
  assert.ok(Object.keys(files).some((f) => f.startsWith('website-template/raw-capture/sar-page-zips/')));
  assert.equal(job.status, 'cancelled');
  await page.close();
});

test('transient upload failures are retried transparently', async () => {
  stack.app.faults.failUploads = 2;
  const { job, page } = await stack.runJob(`${stack.fixture.url}/`, { maxPages: 2, useSitemaps: false }, { timeoutMs: 300_000 });
  assert.equal(stack.app.faults.failUploads, 0, 'injected failures were consumed');
  const captured = job.capture.pages.filter((p) => p.status === 'captured');
  assert.equal(captured.length, 2);
  assert.ok(captured.every((p) => p.uploaded));
  assert.equal(Object.keys(job.uploads).length, 2);
  assert.ok(['completed', 'completed_with_warnings'].includes(job.status));
  await page.close();
});

test('persistent upload failure keeps captures queued in the extension until retried', async () => {
  stack.app.faults.failUploads = 10_000;
  const { jobId, page } = await stack.startJob(`${stack.fixture.url}/`, { maxPages: 2, useSitemaps: false });
  const extStatus = await waitExt(page, jobId, 400_000);
  assert.equal(extStatus.status, 'completed_with_warnings');
  assert.equal(extStatus.progress.pendingUploads, 2, 'both captures parked in the extension queue');
  assert.equal(Object.keys(stack.app.store.get(jobId).uploads).length, 0, 'server has not received any capture');

  stack.app.faults.failUploads = 0; // upload endpoint recovers
  const retried = await ext(page, { v: 1, type: 'retryUploads', jobId });
  assert.equal(retried.ok, true);
  assert.equal(retried.status.progress.pendingUploads, 0);
  const job = await stack.waitForJob(jobId, { timeoutMs: 300_000 });
  assert.equal(Object.keys(job.uploads).length, 2);
  assert.ok(['completed', 'completed_with_warnings'].includes(job.status), job.status);
  assert.ok(job.exportFile);
  await page.close();
});

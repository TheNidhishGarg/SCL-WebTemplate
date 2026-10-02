// Messaging security and availability with the real extension.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, EXT_ID, sleep } from './harness.mjs';

let stack;
before(async () => {
  stack = await startStack({ verification: { enabled: false } });
});
after(async () => stack?.close());

const send = (page, msg, id = EXT_ID) =>
  page.evaluate(
    (id, msg) =>
      new Promise((resolve) => {
        if (!globalThis.chrome?.runtime?.sendMessage) return resolve({ noRuntime: true });
        chrome.runtime.sendMessage(id, msg, (res) => resolve(res ?? { lastError: chrome.runtime.lastError?.message }));
      }),
    id,
    msg
  );

async function appPage() {
  const page = await stack.browser.newPage();
  await page.goto(`${stack.app.config.publicOrigin}/capture.html`);
  return page;
}

async function realJob(url) {
  const { job, launchUrl } = stack.app.createJob({ url, options: { maxPages: 1, useSitemaps: false } });
  const code = new URL(launchUrl).hash.split('=')[1];
  const launch = await (await fetch(`${stack.app.config.publicOrigin}/api/launch/${code}`, { method: 'POST' })).json();
  return { jobId: job.jobId, launch };
}

test('configured application origin can reach the extension; DevTools is not required', async () => {
  const page = await appPage();
  const res = await send(page, { v: 1, type: 'ping' });
  assert.equal(res.ok, true);
  assert.equal(res.devtoolsRequired, false);
  assert.equal(res.captureMode, 'chrome.debugger');
  await page.close();
});

test('unauthorized origin is rejected by the extension', async () => {
  const page = await stack.browser.newPage();
  // http://localhost/* matches externally_connectable, but this port is not a configured app origin.
  await page.goto(`http://localhost:${stack.fixture.port}/sitemap-only.html`);
  const res = await send(page, { v: 1, type: 'ping' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UNAUTHORIZED_ORIGIN');
  // An origin outside externally_connectable cannot even see the messaging API.
  await page.goto(`${stack.fixture.url}/sitemap-only.html`);
  assert.deepEqual(await send(page, { v: 1, type: 'ping' }), { noRuntime: true });
  await page.close();
});

test('invalid payloads and unconfigured upload destinations are rejected', async () => {
  const page = await appPage();
  const { jobId, launch } = await realJob(`${stack.fixture.url}/`);
  const bad = async (msg) => (await send(page, msg)).error?.code;
  assert.equal(await bad({ v: 1, type: 'startCapture', jobId: 'x', url: launch.url, upload: launch.upload }), 'INVALID_MESSAGE');
  assert.equal(await bad({ v: 1, type: 'startCapture', jobId, url: 'file:///C:/', upload: launch.upload }), 'INVALID_MESSAGE');
  assert.equal(await bad({ v: 1, type: 'startCapture', jobId, url: launch.url, options: { evil: 1 }, upload: launch.upload }), 'INVALID_MESSAGE');
  assert.equal(await bad({ v: 1, type: 'startCapture', jobId, url: launch.url, upload: { ...launch.upload, endpoint: `https://attacker.example/api/capture-jobs/${jobId}` } }), 'INVALID_UPLOAD_DESTINATION');
  assert.equal(await bad({ v: 1, type: 'getStatus', jobId: 'job_doesnotexist' }), 'UNKNOWN_JOB');
  assert.equal(await bad({ v: 1, type: 'run', code: 'alert(1)' }), 'INVALID_MESSAGE');
  await page.close();
});

test('duplicate-job prevention and idempotent start', async () => {
  const page = await appPage();
  const a = await realJob(`${stack.fixture.url}/`);
  const b = await realJob(`${stack.fixture.url}/`);
  const start = (j) => send(page, { v: 1, type: 'startCapture', jobId: j.jobId, url: j.launch.url, options: j.launch.options, upload: j.launch.upload });
  const first = await start(a);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  const again = await start(a);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, 're-sending the same job id does not start a second capture');
  const other = await start(b);
  assert.equal(other.ok, false);
  assert.equal(other.error.code, 'DUPLICATE_JOB', 'a second job for the same URL is refused while the first runs');
  // Let the first job finish so later tests start from a clean extension state.
  for (let i = 0; i < 240; i++) {
    const s = await send(page, { v: 1, type: 'getStatus', jobId: a.jobId });
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(s.status.status)) break;
    await sleep(1000);
  }
  const result = await send(page, { v: 1, type: 'getResult', jobId: a.jobId });
  assert.equal(result.result.pages[0].status, 'captured');
  assert.equal(result.result.pages[0].uploaded, true);
  await page.close();
});

test('extension unavailable is reported clearly and fails the job', async () => {
  const realId = stack.app.config.extensionId;
  stack.app.config.extensionId = 'p'.repeat(32); // an id with no installed extension
  try {
    const { jobId, page } = await stack.startJob(`${stack.fixture.url}/`, { maxPages: 1 });
    await page.waitForFunction(() => document.documentElement.dataset.state === 'error', { timeout: 30_000 });
    const text = await page.$eval('#state', (e) => e.textContent);
    assert.match(text, /Extension unavailable/);
    const job = await stack.waitForJob(jobId, { timeoutMs: 30_000 });
    assert.equal(job.status, 'failed');
    assert.match(job.errors.join(' '), /extension unavailable/);
    await page.close();
  } finally {
    stack.app.config.extensionId = realId;
  }
});

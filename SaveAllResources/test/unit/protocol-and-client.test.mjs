import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, validateSenderOrigin, normalizeOptions, ERROR_CODES } from '../../extension/src/shared/protocol.js';
import { createSaveAllResourcesClient } from '../../app/public/sar-client.js';

const UPLOAD_ORIGINS = ['http://localhost:4100'];
const upload = (over = {}) => ({ endpoint: 'http://localhost:4100/api/capture-jobs/job_12345678', token: 'x'.repeat(40), expiresAt: Date.now() + 60_000, ...over });
const start = (over = {}) => ({ v: 1, type: 'startCapture', jobId: 'job_12345678', url: 'https://example.com/', options: {}, upload: upload(), ...over });
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return 'NO_ERROR';
};

test('valid start message is normalised with bounded defaults', () => {
  const m = validateMessage(start(), { allowedUploadOrigins: UPLOAD_ORIGINS });
  assert.equal(m.options.maxPages, 25);
  assert.equal(m.options.includeApiResponses, false);
  assert.equal(m.upload.endpoint, 'http://localhost:4100/api/capture-jobs/job_12345678');
});

test('sender origin must be configured', () => {
  assert.equal(validateSenderOrigin({ origin: 'http://localhost:4100' }, ['http://localhost:4100']), 'http://localhost:4100');
  assert.equal(codeOf(() => validateSenderOrigin({ origin: 'http://localhost:4999' }, ['http://localhost:4100'])), ERROR_CODES.UNAUTHORIZED_ORIGIN);
  assert.equal(codeOf(() => validateSenderOrigin({}, ['http://localhost:4100'])), ERROR_CODES.UNAUTHORIZED_ORIGIN);
});

test('payload validation rejects malformed messages', () => {
  const v = (msg) => codeOf(() => validateMessage(msg, { allowedUploadOrigins: UPLOAD_ORIGINS }));
  assert.equal(v(null), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v({ v: 2, type: 'ping' }), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v({ v: 1, type: 'eval' }), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v(start({ jobId: 'x' })), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v(start({ url: 'file:///etc/passwd' })), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v(start({ url: 'https://user:pw@example.com/' })), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v(start({ options: { maxPages: 100000 } })), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v(start({ options: { unknownOption: true } })), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v(start({ options: { interactionRecipes: [{ action: 'submit', selector: 'form' }] } })), ERROR_CODES.INVALID_MESSAGE);
  assert.equal(v({ v: 1, type: 'getStatus', jobId: '../../etc' }), ERROR_CODES.INVALID_MESSAGE);
});

test('upload destination must be configured, job-scoped and unexpired', () => {
  const v = (u) => codeOf(() => validateMessage(start({ upload: upload(u) }), { allowedUploadOrigins: UPLOAD_ORIGINS }));
  assert.equal(v({ endpoint: 'https://evil.example/api/capture-jobs/job_12345678' }), ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  assert.equal(v({ endpoint: 'http://localhost:4100/api/capture-jobs/other_job_id' }), ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  assert.equal(v({ endpoint: 'http://localhost:4100/api/capture-jobs/job_12345678?redirect=x' }), ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  assert.equal(v({ expiresAt: Date.now() - 1 }), ERROR_CODES.INVALID_UPLOAD_DESTINATION);
  assert.equal(v({ token: 'short' }), ERROR_CODES.INVALID_MESSAGE);
});

test('interaction recipes are restricted to click / hover / focus', () => {
  const o = normalizeOptions({ interactionRecipes: [{ action: 'click', selector: '.menu-toggle' }] });
  assert.equal(o.interactionRecipes[0].waitMs, 400);
});

// ---- application-side client with a mocked chrome.runtime ---------------------------------
const EXT = 'a'.repeat(32);
function mockRuntime(handler) {
  const rt = {
    lastError: undefined,
    sendMessage(id, msg, cb) {
      Promise.resolve(handler(id, msg)).then((res) => {
        if (res && res.__lastError) {
          rt.lastError = { message: res.__lastError };
          cb(undefined);
          rt.lastError = undefined;
        } else if (res !== '__never') cb(res);
      });
    },
  };
  return rt;
}

test('client reports unavailable extension when chrome.runtime is missing', async () => {
  const c = createSaveAllResourcesClient({ extensionId: EXT, runtime: undefined });
  const a = await c.isExtensionAvailable();
  assert.equal(a.available, false);
  assert.equal(a.code, 'EXTENSION_UNAVAILABLE');
  await assert.rejects(c.getCaptureStatus('job_12345678'), { code: 'EXTENSION_UNAVAILABLE' });
});

test('client reports unavailable extension on lastError (not installed)', async () => {
  const c = createSaveAllResourcesClient({ extensionId: EXT, runtime: mockRuntime(() => ({ __lastError: 'Could not establish connection. Receiving end does not exist.' })) });
  const a = await c.isExtensionAvailable();
  assert.equal(a.available, false);
  assert.match(a.reason, /Receiving end does not exist/);
});

test('client surfaces extension error codes and timeouts', async () => {
  const c = createSaveAllResourcesClient({
    extensionId: EXT,
    timeoutMs: 100,
    runtime: mockRuntime((id, msg) => (msg.type === 'cancel' ? '__never' : { ok: false, error: { code: 'UNAUTHORIZED_ORIGIN', message: 'nope' } })),
  });
  await assert.rejects(c.startWebsiteCapture({ jobId: 'job_12345678', url: 'https://e.com/', upload: upload() }), { code: 'UNAUTHORIZED_ORIGIN' });
  await assert.rejects(c.cancelCapture('job_12345678'), { code: 'TIMEOUT' });
});

test('client happy path: start, status, result, wait', async () => {
  let polls = 0;
  const c = createSaveAllResourcesClient({
    extensionId: EXT,
    runtime: mockRuntime((id, msg) => {
      assert.equal(id, EXT);
      assert.equal(msg.v, 1);
      if (msg.type === 'ping') return { ok: true, version: '2.0.6.1', protocol: 1, captureMode: 'chrome.debugger', devtoolsRequired: false };
      if (msg.type === 'startCapture') return { ok: true, duplicate: false, status: { status: 'running' } };
      if (msg.type === 'getStatus') return { ok: true, status: { status: ++polls >= 2 ? 'completed' : 'running' } };
      if (msg.type === 'getResult') return { ok: true, result: { pages: [] } };
      return { ok: false, error: { code: 'INTERNAL', message: '?' } };
    }),
  });
  assert.deepEqual(await c.isExtensionAvailable(), { available: true, version: '2.0.6.1', protocol: 1, captureMode: 'chrome.debugger', devtoolsRequired: false });
  assert.equal((await c.startWebsiteCapture({ jobId: 'job_12345678', url: 'https://e.com/', upload: upload() })).duplicate, false);
  const final = await c.waitForCapture('job_12345678', { intervalMs: 10 });
  assert.equal(final.status, 'completed');
  assert.deepEqual(await c.getCaptureResult('job_12345678'), { pages: [] });
});

test('client rejects an invalid extension id up front', () => {
  assert.throws(() => createSaveAllResourcesClient({ extensionId: 'not-an-id' }), { code: 'INVALID_CONFIG' });
});

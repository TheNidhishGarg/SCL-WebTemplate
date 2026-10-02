// Application-side integration module for the Save All Resources automation build.
// Runs in an application page whose origin is listed in the extension's externally_connectable
// manifest entry AND in its runtime allowlist. Uses chrome.runtime.sendMessage(extensionId, ...).
//
//   const sar = createSaveAllResourcesClient({ extensionId });
//   await sar.isExtensionAvailable();
//   await sar.startWebsiteCapture({ jobId, url, options, upload });
//   await sar.getCaptureStatus(jobId); await sar.cancelCapture(jobId); await sar.getCaptureResult(jobId);

export const PROTOCOL_VERSION = 1;
export const TERMINAL_STATUSES = ['completed', 'completed_with_warnings', 'failed', 'cancelled'];

export class SaveAllResourcesError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SaveAllResourcesError';
    this.code = code;
  }
}

const UNAVAILABLE_HELP =
  'The Save All Resources automation build is not reachable from this page. Install the unpacked extension from ' +
  'extension/dist (chrome://extensions → Developer mode → Load unpacked), make sure this page is served from a ' +
  'configured application origin, and use Google Chrome or another Chromium browser.';

export function createSaveAllResourcesClient({ extensionId, runtime = globalThis.chrome?.runtime, timeoutMs = 10_000 } = {}) {
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) throw new SaveAllResourcesError('INVALID_CONFIG', 'a valid extensionId is required');

  function send(message, { timeout = timeoutMs } = {}) {
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      return Promise.reject(new SaveAllResourcesError('EXTENSION_UNAVAILABLE', UNAVAILABLE_HELP));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new SaveAllResourcesError('TIMEOUT', `extension did not answer "${message.type}" within ${timeout}ms`));
      }, timeout);
      try {
        runtime.sendMessage(extensionId, { v: PROTOCOL_VERSION, ...message }, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastError = runtime.lastError;
          if (lastError || response === undefined) {
            reject(new SaveAllResourcesError('EXTENSION_UNAVAILABLE', `${UNAVAILABLE_HELP} (${lastError?.message || 'no response'})`));
          } else if (!response.ok) {
            reject(new SaveAllResourcesError(response.error?.code || 'INTERNAL', response.error?.message || 'extension error'));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(new SaveAllResourcesError('EXTENSION_UNAVAILABLE', `${UNAVAILABLE_HELP} (${e.message})`));
      }
    });
  }

  async function isExtensionAvailable() {
    try {
      const r = await send({ type: 'ping' }, { timeout: Math.min(timeoutMs, 3000) });
      return { available: true, version: r.version, protocol: r.protocol, captureMode: r.captureMode, devtoolsRequired: r.devtoolsRequired };
    } catch (e) {
      return { available: false, code: e.code, reason: e.message };
    }
  }

  async function startWebsiteCapture({ jobId, url, options = {}, upload }) {
    const r = await send({ type: 'startCapture', jobId, url, options, upload });
    return { duplicate: r.duplicate, status: r.status };
  }

  async function getCaptureStatus(jobId) {
    return (await send({ type: 'getStatus', jobId })).status;
  }

  async function cancelCapture(jobId) {
    return (await send({ type: 'cancel', jobId })).status;
  }

  async function getCaptureResult(jobId) {
    return (await send({ type: 'getResult', jobId })).result;
  }

  async function retryUploads(jobId) {
    return (await send({ type: 'retryUploads', jobId })).status;
  }

  /** Poll until the extension reports a terminal status. */
  async function waitForCapture(jobId, { intervalMs = 1500, onProgress, signal } = {}) {
    for (;;) {
      if (signal?.aborted) throw new SaveAllResourcesError('ABORTED', 'stopped waiting');
      const status = await getCaptureStatus(jobId);
      onProgress?.(status);
      if (TERMINAL_STATUSES.includes(status.status)) return status;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  return { isExtensionAvailable, startWebsiteCapture, getCaptureStatus, cancelCapture, getCaptureResult, retryUploads, waitForCapture };
}

// Service worker of the Save All Resources automation build.
// Exposes the existing capture logic to configured application origins through
// chrome.runtime.onMessageExternal (declared in manifest.externally_connectable).

import { BUILD_CONFIG } from './build-config.js';
import {
  validateSenderOrigin,
  validateMessage,
  okResponse,
  errorResponse,
  PROTOCOL_VERSION,
} from '../shared/protocol.js';
import { startJob, getJob, cancelJob, summarize, resultOf, resumeActiveJob, retryUploads } from './jobs.js';

const WATCHDOG = 'sar-watchdog';

async function handle(message, sender) {
  // 1. Sender origin must be an explicitly configured application origin.
  const origin = validateSenderOrigin(sender, BUILD_CONFIG.allowedAppOrigins);
  // 2. Payload schema, bounds and upload destination.
  const msg = validateMessage(message, { allowedUploadOrigins: BUILD_CONFIG.allowedUploadOrigins });
  switch (msg.type) {
    case 'ping':
      return okResponse({
        extension: 'save-all-resources-automation',
        version: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
        captureMode: 'chrome.debugger',
        devtoolsRequired: false,
      });
    case 'startCapture': {
      const { duplicate, job } = await startJob(msg, origin);
      return okResponse({ duplicate, status: job });
    }
    case 'getStatus':
      return okResponse({ status: summarize(await getJob(msg.jobId)) });
    case 'cancel':
      return okResponse({ status: await cancelJob(msg.jobId) });
    case 'getResult':
      return okResponse({ result: resultOf(await getJob(msg.jobId)) });
    case 'retryUploads':
      return okResponse({ status: await retryUploads(msg.jobId) });
    default:
      throw new Error('unreachable');
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handle(message, sender).then(sendResponse, (err) => {
    console.warn('[SAR automation] rejected message', err?.code, err?.message);
    sendResponse(errorResponse(err));
  });
  return true; // async response
});

// Lifecycle: MV3 service workers can be stopped. Jobs are persisted and resumed by the watchdog.
chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG) resumeActiveJob();
});
chrome.runtime.onStartup.addListener(() => resumeActiveJob());
chrome.runtime.onInstalled.addListener(() => resumeActiveJob());
resumeActiveJob();

// Launch page logic: exchanges a one-time launch code for the job descriptor, hands the job to the
// extension through the integration module and reports progress. Not a dashboard: it only exists
// because extension messaging must originate from a page on a configured application origin.
import { createSaveAllResourcesClient, TERMINAL_STATUSES } from './sar-client.js';

const $ = (id) => document.getElementById(id);
const setState = (text, isError = false) => {
  $('state').textContent = text;
  $('state').className = isError ? 'error' : '';
  document.title = text;
  document.documentElement.dataset.state = isError ? 'error' : text;
};
const show = (obj) => ($('detail').textContent = JSON.stringify(obj, null, 2));

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function main() {
  const code = new URLSearchParams(location.hash.slice(1)).get('launch');
  history.replaceState(null, '', location.pathname); // keep the one-time code out of history
  if (!code) return setState('Missing launch code. Start jobs with `npm run capture -- <url>`.', true);

  const launch = await api(`/api/launch/${encodeURIComponent(code)}`, { method: 'POST' });
  const sar = createSaveAllResourcesClient({ extensionId: launch.extensionId });
  window.__sarJob = { jobId: launch.jobId };

  const availability = await sar.isExtensionAvailable();
  if (!availability.available) {
    await api(`/api/jobs/${launch.jobId}/extension-unavailable`, { method: 'POST', token: launch.controlToken, body: { reason: availability.reason } }).catch(() => {});
    return setState(`Extension unavailable: ${availability.reason}`, true);
  }

  const { duplicate, status } = await sar.startWebsiteCapture({ jobId: launch.jobId, url: launch.url, options: launch.options, upload: launch.upload });
  setState(duplicate ? 'Job already running in the extension' : 'Capturing');
  show(status);

  $('cancel').hidden = false;
  $('cancel').onclick = async () => {
    await sar.cancelCapture(launch.jobId).catch((e) => show({ cancelError: e.message }));
    await api(`/api/jobs/${launch.jobId}/cancel`, { method: 'POST', token: launch.controlToken }).catch(() => {});
  };

  const capture = await sar.waitForCapture(launch.jobId, { onProgress: (s) => {
    setState(`Capture: ${s.stage} — ${s.progress.captured}/${s.progress.discovered} pages`);
    show(s);
  } });
  $('cancel').hidden = true;
  setState(`Capture ${capture.status}; processing on server`);

  for (;;) {
    const job = await api(`/api/jobs/${launch.jobId}`, { token: launch.controlToken });
    show(job);
    if (TERMINAL_STATUSES.includes(job.status)) {
      setState(`Job ${job.status}`, job.status === 'failed');
      return;
    }
    setState(`Server: ${job.status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((e) => setState(`Error: ${e.message}`, true));

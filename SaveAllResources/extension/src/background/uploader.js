// Uploads per-page capture zips to the job-scoped endpoint with bounded retries. Zips whose upload
// keeps failing are parked in IndexedDB so they survive service-worker restarts and can be retried.

const DB_NAME = 'sar-automation';
const STORE = 'pendingUploads';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const pendingQueue = {
  put: (jobId, pageId, blob) => tx('readwrite', (s) => s.put({ key: `${jobId}/${pageId}`, jobId, pageId, blob, at: Date.now() })),
  delete: (jobId, pageId) => tx('readwrite', (s) => s.delete(`${jobId}/${pageId}`)),
  async list(jobId) {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).filter((e) => e.jobId === jobId);
  },
  async clearJob(jobId) {
    for (const e of await this.list(jobId)) await this.delete(e.jobId, e.pageId);
  },
};

export class UploadError extends Error {
  constructor(message, { status, fatal = false, cancelled = false } = {}) {
    super(message);
    this.status = status;
    this.fatal = fatal;
    this.cancelled = cancelled;
  }
}

async function request(upload, path, { method = 'POST', body, contentType, timeoutMs = 120_000 }) {
  if (Date.now() >= upload.expiresAt) throw new UploadError('upload token expired', { fatal: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${upload.endpoint}${path}`, {
      method,
      body,
      headers: { Authorization: `Bearer ${upload.token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error', // never follow redirects to an unvalidated destination
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new UploadError(`network error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 409) throw new UploadError('job was cancelled by the application', { status: 409, cancelled: true, fatal: true });
  if (res.status === 401 || res.status === 403) throw new UploadError(`upload rejected (${res.status})`, { status: res.status, fatal: true });
  if (res.status === 413 || res.status === 400) throw new UploadError(`upload rejected (${res.status})`, { status: res.status, fatal: true });
  if (!res.ok) throw new UploadError(`upload failed (${res.status})`, { status: res.status });
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export async function withRetries(fn, { attempts = 4, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

export function uploadPage(upload, pageId, blob, opts) {
  return withRetries(() => request(upload, `/pages/${encodeURIComponent(pageId)}`, { method: 'PUT', body: blob, contentType: 'application/zip' }), opts);
}

export function postJson(upload, path, data, opts) {
  return withRetries(() => request(upload, path, { body: JSON.stringify(data), contentType: 'application/json', timeoutMs: 30_000 }), opts);
}

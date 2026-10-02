// Application server: job creation, launch-code exchange, job-scoped upload endpoints for the
// extension, status/cancel/export APIs, and a background processing queue (worker threads).
import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from './lib/config.mjs';
import { signToken, verifyToken, bearer, safeEqual } from './lib/tokens.mjs';
import { JobStore, newJobId, TERMINAL } from './lib/job-store.mjs';
import { normalizeOptions, validateHttpUrl, ProtocolError } from '../extension/src/shared/protocol.js';

const PUBLIC_DIR = join(ROOT, 'app/public');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

async function readJson(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** Background processing: one worker thread at a time, outside the HTTP request lifecycle. */
class ProcessingQueue {
  constructor(store, config, log) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.queue = [];
    this.active = null;
    this.idleWaiters = [];
  }

  enqueue(jobId, mode = 'full') {
    if (this.active?.jobId === jobId || this.queue.some((q) => q.jobId === jobId)) return;
    this.queue.push({ jobId, mode });
    this.pump();
  }

  pump() {
    if (this.active || !this.queue.length) {
      if (!this.active && !this.queue.length) this.idleWaiters.splice(0).forEach((fn) => fn());
      return;
    }
    const item = this.queue.shift();
    this.active = item;
    const worker = new Worker(new URL('./processing/worker.mjs', import.meta.url), {
      workerData: { jobId: item.jobId, mode: item.mode, dataDir: this.config.dataDir, verification: this.config.verification },
    });
    worker.on('message', (m) => {
      if (m.type === 'stage') {
        this.store.update(item.jobId, (job) => {
          if (!TERMINAL.includes(job.status) || m.final) job.status = m.status;
          job.processing = { ...job.processing, ...m.processing };
        });
        this.log(`[${item.jobId}] ${m.status}`);
      }
    });
    const done = (err) => {
      if (err) {
        this.store.update(item.jobId, (job) => {
          if (!TERMINAL.includes(job.status)) job.status = 'failed';
          job.errors.push(`processing worker crashed: ${err.message || err}`);
        });
      }
      this.active = null;
      this.pump();
    };
    worker.on('error', done);
    worker.on('exit', (code) => (code === 0 ? done() : done(new Error(`exit code ${code}`))));
  }

  whenIdle() {
    return this.active || this.queue.length ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }
}

export function createAppServer(overrides = {}, { faults = {}, log = console.log } = {}) {
  const config = loadConfig(overrides);
  const store = new JobStore(config.dataDir);
  const queue = new ProcessingQueue(store, config, log);
  const launchCodes = new Map(); // code -> { jobId, expiresAt }

  const requireApp = (req) => {
    if (!safeEqual(bearer(req), config.appApiToken)) throw new HttpError(401, 'application token required');
  };
  const requireAppOrControl = (req, jobId) => {
    const t = bearer(req);
    if (safeEqual(t, config.appApiToken)) return;
    if (!verifyToken(config.uploadTokenSecret, t, { jobId, scope: 'control' })) throw new HttpError(401, 'job token required');
  };
  const requireUpload = (req, jobId) => {
    // Only the extension (or a non-browser client) may upload: reject other web origins.
    const origin = req.headers.origin;
    if (origin && origin !== `chrome-extension://${config.extensionId}`) throw new HttpError(403, `origin ${origin} may not upload`);
    if (!verifyToken(config.uploadTokenSecret, bearer(req), { jobId, scope: 'upload' })) throw new HttpError(401, 'invalid or expired upload token');
  };
  const getJob = (jobId) => {
    const job = store.get(jobId);
    if (!job) throw new HttpError(404, 'unknown job');
    return job;
  };

  function publicJob(job) {
    const { launch, ...rest } = job;
    return { ...rest, exportUrl: job.exportFile ? `/api/jobs/${job.jobId}/export` : null };
  }

  function createJob({ url, options = {}, template = {} }) {
    let normalized;
    try {
      normalized = { url: validateHttpUrl(url), options: normalizeOptions(options) };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    if (!config.extensionId) throw new HttpError(500, 'extension id unknown: run `npm run build:extension` first');
    const jobId = newJobId();
    const job = {
      schema: 1,
      jobId,
      url: normalized.url,
      options: normalized.options,
      template,
      status: 'awaiting_extension',
      createdAt: Date.now(),
      uploads: {},
      capture: null,
      processing: {},
      errors: [],
      warnings: [],
      cancelRequested: false,
    };
    store.save(job);
    const code = randomBytes(18).toString('base64url');
    launchCodes.set(code, { jobId, expiresAt: Date.now() + config.launchCodeTtlMs });
    return { job, launchUrl: `${config.publicOrigin}/capture.html#launch=${code}` };
  }

  async function handleUpload(req, res, jobId, pageId) {
    requireUpload(req, jobId);
    const job = getJob(jobId);
    if (job.cancelRequested || job.status === 'cancelled') throw new HttpError(409, 'job cancelled');
    if (!PAGE_ID.test(pageId)) throw new HttpError(400, 'invalid page id');
    if (!/zip/.test(req.headers['content-type'] || '')) throw new HttpError(400, 'expected application/zip');
    if (faults.failUploads > 0) {
      faults.failUploads--; // test hook: simulated upload outage
      req.resume();
      throw new HttpError(503, 'injected upload failure');
    }
    const dir = join(store.dir(jobId), 'uploads');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${pageId}.zip.part`);
    let size = 0;
    let magic = Buffer.alloc(0);
    await new Promise((resolveP, reject) => {
      const out = createWriteStream(tmp);
      req.on('data', (c) => {
        size += c.length;
        if (magic.length < 4) magic = Buffer.concat([magic, c]).subarray(0, 4);
        if (size > config.maxUploadBytes) {
          req.destroy();
          out.destroy();
          reject(new HttpError(413, 'upload too large'));
        }
      });
      req.pipe(out);
      out.on('finish', resolveP);
      out.on('error', reject);
      req.on('error', reject);
    });
    if (magic.toString('binary') !== 'PK\x03\x04') {
      rmSync(tmp, { force: true });
      throw new HttpError(400, 'body is not a zip archive');
    }
    renameSync(tmp, join(dir, `${pageId}.zip`));
    store.update(jobId, (j) => {
      j.uploads[pageId] = { bytes: size, at: Date.now() };
      if (j.status === 'awaiting_extension') j.status = 'capturing';
    });
    send(res, 200, { ok: true, pageId, bytes: size });
  }

  async function handle(req, res) {
    const url = new URL(req.url, config.publicOrigin);
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method;

    // Static launcher assets (no listing, fixed directory).
    if (m === 'GET' && (url.pathname === '/' || ['capture.html', 'launcher.js', 'sar-client.js'].includes(parts[0]))) {
      const file = url.pathname === '/' ? 'capture.html' : parts[0];
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return createReadStream(join(PUBLIC_DIR, file)).pipe(res);
    }

    if (parts[0] !== 'api') throw new HttpError(404, 'not found');

    // --- application API -------------------------------------------------------------------
    if (m === 'POST' && parts[1] === 'jobs' && parts.length === 2) {
      requireApp(req);
      const { job, launchUrl } = createJob(await readJson(req));
      return send(res, 201, { jobId: job.jobId, launchUrl, job: publicJob(job) });
    }
    if (m === 'POST' && parts[1] === 'launch' && parts.length === 3) {
      if (req.headers.origin && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'cross-origin launch refused');
      const entry = launchCodes.get(parts[2]);
      launchCodes.delete(parts[2]); // single use
      if (!entry || entry.expiresAt < Date.now()) throw new HttpError(404, 'launch code invalid or expired');
      const job = getJob(entry.jobId);
      const upload = signToken(config.uploadTokenSecret, { jobId: job.jobId, scope: 'upload', ttlMs: config.uploadTokenTtlMs });
      const control = signToken(config.uploadTokenSecret, { jobId: job.jobId, scope: 'control', ttlMs: config.uploadTokenTtlMs });
      return send(res, 200, {
        jobId: job.jobId,
        url: job.url,
        options: job.options,
        extensionId: config.extensionId,
        upload: { endpoint: `${config.publicOrigin}/api/capture-jobs/${job.jobId}`, token: upload.token, expiresAt: upload.expiresAt },
        controlToken: control.token,
      });
    }
    if (parts[1] === 'jobs' && parts[2]) {
      const jobId = parts[2];
      if (m === 'GET' && parts.length === 3) {
        requireAppOrControl(req, jobId);
        return send(res, 200, publicJob(getJob(jobId)));
      }
      if (m === 'POST' && parts[3] === 'cancel') {
        requireAppOrControl(req, jobId);
        const job = store.update(jobId, (j) => {
          if (TERMINAL.includes(j.status)) return;
          j.cancelRequested = true;
          if (['awaiting_extension', 'capturing'].includes(j.status)) j.status = 'cancelled';
        });
        return send(res, 200, publicJob(job));
      }
      if (m === 'POST' && parts[3] === 'extension-unavailable') {
        requireAppOrControl(req, jobId);
        const body = await readJson(req);
        const job = store.update(jobId, (j) => {
          if (j.status !== 'awaiting_extension') return;
          j.status = 'failed';
          j.errors.push(`extension unavailable: ${String(body.reason || '').slice(0, 500)}`);
        });
        return send(res, 200, publicJob(job));
      }
      if (m === 'GET' && parts[3] === 'export') {
        requireAppOrControl(req, jobId);
        const job = getJob(jobId);
        if (!job.exportFile || !existsSync(job.exportFile)) throw new HttpError(404, 'export not available yet');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': statSync(job.exportFile).size,
          'Content-Disposition': `attachment; filename="${jobId}-website-template.zip"`,
        });
        return createReadStream(job.exportFile).pipe(res);
      }
    }

    // --- extension upload API (job-scoped bearer token) -------------------------------------
    if (parts[1] === 'capture-jobs' && parts[2]) {
      const jobId = parts[2];
      if (m === 'PUT' && parts[3] === 'pages' && parts[4] && parts.length === 5) return handleUpload(req, res, jobId, decodeURIComponent(parts[4]));
      if (m === 'POST' && parts[3] === 'progress' && parts.length === 4) {
        requireUpload(req, jobId);
        const body = await readJson(req);
        const job = store.update(jobId, (j) => {
          j.capture = { ...(j.capture || {}), progress: body.progress, stage: body.stage, limits: body.limits, updatedAt: Date.now() };
          if (j.status === 'awaiting_extension') j.status = 'capturing';
        });
        return send(res, 200, { ok: true, cancelled: !!job.cancelRequested });
      }
      if (m === 'POST' && parts[3] === 'complete' && parts.length === 4) {
        requireUpload(req, jobId);
        const body = await readJson(req, 20_000_000);
        const job = store.update(jobId, (j) => {
          j.capture = { ...body, receivedAt: Date.now() };
          if (TERMINAL.includes(j.status) && j.status !== 'cancelled') return;
          if (body.status === 'cancelled' || j.cancelRequested) j.status = 'cancelled';
          else if (body.status === 'failed' && !Object.keys(j.uploads).length) {
            j.status = 'failed';
            j.errors.push(...(body.errors || []).map((e) => `capture: ${e}`));
          } else j.status = 'packaging';
        });
        if (job.status === 'packaging') queue.enqueue(jobId, 'full');
        else if (job.status === 'cancelled' && Object.keys(job.uploads).length) queue.enqueue(jobId, 'raw-only');
        return send(res, 200, { ok: true, status: job.status });
      }
    }
    throw new HttpError(404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : e instanceof ProtocolError ? 400 : 500;
      if (status === 500) log('[server] error', e);
      if (!res.headersSent) send(res, status, { error: e.message });
      else res.destroy();
    });
  });

  // Resume processing that was interrupted by a server restart.
  for (const job of store.list()) {
    if (['packaging', 'templatising', 'verifying'].includes(job.status)) queue.enqueue(job.jobId, 'full');
  }

  return {
    config,
    store,
    queue,
    faults,
    server,
    createJob,
    listen: () =>
      new Promise((r) => server.listen(config.port, config.host === 'localhost' ? undefined : config.host, () => r(server.address()))),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createAppServer();
  await app.listen();
  console.log(`SAR template server on ${app.config.publicOrigin} (extension ${app.config.extensionId || 'NOT BUILT'})`);
  console.log(`Application API token: stored in ${join(app.config.dataDir, 'secrets.json')} (or SAR_APP_API_TOKEN)`);
}


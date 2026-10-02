// Persistent capture jobs: discovery -> capture -> upload, with cancellation, duplicate-job
// prevention, bounded retries and recovery after service-worker restarts.

import { CrawlScope, canonicalizeUrl, pageIdForUrl, redactUrl } from '../shared/url-scope.js';
import { parseRobots, parseSitemap, isAllowedByRobots } from '../shared/sitemap.js';
import { ProtocolError, ERROR_CODES, TERMINAL_STATUSES } from '../shared/protocol.js';
import { capturePage, CaptureError } from './page-capture.js';
import { uploadPage, postJson, pendingQueue, UploadError } from './uploader.js';

const ACTIVE_KEY = 'activeJobId';
const jobKey = (id) => `job:${id}`;
const uploadKey = (id) => `upload:${id}`;
const MAX_SKIPPED = 2000;
const running = new Map(); // jobId -> AbortController (this service-worker instance only)

const now = () => Date.now();

async function loadJob(jobId) {
  return (await chrome.storage.local.get(jobKey(jobId)))[jobKey(jobId)] || null;
}

async function saveJob(job) {
  job.updatedAt = now();
  await chrome.storage.local.set({ [jobKey(job.jobId)]: job });
}

async function getUpload(jobId) {
  // Upload credentials live in session storage (memory only, never written to disk).
  return (await chrome.storage.session.get(uploadKey(jobId)))[uploadKey(jobId)] || null;
}

export function summarize(job) {
  const count = (s) => job.pages.filter((p) => p.status === s).length;
  return {
    jobId: job.jobId,
    url: job.url,
    status: job.status,
    stage: job.stage,
    currentUrl: job.currentUrl || null,
    progress: {
      discovered: job.pages.length,
      captured: count('captured'),
      failed: job.pages.filter((p) => ['failed', 'inaccessible'].includes(p.status)).length,
      pending: count('pending') + count('capturing'),
      notCaptured: count('not_captured'),
      aliases: count('alias'),
      uploaded: job.pages.filter((p) => p.uploaded).length,
      pendingUploads: job.pages.filter((p) => p.status === 'captured' && !p.uploaded).length,
    },
    limits: job.limits,
    discoveryComplete: job.discovery.complete,
    errors: job.errors.slice(-20),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
  };
}

export function resultOf(job) {
  return {
    ...summarize(job),
    options: job.options,
    discovery: job.discovery,
    pages: job.pages,
    skippedUrls: job.skippedUrls,
  };
}

export async function getJob(jobId) {
  const job = await loadJob(jobId);
  if (!job) throw new ProtocolError(ERROR_CODES.UNKNOWN_JOB, `unknown job ${jobId}`);
  return job;
}

export async function startJob({ jobId, url, options, upload }, senderOrigin) {
  const existing = await loadJob(jobId);
  if (existing) {
    // Idempotent: re-sending the same start returns the existing job instead of starting another.
    if (existing.url !== url) throw new ProtocolError(ERROR_CODES.DUPLICATE_JOB, `job ${jobId} already exists for a different URL`);
    return { duplicate: true, job: summarize(existing) };
  }
  const activeId = (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY];
  if (activeId) {
    const active = await loadJob(activeId);
    if (active && !TERMINAL_STATUSES.includes(active.status)) {
      const code = active.url === url ? ERROR_CODES.DUPLICATE_JOB : ERROR_CODES.EXTENSION_BUSY;
      throw new ProtocolError(code, `job ${activeId} is already running (${active.url})`);
    }
  }
  const scope = new CrawlScope(url, options);
  const job = {
    schema: 1,
    jobId,
    url,
    options,
    senderOrigin,
    status: 'queued',
    stage: 'queued',
    createdAt: now(),
    startedAt: now(),
    updatedAt: now(),
    scope: scope.toJSON(),
    robotsRules: null,
    pages: [],
    skippedUrls: [],
    limits: { reached: [], remainingUrls: [] },
    discovery: { sitemaps: [], sitemapUrls: 0, complete: true, notes: [] },
    totals: { bytes: 0 },
    errors: [],
    cancelRequested: false,
    windowId: null,
  };
  await chrome.storage.session.set({ [uploadKey(jobId)]: upload });
  await saveJob(job);
  await chrome.storage.local.set({ [ACTIVE_KEY]: jobId });
  runJob(jobId); // detached; progress is persisted
  return { duplicate: false, job: summarize(job) };
}

export async function cancelJob(jobId) {
  const job = await getJob(jobId);
  if (TERMINAL_STATUSES.includes(job.status)) return summarize(job);
  job.cancelRequested = true;
  await saveJob(job);
  running.get(jobId)?.abort();
  if (!running.has(jobId)) await finishCancelled(job);
  return summarize(await getJob(jobId));
}

async function finishCancelled(job) {
  for (const p of job.pages) if (p.status === 'pending' || p.status === 'capturing') p.status = 'cancelled';
  job.status = 'cancelled';
  job.stage = 'cancelled';
  job.finishedAt = now();
  await saveJob(job);
  const upload = await getUpload(job.jobId);
  if (upload) await postJson(upload, '/complete', { ...resultOf(job), cancelled: true }, { attempts: 2 }).catch(() => {});
  await cleanupWindow(job);
}

export async function retryUploads(jobId) {
  const job = await getJob(jobId);
  const upload = await getUpload(jobId);
  if (!upload) throw new ProtocolError(ERROR_CODES.INVALID_UPLOAD_DESTINATION, 'upload credentials are no longer available for this job');
  const res = await flushPendingUploads(job, upload);
  await saveJob(job);
  if (res.remaining === 0 && job.status === 'completed_with_warnings' && job.awaitingUploads) {
    job.awaitingUploads = false;
    await postJson(upload, '/complete', resultOf(job)).catch((e) => job.errors.push(`complete notification failed: ${e.message}`));
    await saveJob(job);
  }
  return summarize(job);
}

/** Resume an interrupted job (service worker was stopped or the browser restarted). */
export async function resumeActiveJob() {
  const activeId = (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY];
  if (!activeId || running.has(activeId)) return;
  const job = await loadJob(activeId);
  if (!job || TERMINAL_STATUSES.includes(job.status)) return;
  job.errors.push(`resumed after extension interruption at ${new Date().toISOString()}`);
  for (const p of job.pages) if (p.status === 'capturing') p.status = 'pending';
  await saveJob(job);
  if (job.cancelRequested) return finishCancelled(job);
  runJob(activeId);
}

function pushSkipped(job, entry) {
  if (job.skippedUrls.length < MAX_SKIPPED && !job.skippedUrls.some((s) => s.url === entry.url)) job.skippedUrls.push(entry);
}

function addToInventory(job, scope, rawUrl, base, depth, via) {
  const check = scope.check(rawUrl, base);
  if (!check.ok) {
    if (check.url && check.reason !== 'out-of-scope') pushSkipped(job, { url: redactUrl(check.url), reason: check.reason, via });
    else if (check.reason === 'out-of-scope') job.discovery.externalLinks = (job.discovery.externalLinks || 0) + 1;
    return null;
  }
  const url = check.url;
  const existing = job.pages.find((p) => p.url === url || p.finalUrl === url);
  if (existing) {
    if (!existing.via.includes(via)) existing.via.push(via);
    if (depth < existing.depth && existing.status === 'pending') existing.depth = depth;
    return existing;
  }
  if (job.robotsRules && job.options.respectRobots && !isAllowedByRobots(job.robotsRules, url)) {
    pushSkipped(job, { url: redactUrl(url), reason: 'robots-disallow', via });
    return null;
  }
  if (depth > job.options.maxDepth) {
    if (!job.limits.reached.includes('maxDepth')) job.limits.reached.push('maxDepth');
    if (!job.limits.remainingUrls.some((r) => r.url === url)) job.limits.remainingUrls.push({ url: redactUrl(url), reason: 'depth-limit' });
    return null;
  }
  const inventoryCap = job.options.maxPages * 4 + 50;
  if (job.pages.length >= inventoryCap) {
    if (!job.limits.reached.includes('inventorySize')) job.limits.reached.push('inventorySize');
    if (job.limits.remainingUrls.length < MAX_SKIPPED) job.limits.remainingUrls.push({ url: redactUrl(url), reason: 'inventory-limit' });
    return null;
  }
  scope.register(url);
  const page = {
    id: pageIdForUrl(url, new Set(job.pages.map((p) => p.id))),
    url,
    depth,
    via: [via],
    status: 'pending',
    attempts: 0,
    uploaded: false,
    warnings: [],
  };
  job.pages.push(page);
  return page;
}

async function fetchText(url, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // credentials: 'omit' — discovery never uses the browser session.
    const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status };
    if (/\.gz($|\?)/.test(url) && !/xml|text/.test(res.headers.get('content-type') || '')) {
      const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
      return { ok: true, text: await new Response(stream).text(), finalUrl: res.url };
    }
    return { ok: true, text: await res.text(), finalUrl: res.url };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function discover(job, scope) {
  const origin = new URL(job.url).origin;
  if (job.options.respectRobots || job.options.useSitemaps) {
    const robots = await fetchText(`${origin}/robots.txt`);
    if (robots.ok) {
      const parsed = parseRobots(robots.text);
      job.robotsRules = parsed.rules;
      if (job.options.useSitemaps) job.discovery.sitemaps.push(...parsed.sitemaps);
    }
  }
  if (!job.options.useSitemaps) return;
  if (!job.discovery.sitemaps.length) job.discovery.sitemaps.push(`${origin}/sitemap.xml`);
  const queue = [...new Set(job.discovery.sitemaps)];
  const seen = new Set();
  let fetched = 0;
  while (queue.length && fetched < 25) {
    const sm = queue.shift();
    if (seen.has(sm) || !scope.inScope(sm)) continue;
    seen.add(sm);
    fetched++;
    const res = await fetchText(sm);
    if (!res.ok) {
      job.discovery.notes.push(`sitemap ${sm} unavailable (${res.status || res.error})`);
      continue;
    }
    const { type, locs } = parseSitemap(res.text, job.options.maxSitemapUrls);
    if (type === 'sitemapindex') {
      queue.push(...locs);
      continue;
    }
    for (const loc of locs) {
      if (job.discovery.sitemapUrls >= job.options.maxSitemapUrls) {
        job.discovery.complete = false;
        if (!job.limits.reached.includes('maxSitemapUrls')) job.limits.reached.push('maxSitemapUrls');
        break;
      }
      job.discovery.sitemapUrls++;
      addToInventory(job, scope, loc, undefined, 1, 'sitemap');
    }
  }
  if (queue.length) {
    job.discovery.complete = false;
    job.discovery.notes.push(`${queue.length} sitemap files not fetched (limit 25)`);
  }
}

async function ensureWindow(job) {
  if (job.windowId != null) {
    try {
      await chrome.windows.get(job.windowId);
      return job.windowId;
    } catch {
      /* closed by the user; recreate */
    }
  }
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal', width: 1400, height: 1000 });
  job.windowId = win.id;
  return win.id;
}

async function cleanupWindow(job) {
  if (job.windowId == null) return;
  try {
    await chrome.windows.remove(job.windowId);
  } catch {
    /* already closed */
  }
  job.windowId = null;
  await saveJob(job);
}

function markRemaining(job, reason, limitName) {
  if (!job.limits.reached.includes(limitName)) job.limits.reached.push(limitName);
  for (const p of job.pages) {
    if (p.status === 'pending') {
      p.status = 'not_captured';
      p.reason = reason;
      job.limits.remainingUrls.push({ url: redactUrl(p.url), reason });
    }
  }
  job.discovery.complete = false;
}

async function flushPendingUploads(job, upload) {
  let remaining = 0;
  for (const entry of await pendingQueue.list(job.jobId)) {
    const page = job.pages.find((p) => p.id === entry.pageId);
    try {
      await uploadPage(upload, entry.pageId, entry.blob, { attempts: 3 });
      await pendingQueue.delete(job.jobId, entry.pageId);
      if (page) {
        page.uploaded = true;
        page.uploadError = null;
      }
    } catch (e) {
      remaining++;
      if (page) page.uploadError = e.message;
    }
  }
  return { remaining };
}

async function runJob(jobId) {
  if (running.has(jobId)) return;
  const ctrl = new AbortController();
  running.set(jobId, ctrl);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  let job = await loadJob(jobId);
  const upload = await getUpload(jobId);
  try {
    if (!upload) throw new UploadError('upload credentials lost (browser restarted); start a new job', { fatal: true });
    const scope = CrawlScope.fromJSON(job.scope, job.options);
    const persist = async () => {
      job.scope = scope.toJSON();
      await saveJob(job);
    };

    if (job.stage === 'queued') {
      job.status = 'running';
      job.stage = 'discovering';
      await persist();
      addToInventory(job, scope, job.url, undefined, 0, 'entry');
      await discover(job, scope);
      job.stage = 'capturing';
      await persist();
    }

    const deadline = job.startedAt + job.options.maxDurationMs;
    while (true) {
      if (ctrl.signal.aborted || job.cancelRequested) break;
      const pending = job.pages.filter((p) => p.status === 'pending').sort((a, b) => a.depth - b.depth);
      if (!pending.length) break;
      const attempted = job.pages.filter((p) => ['captured', 'failed', 'inaccessible', 'alias', 'redirected_out_of_scope'].includes(p.status)).length;
      if (attempted >= job.options.maxPages) {
        markRemaining(job, 'page-limit', 'maxPages');
        break;
      }
      if (now() > deadline) {
        markRemaining(job, 'time-limit', 'maxDurationMs');
        break;
      }
      if (job.totals.bytes > job.options.maxTotalBytes) {
        markRemaining(job, 'byte-limit', 'maxTotalBytes');
        break;
      }
      const page = pending[0];
      page.status = 'capturing';
      page.attempts++;
      job.currentUrl = page.url;
      await persist();

      let result;
      try {
        const windowId = await ensureWindow(job);
        await persist();
        result = await capturePage({
          url: page.url,
          pageId: page.id,
          windowId,
          options: job.options,
          signal: ctrl.signal,
          onProgress: (step) => {
            page.step = step;
          },
        });
      } catch (e) {
        if (ctrl.signal.aborted || e.code === 'CANCELLED') {
          page.status = 'cancelled';
          break;
        }
        const retryable = e instanceof CaptureError ? e.retryable : true;
        if (retryable && page.attempts <= job.options.maxRetries) {
          page.status = 'pending';
          page.warnings.push(`attempt ${page.attempts} failed: ${e.message}`);
        } else {
          page.status = e.code === 'INACCESSIBLE' ? 'inaccessible' : 'failed';
          page.reason = `${e.code || 'ERROR'}: ${e.message}`;
          if (e.partial) Object.assign(page, { httpStatus: e.partial.httpStatus, finalUrl: e.partial.finalUrl && redactUrl(e.partial.finalUrl) });
        }
        await persist();
        continue;
      }

      const { meta, zip } = result;
      job.totals.bytes += meta.bytesTransferred || 0;
      page.httpStatus = meta.httpStatus;
      page.finalUrl = meta.finalUrl;
      page.title = meta.title;
      page.redirects = meta.redirects;
      page.warnings.push(...meta.warnings);
      page.step = null;

      const finalCanonical = canonicalizeUrl(meta.finalUrl, undefined, job.options);
      if (!scope.inScope(finalCanonical || meta.finalUrl)) {
        page.status = 'redirected_out_of_scope';
        page.reason = `redirected to ${meta.finalUrl}`;
        await persist();
        continue;
      }
      const canonicalTarget = meta.canonical && canonicalizeUrl(meta.canonical, undefined, job.options);
      const alias = job.pages.find(
        (p) =>
          p !== page &&
          p.status === 'captured' &&
          (p.url === finalCanonical || p.finalUrl === meta.finalUrl || (canonicalTarget && canonicalTarget !== page.url && p.url === canonicalTarget) || (meta.renderedHash && p.renderedHash === meta.renderedHash))
      );
      if (alias) {
        page.status = 'alias';
        page.aliasOf = alias.id;
        page.reason = `equivalent to ${alias.url}`;
        await persist();
        continue;
      }
      page.renderedHash = meta.renderedHash;
      page.status = 'captured';
      page.resourceCount = meta.resources.length;
      page.failedRequests = meta.failedRequests.length;

      // Links found while visiting pages extend the inventory (BFS by depth).
      let found = 0;
      for (const link of meta.links) {
        const via = link.region === 'nav' ? 'nav' : link.region === 'footer' ? 'footer' : link.region === 'route' ? 'route' : 'link';
        if (addToInventory(job, scope, link.href, meta.finalUrl, page.depth + 1, via)) found++;
      }
      page.linksFound = found;
      await persist();

      try {
        await uploadPage(upload, page.id, zip);
        page.uploaded = true;
      } catch (e) {
        if (e.cancelled) {
          job.cancelRequested = true;
          break;
        }
        page.uploadError = e.message;
        await pendingQueue.put(job.jobId, page.id, zip);
        job.errors.push(`upload of ${page.id} failed: ${e.message} (queued for retry)`);
        if (e.fatal) throw e;
      }
      await persist();
      const ack = await postJson(upload, '/progress', summarize(job), { attempts: 1 }).catch(() => null);
      if (ack?.cancelled) job.cancelRequested = true;
    }

    if (job.cancelRequested || ctrl.signal.aborted) {
      await finishCancelled(job);
      return;
    }

    job.stage = 'uploading';
    job.currentUrl = null;
    await persist();
    const { remaining } = await flushPendingUploads(job, upload);
    const captured = job.pages.filter((p) => p.status === 'captured').length;
    const hasWarnings =
      remaining > 0 || job.limits.reached.length > 0 || !job.discovery.complete || job.pages.some((p) => p.status !== 'captured' && p.status !== 'alias');
    job.status = captured === 0 ? 'failed' : hasWarnings ? 'completed_with_warnings' : 'completed';
    job.stage = job.status;
    job.awaitingUploads = remaining > 0;
    if (remaining > 0) job.errors.push(`${remaining} page upload(s) still pending; call retryUploads`);
    if (captured === 0) job.errors.push('no page could be captured');
    job.finishedAt = now();
    await persist();
    if (remaining === 0) {
      await postJson(upload, '/complete', resultOf(job)).catch((e) => job.errors.push(`complete notification failed: ${e.message}`));
    }
    await persist();
  } catch (e) {
    job = job || (await loadJob(jobId));
    job.status = e.cancelled ? 'cancelled' : 'failed';
    job.stage = job.status;
    job.errors.push(e.message);
    job.finishedAt = now();
    await saveJob(job);
    if (upload && !e.fatal) await postJson(upload, '/complete', resultOf(job), { attempts: 2 }).catch(() => {});
  } finally {
    clearInterval(keepAlive);
    running.delete(jobId);
    if (job) await cleanupWindow(job);
  }
}

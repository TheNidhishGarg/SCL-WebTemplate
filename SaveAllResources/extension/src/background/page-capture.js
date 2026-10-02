// Captures one page in a dedicated tab:
// open tab -> attach debugger -> enable Network/Page before navigation (the point at which the
// upstream panel starts recording) -> load with bounded timeout -> incremental scroll -> safe
// interaction recipes -> original + rendered HTML -> desktop/mobile screenshots -> resources via
// Save All Resources' collector -> zip -> cleanup.

import { CdpSession } from './cdp.js';
import { collectWithSar, packageWithSar } from './sar-collector.js';
import { VIEWPORTS } from '../shared/protocol.js';
import { redactUrl, shortHash } from '../shared/url-scope.js';

const API_TYPES = new Set(['XHR', 'Fetch', 'EventSource', 'WebSocket', 'Ping', 'CSPViolationReport', 'Preflight', 'SignedExchange']);
const MEDIA_MIME = /^(video|audio)\//i;
const STREAM_URL = /\.(m3u8|mpd)(\?|$)/i;

export class CaptureError extends Error {
  constructor(code, message, { retryable = false, partial = null } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.partial = partial;
  }
}

class NetworkRecorder {
  constructor(cdp) {
    this.records = new Map();
    this.inflight = new Set();
    this.failed = [];
    this.lastActivity = Date.now();
    this.totalBytes = 0;
    this.off = cdp.on((method, p) => this.onEvent(method, p));
  }

  onEvent(method, p) {
    switch (method) {
      case 'Network.requestWillBeSent': {
        this.lastActivity = Date.now();
        const prev = this.records.get(p.requestId);
        const redirects = prev ? [...prev.redirects] : [];
        if (p.redirectResponse && prev) redirects.push({ url: prev.url, status: p.redirectResponse.status });
        this.records.set(p.requestId, {
          requestId: p.requestId,
          url: p.request.url,
          method: p.request.method,
          resourceType: p.type,
          frameId: p.frameId,
          loaderId: p.loaderId,
          redirects,
          finished: false,
        });
        this.inflight.add(p.requestId);
        break;
      }
      case 'Network.responseReceived': {
        const rec = this.records.get(p.requestId);
        if (!rec) break;
        rec.status = p.response.status;
        rec.mimeType = p.response.mimeType;
        rec.finalUrl = p.response.url;
        rec.resourceType = p.type || rec.resourceType;
        // Only the content type header is retained; cookies / auth headers are never stored.
        const headers = p.response.headers || {};
        const ct = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
        rec.contentType = ct ? headers[ct] : undefined;
        rec.fromServiceWorker = !!p.response.fromServiceWorker;
        break;
      }
      case 'Network.loadingFinished': {
        this.lastActivity = Date.now();
        this.inflight.delete(p.requestId);
        const rec = this.records.get(p.requestId);
        if (rec) {
          rec.finished = true;
          rec.size = p.encodedDataLength;
          this.totalBytes += p.encodedDataLength || 0;
        }
        break;
      }
      case 'Network.loadingFailed': {
        this.lastActivity = Date.now();
        this.inflight.delete(p.requestId);
        const rec = this.records.get(p.requestId);
        if (rec) {
          rec.finished = true;
          rec.error = p.errorText;
          rec.blockedReason = p.blockedReason;
          rec.canceled = p.canceled;
          this.failed.push({ url: rec.url, type: p.type, error: p.errorText, blockedReason: p.blockedReason || null, canceled: !!p.canceled });
        }
        break;
      }
      default:
    }
  }

  async waitForIdle(quietMs, maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      // Long-lived streams (EventSource, media) are not counted against idleness.
      const busy = [...this.inflight].filter((id) => {
        const r = this.records.get(id);
        return r && !['EventSource', 'WebSocket', 'Media'].includes(r.resourceType);
      });
      if (busy.length === 0 && Date.now() - this.lastActivity >= quietMs) return true;
      await sleep(100);
    }
    return false;
  }

  completed() {
    return [...this.records.values()].filter((r) => r.finished && !r.error && r.status !== undefined);
  }

  dispose() {
    this.off();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dedupeFailures(list) {
  const seen = new Map();
  for (const f of list) {
    const key = `${f.url} ${f.error}`;
    if (seen.has(key)) seen.get(key).count++;
    else seen.set(key, { ...f, count: 1 });
  }
  return [...seen.values()];
}

// Executed in the page. Returns links (with region), metadata and unsupported features.
const PAGE_INFO_SCRIPT = `(() => {
  const region = (el) => {
    if (el.closest('footer,[role=contentinfo]')) return 'footer';
    if (el.closest('nav,header,[role=navigation],[role=banner]')) return 'nav';
    return 'content';
  };
  const links = [];
  for (const a of document.querySelectorAll('a[href],area[href]')) {
    links.push({ href: a.href, text: (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 120), region: region(a) });
  }
  for (const el of document.querySelectorAll('[data-href],[data-route],[routerlink],[data-url]')) {
    const v = el.getAttribute('data-href') || el.getAttribute('data-route') || el.getAttribute('routerlink') || el.getAttribute('data-url');
    try { links.push({ href: new URL(v, location.href).href, text: (el.textContent || '').trim().slice(0, 120), region: 'route' }); } catch {}
  }
  const canonical = document.querySelector('link[rel=canonical]')?.href || null;
  const iframes = [...document.querySelectorAll('iframe[src]')].map((f) => ({ src: f.src, crossOrigin: (() => { try { return new URL(f.src).origin !== location.origin; } catch { return true; } })() }));
  let shadowHosts = 0;
  for (const el of document.querySelectorAll('*')) if (el.shadowRoot) shadowHosts++;
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    canonical,
    links,
    forms: [...document.forms].map((f) => ({ action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toLowerCase(), inputs: f.querySelectorAll('input,select,textarea').length })),
    passwordInputs: document.querySelectorAll('input[type=password]').length,
    iframes,
    shadowHosts,
    canvases: document.querySelectorAll('canvas').length,
    serviceWorkerControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };
})()`;

// Scroll in viewport steps; images still pending after scrolling get loading=eager temporarily.
const SCROLL_SCRIPT = (maxSteps, delay) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let steps = 0;
  for (; steps < ${maxSteps}; steps++) {
    const y = steps * Math.max(200, Math.floor(innerHeight * 0.8));
    if (y > document.documentElement.scrollHeight) break;
    window.scrollTo(0, y);
    await wait(${delay});
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  await wait(${delay});
  const pending = [...document.querySelectorAll('img[loading=lazy]')].filter((i) => !i.complete || !i.currentSrc);
  for (const img of pending) img.loading = 'eager';
  await wait(${delay});
  for (const img of pending) img.loading = 'lazy';
  window.scrollTo(0, 0);
  const stillMissing = [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') && !i.complete).map((i) => i.currentSrc || i.src).slice(0, 50);
  return { steps, eagerised: pending.length, stillMissing };
})()`;

// Safe interaction: refuses anything that could submit, navigate or transact.
const RECIPE_SCRIPT = (recipe) => `(async () => {
  const r = ${JSON.stringify(recipe)};
  const el = document.querySelector(r.selector);
  if (!el) return { ok: false, reason: 'selector-not-found' };
  const label = (el.textContent || el.getAttribute('aria-label') || el.value || '').trim();
  if (el.closest('form')) return { ok: false, reason: 'inside-form' };
  if (el.matches('[type=submit],[type=image],[type=reset]')) return { ok: false, reason: 'submit-control' };
  const a = el.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href') || '';
    const u = new URL(a.href, location.href);
    const samePage = href.startsWith('#') || (u.origin + u.pathname + u.search === location.origin + location.pathname + location.search);
    if (!samePage && !href.startsWith('javascript:')) return { ok: false, reason: 'navigating-link' };
  }
  if (/\\b(buy|checkout|pay|purchase|order|delete|remove|subscribe|submit|sign ?up|log ?in|log ?out|register|donate|book now|add to cart)\\b/i.test(label)) return { ok: false, reason: 'transactional-label' };
  const opts = { bubbles: true, cancelable: true, view: window };
  if (r.action === 'click') { el.click(); }
  else if (r.action === 'hover') { el.dispatchEvent(new MouseEvent('mouseover', opts)); el.dispatchEvent(new MouseEvent('mouseenter', opts)); }
  else if (r.action === 'focus') { el.focus(); }
  await new Promise((res) => setTimeout(res, r.waitMs));
  return { ok: true };
})()`;

// Assets referenced by the DOM / CSSOM that the browser did not need at the captured viewports
// (srcset alternatives, data-src lazy images, backgrounds inside other media queries, icons).
// Extraction only: nothing in the page is modified.
const REFERENCED_ASSETS_SCRIPT = `(() => {
  const out = new Set();
  const add = (u, base) => { try { const x = new URL(u, base || document.baseURI); if (x.protocol === 'http:' || x.protocol === 'https:') out.add(x.href.split('#')[0]); } catch {} };
  const addSrcset = (v) => (v || '').split(/,\\s+/).forEach((c) => { const u = c.trim().split(/\\s+/)[0]; if (u) add(u); });
  document.querySelectorAll('img[src],source[src],video[poster],input[type=image][src],link[rel~=icon][href],link[rel=apple-touch-icon][href]').forEach((el) => add(el.getAttribute('src') || el.getAttribute('poster') || el.getAttribute('href')));
  document.querySelectorAll('img[srcset],source[srcset]').forEach((el) => addSrcset(el.getAttribute('srcset')));
  document.querySelectorAll('[data-src],[data-lazy-src],[data-original],[data-bg],[data-background]').forEach((el) => ['data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background'].forEach((a) => el.getAttribute(a) && add(el.getAttribute(a))));
  document.querySelectorAll('[data-srcset]').forEach((el) => addSrcset(el.getAttribute('data-srcset')));
  document.querySelectorAll('[style*="url("]').forEach((el) => { for (const m of el.getAttribute('style').matchAll(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g)) add(m[2]); });
  const visit = (sheet, depth) => {
    if (!sheet || depth > 6) return;
    let rules; try { rules = sheet.cssRules; } catch { return; }
    const base = sheet.href || document.baseURI;
    for (const r of rules) {
      if (r.styleSheet) visit(r.styleSheet, depth + 1);
      if (r.cssRules) visit({ cssRules: r.cssRules, href: sheet.href }, depth + 1);
      const text = r.style ? r.style.cssText : '';
      for (const m of text.matchAll(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g)) if (!m[2].startsWith('data:')) add(m[2], base);
    }
  };
  for (const s of document.styleSheets) visit(s, 0);
  return [...out];
})()`;

const FETCH_ASSETS_SCRIPT = (urls) => `(async () => {
  const urls = ${JSON.stringify(urls)};
  const res = await Promise.allSettled(urls.map((u) => {
    const same = new URL(u).origin === location.origin;
    return fetch(u, same ? { credentials: 'same-origin', cache: 'no-store' } : { mode: 'no-cors', credentials: 'omit', cache: 'no-store' });
  }));
  return res.filter((r) => r.status === 'fulfilled').length;
})()`;

// Serialise the rendered DOM. CSS-in-JS rules inserted through CSSOM (empty <style> text) and
// adopted stylesheets are materialised so the rendered snapshot keeps its styling.
const RENDERED_DOM_SCRIPT = `(() => {
  const clone = document.documentElement.cloneNode(true);
  const live = [...document.querySelectorAll('style')];
  const copies = [...clone.querySelectorAll('style')];
  let materialised = 0;
  live.forEach((s, i) => {
    try {
      const rules = s.sheet && s.sheet.cssRules ? [...s.sheet.cssRules].map((r) => r.cssText).join('\\n') : null;
      if (rules && copies[i] && rules.trim().length > (s.textContent || '').trim().length) {
        copies[i].textContent = rules;
        copies[i].setAttribute('data-sar-cssom', '');
        materialised++;
      }
    } catch {}
  });
  try {
    const adopted = document.adoptedStyleSheets || [];
    for (const sheet of adopted) {
      const st = document.createElement('style');
      st.setAttribute('data-sar-adopted', '');
      st.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\\n');
      clone.querySelector('head')?.appendChild(st);
      materialised++;
    }
  } catch {}
  const dt = document.doctype;
  const doctype = dt ? '<!DOCTYPE ' + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '') + (dt.systemId ? ' "' + dt.systemId + '"' : '') + '>' : '';
  return { html: doctype + '\\n' + clone.outerHTML, materialised };
})()`;

async function screenshot(cdp, viewport, maxHeight) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
  await sleep(600);
  const height = await cdp.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)');
  const clipHeight = Math.min(Math.max(viewport.height, height || viewport.height), maxHeight);
  const shot = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: viewport.width, height: clipHeight, scale: 1 } },
    60_000
  );
  const bin = atob(shot.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: 'image/png' }), width: viewport.width, height: clipHeight, fullHeight: height, truncated: height > maxHeight };
}

/**
 * @returns {Promise<{ zip: Blob, meta: object }>}
 */
export async function capturePage({ url, pageId, windowId, options, signal, onProgress = () => {} }) {
  const started = Date.now();
  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
  const cdp = new CdpSession(tab.id);
  let recorder = null;
  const warnings = [];
  const checkCancel = () => {
    if (signal?.aborted) throw new CaptureError('CANCELLED', 'capture cancelled');
  };
  try {
    await cdp.attach();
    recorder = new NetworkRecorder(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable', { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: Math.min(options.maxResourceBytes, 100_000_000) });
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    const d = VIEWPORTS.desktop;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: false });
    checkCancel();

    onProgress('loading');
    const loadEvent = cdp.waitFor('Page.loadEventFired', () => true, options.pageLoadTimeoutMs);
    loadEvent.catch(() => {});
    const nav = await cdp.send('Page.navigate', { url }, options.pageLoadTimeoutMs);
    if (nav.errorText) {
      throw new CaptureError('NAVIGATION_FAILED', nav.errorText, { retryable: !/ERR_NAME_NOT_RESOLVED|ERR_BLOCKED|ERR_UNSAFE/.test(nav.errorText) });
    }
    let loadTimedOut = false;
    try {
      await loadEvent;
    } catch {
      loadTimedOut = true;
      warnings.push(`load event not fired within ${options.pageLoadTimeoutMs}ms; captured partially loaded page`);
      await cdp.send('Page.stopLoading').catch(() => {});
    }
    await recorder.waitForIdle(options.networkIdleMs, Math.min(10_000, options.pageLoadTimeoutMs));
    checkCancel();

    // Main document response and redirect chain.
    const docs = [...recorder.records.values()].filter((r) => r.resourceType === 'Document' && r.frameId === nav.frameId && r.loaderId === nav.loaderId);
    const doc = docs[docs.length - 1];
    if (!doc || doc.status === undefined) {
      throw new CaptureError(loadTimedOut ? 'TIMEOUT' : 'NO_DOCUMENT', 'main document response was not received', { retryable: true });
    }
    const httpStatus = doc.status;
    const finalUrl = doc.finalUrl || doc.url;

    if (httpStatus === 401 || httpStatus === 403) {
      throw new CaptureError('INACCESSIBLE', `HTTP ${httpStatus}: access controlled page was not captured`, { partial: { httpStatus, finalUrl, redirects: doc.redirects } });
    }
    if (httpStatus >= 400) {
      throw new CaptureError('HTTP_ERROR', `HTTP ${httpStatus}`, { retryable: httpStatus >= 500, partial: { httpStatus, finalUrl, redirects: doc.redirects } });
    }

    onProgress('scrolling');
    let scroll = { steps: 0, eagerised: 0, stillMissing: [] };
    if (options.maxScrollSteps > 0) {
      try {
        scroll = await cdp.evaluate(SCROLL_SCRIPT(options.maxScrollSteps, options.scrollDelayMs), { timeoutMs: options.maxScrollSteps * options.scrollDelayMs + 15_000 });
      } catch (e) {
        warnings.push('scrolling failed: ' + e.message);
      }
      await recorder.waitForIdle(options.networkIdleMs, 8_000);
    }
    checkCancel();

    const recipes = [];
    for (const recipe of options.interactionRecipes) {
      if (recipe.urlPattern && !new RegExp(recipe.urlPattern).test(finalUrl)) continue;
      try {
        const result = await cdp.evaluate(RECIPE_SCRIPT(recipe), { timeoutMs: recipe.waitMs + 10_000 });
        recipes.push({ ...recipe, ...result });
      } catch (e) {
        recipes.push({ ...recipe, ok: false, reason: e.message });
      }
    }
    if (recipes.length) await recorder.waitForIdle(options.networkIdleMs, 5_000);

    const info = await cdp.evaluate(PAGE_INFO_SCRIPT);
    if (info.passwordInputs > 0) warnings.push('page contains a password field (possible login wall); only publicly delivered content was captured');

    onProgress('snapshot');
    let originalHtml = null;
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: doc.requestId });
      originalHtml = body.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body.body), (c) => c.charCodeAt(0))) : body.body;
    } catch (e) {
      warnings.push('original document body unavailable: ' + e.message);
    }

    const shots = {};
    if (options.screenshots) {
      onProgress('screenshots');
      try {
        shots.desktop = await screenshot(cdp, VIEWPORTS.desktop, options.maxScreenshotHeight);
        if (options.mobileScreenshots) {
          shots.mobile = await screenshot(cdp, VIEWPORTS.mobile, options.maxScreenshotHeight);
          await recorder.waitForIdle(options.networkIdleMs, 5_000); // responsive images loaded for mobile
        }
      } catch (e) {
        warnings.push('screenshot failed: ' + e.message);
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await sleep(300);
    }
    const rendered = await cdp.evaluate(RENDERED_DOM_SCRIPT);
    checkCancel();

    // Completion pass: fetch referenced-but-unloaded assets through the page so they are recorded
    // by the network recorder and collected by the Save All Resources logic like any other request.
    onProgress('completing');
    const completionUrls = new Set();
    try {
      const referenced = await cdp.evaluate(REFERENCED_ASSETS_SCRIPT);
      const loaded = new Set([...recorder.records.values()].map((r) => r.url));
      const missing = referenced.filter((u) => !loaded.has(u) && !STREAM_URL.test(u)).slice(0, 300);
      missing.forEach((u) => completionUrls.add(u));
      if (missing.length) {
        await cdp.evaluate(FETCH_ASSETS_SCRIPT(missing), { timeoutMs: 60_000 });
        await recorder.waitForIdle(options.networkIdleMs, 15_000);
      }
    } catch (e) {
      warnings.push('asset completion pass failed: ' + e.message);
    }

    onProgress('collecting');
    const skippedApi = [];
    // Frame-tree (static) resources carry no HTTP status; use the network log so error bodies
    // (404 pages served for images, etc.) are not saved as if they were the asset.
    const statusByUrl = new Map();
    for (const r of recorder.records.values()) if (r.status !== undefined && !statusByUrl.has(r.url)) statusByUrl.set(r.url, r.status);
    for (const r of recorder.records.values()) if (r.status !== undefined && r.status < 400) statusByUrl.set(r.url, r.status);
    const filter = (resUrl, meta) => {
      const type = meta.resourceType || meta.type;
      if (meta.failed) return { include: false, reason: 'load-failed' };
      const httpStatus = meta.status ?? statusByUrl.get(resUrl);
      if (httpStatus >= 400) return { include: false, reason: `http-${httpStatus}` };
      if (API_TYPES.has(type) && !options.includeApiResponses && !completionUrls.has(resUrl)) {
        skippedApi.push(resUrl);
        return { include: false, reason: 'operational-request' };
      }
      if (STREAM_URL.test(resUrl)) return { include: false, reason: 'streaming-media' };
      const size = meta.size || 0;
      const isMedia = type === 'Media' || MEDIA_MIME.test(meta.mimeType || '');
      if (isMedia && size > options.maxMediaBytes) return { include: false, reason: 'media-too-large' };
      if (size > options.maxResourceBytes) return { include: false, reason: 'resource-too-large' };
      if (meta.status >= 400) return { include: false, reason: `http-${meta.status}` };
      return { include: true };
    };
    const { toDownload, skipped, timedOut } = await collectWithSar(cdp, recorder.completed(), filter);
    if (timedOut) warnings.push('some resource bodies did not resolve before the collection timeout');

    const records = [...recorder.records.values()];
    const meta = {
      pageId,
      requestedUrl: redactUrl(url),
      finalUrl: redactUrl(finalUrl),
      httpStatus,
      redirects: doc.redirects.map((r) => ({ url: redactUrl(r.url), status: r.status })),
      title: info.title,
      lang: info.lang,
      canonical: info.canonical && redactUrl(info.canonical),
      links: info.links.map((l) => ({ ...l, href: redactUrl(l.href) })),
      forms: info.forms,
      iframes: info.iframes.map((f) => ({ ...f, src: redactUrl(f.src) })),
      unsupported: {
        shadowHosts: info.shadowHosts,
        canvases: info.canvases,
        serviceWorkerControlled: info.serviceWorkerControlled,
        crossOriginFrames: info.iframes.filter((f) => f.crossOrigin).length,
      },
      passwordInputs: info.passwordInputs,
      scroll,
      recipes,
      cssomStylesMaterialised: rendered.materialised,
      renderedHash: shortHash(rendered.html.replace(/\s+/g, ' '), 14),
      loadTimedOut,
      warnings,
      timings: { startedAt: started, durationMs: Date.now() - started },
      bytesTransferred: recorder.totalBytes,
      requests: records.map((r) => ({
        url: redactUrl(r.url),
        method: r.method,
        resourceType: r.resourceType,
        status: r.status ?? null,
        mimeType: r.mimeType ?? null,
        size: r.size ?? null,
        error: r.error ?? null,
        blockedReason: r.blockedReason ?? null,
        redirects: r.redirects.map((x) => ({ url: redactUrl(x.url), status: x.status })),
      })),
      failedRequests: dedupeFailures(
        recorder.failed
          .map((f) => ({ ...f, url: redactUrl(f.url), completion: completionUrls.has(f.url) }))
          .concat(records.filter((r) => r.status >= 400).map((r) => ({ url: redactUrl(r.url), type: r.resourceType, error: `HTTP ${r.status}`, completion: completionUrls.has(r.url) })))
      ),
      completionFetched: completionUrls.size,
      operationalRequests: [...new Set(skippedApi.map(redactUrl))],
      skippedResources: skipped.map((s) => ({ ...s, url: redactUrl(s.url) })),
      resources: toDownload.map((t) => ({
        url: redactUrl(t.url),
        path: t.saveAs.path,
        type: t.type || null,
        source: t.source,
        encoding: t.encoding || null,
        hasContent: !!t.content,
        failed: !!t.failed,
      })),
      screenshots: Object.fromEntries(
        Object.entries(shots).map(([k, s]) => [k, { path: `_capture/screenshots/${k}.png`, width: s.width, height: s.height, fullHeight: s.fullHeight, truncated: s.truncated }])
      ),
      captureEngine: 'save-all-resources@2.0.6 collector via chrome.debugger',
    };

    const extra = [
      { path: '_capture/page.json', text: JSON.stringify(meta, null, 2) },
      { path: '_capture/document.rendered.html', text: rendered.html },
    ];
    if (originalHtml != null) extra.push({ path: '_capture/document.original.html', text: originalHtml });
    for (const [k, s] of Object.entries(shots)) extra.push({ path: `_capture/screenshots/${k}.png`, blob: s.blob });

    onProgress('packaging');
    const { blob, written } = await packageWithSar(toDownload, options, extra);
    meta.zipEntries = written.length;
    return { zip: blob, meta };
  } finally {
    recorder?.dispose();
    await cdp.detach();
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* already closed */
    }
  }
}

// Packaging stage: per-page Save All Resources zips -> raw-capture/ + versioned manifest.
// The extension's zips are preserved byte-for-byte; bodies are de-duplicated by sha256 while every
// URL keeps its own manifest mapping; query-string variants and path collisions get distinct paths.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

export const MANIFEST_VERSION = '1.0.0';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Normalise a zip/SAR path into a safe relative POSIX path (no traversal, no absolute paths). */
export function safeRelPath(p) {
  const parts = String(p)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 120));
  return parts.join('/') || '_unnamed';
}

function withSuffix(path, tag) {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${path.slice(0, slash + 1)}${name.slice(0, dot)}.${tag}${name.slice(dot)}` : `${path}.${tag}`;
}

function writeFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const EXT_TYPES = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', txt: 'text/plain', xml: 'application/xml',
};
export function typeFromPath(p) {
  return EXT_TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * @param {object} args
 * @param {string} args.jobDir data/jobs/<id>
 * @param {object} args.job server job record (includes capture result from the extension)
 * @param {string} args.outDir output root (raw-capture/ is created inside)
 */
export function packageCapture({ jobDir, job, outDir }) {
  const rawDir = join(outDir, 'raw-capture');
  mkdirSync(rawDir, { recursive: true });
  const capture = job.capture || {};
  const inventory = capture.pages || [];
  const resources = new Map(); // url -> entry
  const pathOwners = new Map(); // localPath -> url
  const bodies = new Map(); // sha -> localPath of the stored body
  const pages = [];
  const warnings = [];

  for (const inv of inventory) {
    const pageRecord = {
      id: inv.id,
      requestedUrl: inv.url,
      finalUrl: inv.finalUrl || null,
      status: inv.status,
      reason: inv.reason || null,
      httpStatus: inv.httpStatus ?? null,
      depth: inv.depth,
      discoveredVia: inv.via,
      aliasOf: inv.aliasOf || null,
      redirects: inv.redirects || [],
      title: inv.title || null,
      attempts: inv.attempts,
      captureWarnings: inv.warnings || [],
      uploaded: !!job.uploads?.[inv.id],
    };
    pages.push(pageRecord);
    const zipPath = join(jobDir, 'uploads', `${inv.id}.zip`);
    if (inv.status !== 'captured') continue;
    if (!existsSync(zipPath)) {
      pageRecord.status = 'capture_not_uploaded';
      pageRecord.reason = inv.uploadError || 'captured in the browser but the zip never reached the server';
      continue;
    }
    const zipBuf = readFileSync(zipPath);
    const keptZip = join(rawDir, 'sar-page-zips', `${inv.id}.zip`);
    mkdirSync(dirname(keptZip), { recursive: true });
    copyFileSync(zipPath, keptZip);
    pageRecord.sarZip = `raw-capture/sar-page-zips/${inv.id}.zip`;
    pageRecord.sarZipSha256 = sha256(zipBuf);

    let entries;
    try {
      entries = unzipSync(new Uint8Array(zipBuf));
    } catch (e) {
      pageRecord.status = 'corrupt_capture';
      pageRecord.reason = `zip could not be read: ${e.message}`;
      continue;
    }
    const metaBuf = entries['_capture/page.json'];
    if (!metaBuf) {
      pageRecord.status = 'corrupt_capture';
      pageRecord.reason = 'page.json missing from capture zip';
      continue;
    }
    const meta = JSON.parse(strFromU8(metaBuf));
    const pageDir = join(rawDir, 'pages', inv.id);
    writeFile(join(pageDir, 'page.json'), metaBuf);
    for (const name of ['document.original.html', 'document.rendered.html']) {
      if (entries[`_capture/${name}`]) writeFile(join(pageDir, name), entries[`_capture/${name}`]);
    }
    pageRecord.rawPath = `raw-capture/pages/${inv.id}/`;
    pageRecord.hasOriginalHtml = !!entries['_capture/document.original.html'];
    pageRecord.hasRenderedHtml = !!entries['_capture/document.rendered.html'];
    pageRecord.screenshots = {};
    for (const [kind, s] of Object.entries(meta.screenshots || {})) {
      const buf = entries[s.path];
      if (!buf) continue;
      writeFile(join(pageDir, 'screenshots', `${kind}.png`), buf);
      pageRecord.screenshots[kind] = { path: `raw-capture/pages/${inv.id}/screenshots/${kind}.png`, width: s.width, height: s.height, truncated: s.truncated };
    }
    Object.assign(pageRecord, {
      finalUrl: meta.finalUrl,
      title: meta.title,
      lang: meta.lang,
      canonical: meta.canonical,
      links: [...new Set(meta.links.map((l) => l.href))],
      forms: meta.forms,
      iframes: meta.iframes,
      unsupported: meta.unsupported,
      failedRequests: meta.failedRequests,
      operationalRequests: meta.operationalRequests,
      skippedResources: meta.skippedResources,
      lazyLoad: meta.scroll,
      interactionRecipes: meta.recipes,
      loadTimedOut: meta.loadTimedOut,
      cssomStylesMaterialised: meta.cssomStylesMaterialised,
    });

    const requestByUrl = new Map(meta.requests.map((r) => [r.url, r]));
    for (const res of meta.resources) {
      const buf = entries[res.path];
      if (!buf || !buf.length) {
        if (!resources.has(res.url)) resources.set(res.url, { url: res.url, localPath: null, contentType: null, size: 0, sha256: null, pages: [inv.id], status: 'no-content' });
        continue;
      }
      const hash = sha256(buf);
      const req = requestByUrl.get(res.url);
      const contentType = req?.mimeType || typeFromPath(res.path);
      const existing = resources.get(res.url);
      if (existing && existing.sha256 === hash) {
        if (!existing.pages.includes(inv.id)) existing.pages.push(inv.id);
        continue;
      }
      let localPath = safeRelPath(res.path);
      if (existing) {
        // Same URL, different body on another page (dynamic resource): keep as a variant.
        localPath = withSuffix(localPath, `v${hash.slice(0, 8)}`);
      } else if (pathOwners.has(localPath) && pathOwners.get(localPath) !== res.url) {
        localPath = withSuffix(localPath, `c${hash.slice(0, 8)}`);
      }
      pathOwners.set(localPath, res.url);
      let dedupedTo = null;
      if (bodies.has(hash)) dedupedTo = bodies.get(hash);
      else {
        bodies.set(hash, localPath);
        writeFile(join(rawDir, 'resources', localPath), buf);
      }
      const entry = {
        url: res.url,
        localPath: `raw-capture/resources/${dedupedTo || localPath}`,
        logicalPath: localPath,
        dedupedTo: dedupedTo ? `raw-capture/resources/${dedupedTo}` : null,
        contentType,
        resourceType: req?.resourceType || res.type || null,
        size: buf.length,
        sha256: hash,
        pages: [inv.id],
        status: 'captured',
      };
      if (existing) {
        existing.variants = existing.variants || [];
        existing.variants.push({ ...entry, pages: [inv.id] });
      } else resources.set(res.url, entry);
    }
  }

  const allFailed = pages.flatMap((p) => (p.failedRequests || []).map((f) => ({ page: p.id, ...f })));
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: 'sar-website-template',
    jobId: job.jobId,
    createdAt: new Date().toISOString(),
    entryUrl: job.url,
    captureOptions: job.options,
    capture: {
      engine: 'Save All Resources 2.0.6 collector (automation build, chrome.debugger)',
      status: capture.status || null,
      startedAt: capture.startedAt || null,
      finishedAt: capture.finishedAt || null,
      limits: capture.limits || { reached: [], remainingUrls: [] },
      discovery: capture.discovery || null,
      discoveryComplete: capture.discoveryComplete ?? null,
      skippedUrls: capture.skippedUrls || [],
      errors: capture.errors || [],
    },
    pages,
    resources: [...resources.values()].sort((a, b) => a.url.localeCompare(b.url)),
    redirects: pages.filter((p) => p.redirects?.length).map((p) => ({ page: p.id, chain: p.redirects, finalUrl: p.finalUrl })),
    failedRequests: allFailed,
    missingDependencies: [],
    privacy: {
      cookiesExported: false,
      requestHeadersExported: false,
      responseHeadersExported: ['content-type (as mimeType)'],
      sensitiveQueryParamsRedacted: true,
    },
    processing: {},
    verification: null,
  };
  return { rawDir, manifest, warnings };
}

export function readRawPage(outDir, pageId) {
  const dir = join(outDir, 'raw-capture/pages', pageId);
  const read = (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : null);
  return { meta: JSON.parse(read('page.json')), rendered: read('document.rendered.html'), original: read('document.original.html') };
}

export { posix };

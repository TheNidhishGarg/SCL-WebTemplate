// Import stage for a plain Save All Resources download (the Chrome Web Store build's
// "Save All Resources" button) -> raw-capture/ + versioned manifest, in the same shape as
// packageCapture() produces for automation-build captures, so templatising, verification,
// reports and export run unchanged.
//
// Such a download is only the resource tree: one folder per host (SAR's resolveURLToPath:
// "<host>/<path>", query strings dropped, an extension added to extension-less names), plus
// "_DataURI/". It has no URL list, no rendered DOM and no screenshots, so:
//   * the entry host is the --entry-url host, the host named by the ZIP file, or the host
//     folder with the most HTML files; the scheme is https unless --entry-url says otherwise;
//   * every HTML file of the entry host becomes a page (its saved HTML is the template source);
//   * resource URLs are rebuilt from paths, and the resolver also matches references by SAR's
//     path rule (manifest.capture.importedFrom), because the query string is not recoverable.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import * as cheerio from 'cheerio';
import { pageIdForUrl } from '../../extension/src/shared/url-scope.js';
import { MANIFEST_VERSION, typeFromPath } from './package.mjs';

export const IMPORTED_FROM = 'save-all-resources-download';
export const MAX_IMPORT_PAGES = 500;
const MAX_FILES = 20000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const HTML = /\.html?$/i;
// Host folders as SAR writes them (host with ':' removed): names, IPv4, localhost(+port), punycode.
const HOST_DIR = /^(?:(?:[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?\.)+[a-z0-9-]{2,63}\d{0,5}|localhost\d{0,5}|\d{1,3}(?:\.\d{1,3}){3}\d{0,5})$/i;
const SPECIAL_DIR = /^(_DataURI|[a-z][a-z0-9+.-]*---.*)$/i; // data URIs, webpack:// ng:// …

export class ImportError extends Error {}

function safeEntryName(name) {
  const p = name.replace(/\\/g, '/');
  if (p.endsWith('/') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) return null;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** Host folders (and their HTML counts) if `paths` look like a SAR resource tree, else null. */
function hostLayout(paths) {
  const hosts = new Map();
  let inTree = 0;
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash === -1) continue;
    const top = p.slice(0, slash);
    if (SPECIAL_DIR.test(top)) inTree++;
    else if (HOST_DIR.test(top)) {
      inTree++;
      const h = hosts.get(top) || { html: 0, files: 0, hasIndex: false };
      h.files++;
      if (HTML.test(p)) h.html++;
      if (p === `${top}/index.html`) h.hasIndex = true;
      hosts.set(top, h);
    }
  }
  const withHtml = [...hosts.values()].some((h) => h.html > 0);
  return withHtml && inTree >= paths.length * 0.9 ? hosts : null;
}

const hostDirOf = (url) => new URL(url).host.replace(/:/g, '');

/**
 * Reads a plain SAR download and decides its layout. Throws ImportError with a message meant for
 * the person who uploaded it.
 */
export function readPlainDownload(zipBuf, { zipName = '', entryUrl = null } = {}) {
  let names = [];
  let total = 0;
  let entries;
  try {
    entries = unzipSync(new Uint8Array(zipBuf), {
      filter: (f) => {
        const p = safeEntryName(f.name);
        if (!p || JUNK.test(p)) return false;
        if (names.length >= MAX_FILES) throw new ImportError(`The download has more than ${MAX_FILES} files.`);
        total += f.originalSize;
        if (total > MAX_TOTAL_BYTES) throw new ImportError('The download expands to more than 1 GB.');
        names.push(p);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`Not a readable ZIP archive (${e.message}).`);
  }
  if (names.includes('manifest.json') || names.some((n) => /^[^/]+\/manifest\.json$/.test(n) && names.includes(n.replace(/manifest\.json$/, 'raw-capture/manifest.json')))) {
    throw new ImportError('This is already a website-template export (it has a manifest.json); import it as it is.');
  }

  // A download re-zipped after extracting it gains one wrapper folder.
  let prefix = '';
  let hosts = null;
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1) {
    const only = `${[...tops][0]}/`;
    if (names.every((n) => n.startsWith(only))) {
      hosts = hostLayout(names.map((n) => n.slice(only.length)));
      if (hosts) prefix = only;
    }
  }
  hosts ??= hostLayout(names);
  if (!hosts) {
    throw new ImportError(
      'This ZIP does not look like a Save All Resources download: expected one folder per website host (for example "www.example.com/index.html") with at least one HTML page.',
    );
  }

  let entryHost = null;
  let scheme = 'https:';
  if (entryUrl) {
    const u = new URL(entryUrl);
    if (!/^https?:$/.test(u.protocol)) throw new ImportError('The entry URL must use http or https.');
    scheme = u.protocol;
    entryHost = hostDirOf(entryUrl);
    if (!hosts.has(entryHost)) throw new ImportError(`The download has no folder for ${u.host}. Folders found: ${[...hosts.keys()].slice(0, 10).join(', ')}.`);
  } else {
    // SAR names the file after the page's hostname (non [A-Za-z0-9.] -> "_"); browsers may add " (1)".
    const hinted = zipName.replace(/^.*[\\/]/, '').replace(/\s*\(\d+\)(?=\.zip$)/i, '').replace(/\.zip$/i, '');
    entryHost = [...hosts.keys()].find((h) => h === hinted || h.replace(/[^A-Za-z0-9.]/g, '_') === hinted && hosts.get(h).html > 0) ?? null;
    if (!entryHost || !hosts.get(entryHost).html) {
      entryHost = [...hosts.entries()].sort((a, b) => b[1].html - a[1].html || Number(b[1].hasIndex) - Number(a[1].hasIndex) || a[0].localeCompare(b[0]))[0][0];
    }
  }

  const files = new Map(); // path relative to the tree -> bytes
  for (const n of names) files.set(n.slice(prefix.length), entries[n]);
  const pagePaths = [...files.keys()].filter((p) => p.startsWith(`${entryHost}/`) && HTML.test(p)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  if (!pagePaths.length) throw new ImportError(`The download has no HTML page for ${entryHost}.`);

  // SAR drops the ':' of a port from the folder name; only --entry-url can restore it.
  const entryAuthority = entryUrl ? new URL(entryUrl).host : entryHost;
  const urlOf = (path) => {
    const [host, ...rest] = path.split('/');
    const tail = rest.join('/').replace(/(^|\/)index\.html?$/i, '$1');
    const origin = host === entryHost ? `${scheme}//${entryAuthority}` : `https://${host}`;
    // Each segment is percent-encoded; SAR decoded them when it wrote the file.
    return `${origin}/${tail.split('/').map(encodeURIComponent).join('/')}`;
  };
  const home = pagePaths.find((p) => /^[^/]+\/index\.html?$/i.test(p)) ?? pagePaths[0];
  return {
    files,
    entryHost,
    entryUrl: entryUrl ? new URL(entryUrl).toString() : urlOf(home),
    pagePaths: pagePaths.slice(0, MAX_IMPORT_PAGES),
    skippedPages: pagePaths.slice(MAX_IMPORT_PAGES),
    hosts: [...hosts.keys()],
    urlOf,
  };
}

const depth = (p) => p.split('/').length;

function writeFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/**
 * Packager with packageCapture()'s contract, for a job whose download is at
 * <jobDir>/import/download.zip (job.import holds its original file name and entry URL).
 */
export function packagePlainDownload({ jobDir, job, outDir }) {
  const zipBuf = readFileSync(join(jobDir, 'import', 'download.zip'));
  const dl = readPlainDownload(zipBuf, { zipName: job.import?.fileName, entryUrl: job.import?.entryUrl ?? null });
  const rawDir = join(outDir, 'raw-capture');
  mkdirSync(rawDir, { recursive: true });
  const warnings = [];
  const keptZip = join(rawDir, 'sar-download.zip');
  writeFileSync(keptZip, zipBuf);

  // Resources: every file, bodies de-duplicated by sha256; logicalPath is the SAR path.
  const resources = [];
  const bodies = new Map();
  for (const [path, buf] of dl.files) {
    if (path.startsWith('_DataURI/') || !buf.length) continue; // data URIs stay inline in the pages
    const top = path.split('/')[0];
    if (SPECIAL_DIR.test(top)) continue; // webpack:// and similar: source maps' sources, not site files
    const hash = sha256(buf);
    let stored = bodies.get(hash);
    if (!stored) {
      stored = path;
      bodies.set(hash, path);
      writeFile(join(rawDir, 'resources', path), buf);
    }
    resources.push({
      url: dl.urlOf(path),
      localPath: `raw-capture/resources/${stored}`,
      logicalPath: path,
      sarPath: path,
      dedupedTo: stored !== path ? `raw-capture/resources/${stored}` : null,
      contentType: typeFromPath(path),
      resourceType: null,
      size: buf.length,
      sha256: hash,
      pages: [],
      status: 'captured',
    });
  }

  const taken = new Set();
  const pages = [];
  for (const path of dl.pagePaths) {
    const url = dl.urlOf(path);
    const id = pageIdForUrl(url, taken);
    taken.add(id);
    const html = dl.files.get(path);
    const pageDir = join(rawDir, 'pages', id);
    writeFile(join(pageDir, 'document.original.html'), html);
    let $;
    try {
      $ = cheerio.load(strFromU8(html));
    } catch (e) {
      pages.push({ id, requestedUrl: url, finalUrl: url, status: 'corrupt_capture', reason: `HTML could not be parsed: ${e.message}` });
      continue;
    }
    const abs = (v) => {
      try {
        return new URL(v.trim(), url).href;
      } catch {
        return null;
      }
    };
    const meta = {
      id,
      requestedUrl: url,
      finalUrl: url,
      status: 'captured',
      reason: null,
      httpStatus: null,
      depth: depth(path) - 2,
      discoveredVia: 'download',
      aliasOf: null,
      redirects: [],
      title: $('title').first().text().trim() || null,
      attempts: null,
      captureWarnings: ['Imported from a Save All Resources download: no rendered DOM, screenshots or request list were recorded.'],
      uploaded: false,
      sarPath: path,
      rawPath: `raw-capture/pages/${id}/`,
      hasOriginalHtml: true,
      hasRenderedHtml: false,
      screenshots: {},
      lang: $('html').attr('lang') || null,
      canonical: abs($('link[rel="canonical"]').attr('href') || '') || null,
      links: [...new Set($('a[href]').map((_, a) => abs($(a).attr('href'))).get().filter(Boolean))],
      forms: $('form').map((i, f) => ({ index: i, action: $(f).attr('action') || null, method: ($(f).attr('method') || 'get').toLowerCase() })).get(),
      iframes: $('iframe[src]').map((_, f) => abs($(f).attr('src'))).get().filter(Boolean),
      unsupported: [],
      failedRequests: [],
      operationalRequests: [],
      skippedResources: [],
    };
    writeFile(join(pageDir, 'page.json'), JSON.stringify(meta, null, 2));
    pages.push(meta);
  }
  for (const path of dl.skippedPages) {
    const url = dl.urlOf(path);
    pages.push({ id: pageIdForUrl(url, taken), requestedUrl: url, finalUrl: url, status: 'skipped', reason: `beyond the ${MAX_IMPORT_PAGES}-page import limit` });
  }
  if (dl.skippedPages.length) warnings.push(`${dl.skippedPages.length} HTML files beyond the ${MAX_IMPORT_PAGES}-page limit were not imported as pages.`);

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: 'sar-website-template',
    jobId: job.jobId,
    createdAt: new Date().toISOString(),
    entryUrl: dl.entryUrl,
    captureOptions: job.options,
    capture: {
      engine: 'Save All Resources download (Chrome Web Store build), imported',
      importedFrom: IMPORTED_FROM,
      sourceFile: job.import?.fileName || null,
      status: 'completed',
      startedAt: job.createdAt || null,
      finishedAt: job.createdAt || null,
      limits: { reached: dl.skippedPages.length ? ['maxImportPages'] : [], remainingUrls: dl.skippedPages.map(dl.urlOf) },
      discovery: { hosts: dl.hosts, entryHost: dl.entryHost },
      discoveryComplete: null,
      skippedUrls: [],
      errors: [],
    },
    pages,
    resources: resources.sort((a, b) => a.url.localeCompare(b.url)),
    redirects: [],
    failedRequests: [],
    missingDependencies: [],
    privacy: {
      cookiesExported: false,
      requestHeadersExported: false,
      responseHeadersExported: [],
      sensitiveQueryParamsRedacted: true,
    },
    processing: {},
    verification: null,
  };
  return { rawDir, manifest, warnings };
}

// Reconstruction stage: rewrite captured references to local assets and routes.
// HTML is handled with cheerio (parse5), CSS with postcss, srcset with a spec parser.
// JavaScript is copied unchanged and only scanned to report dependencies.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { canonicalizeUrl, shortHash } from '../../extension/src/shared/url-scope.js';
import { parseCss, transformCss, parseSrcset, serializeSrcset } from './css.mjs';

export const TRACKER_SRC = [
  ['google-tag-manager', /googletagmanager\.com/i],
  ['google-analytics', /google-analytics\.com|\/gtag\/js|analytics\.js$/i],
  ['facebook-pixel', /connect\.facebook\.net|facebook\.com\/tr/i],
  ['hotjar', /hotjar\.com/i],
  ['segment', /cdn\.segment\.(com|io)/i],
  ['mixpanel', /mixpanel\.com/i],
  ['microsoft-clarity', /clarity\.ms/i],
  ['doubleclick', /doubleclick\.net|googlesyndication\.com|googleadservices\.com/i],
  ['linkedin-insight', /snap\.licdn\.com|px\.ads\.linkedin\.com/i],
  ['tiktok-pixel', /analytics\.tiktok\.com/i],
  ['twitter-pixel', /static\.ads-twitter\.com|analytics\.twitter\.com/i],
  ['plausible', /plausible\.io/i],
  ['matomo', /matomo|piwik/i],
  ['heap', /heapanalytics\.com/i],
  ['intercom', /widget\.intercom\.io/i],
];
const TRACKER_INLINE = [
  ['google-analytics', /\bgtag\s*\(|GoogleAnalyticsObject|dataLayer\.push|googletagmanager/],
  ['facebook-pixel', /\bfbq\s*\(/],
  ['hotjar', /\bhj\s*\(|_hjSettings/],
  ['matomo', /_paq\.push/],
  ['segment', /analytics\.load\(/],
  ['microsoft-clarity', /clarity\s*\(\s*["']set|www\.clarity\.ms/],
];

/** SAR's resolveURLToPath directory for a host: host with ':' removed. */
const sarHostDir = (url) => new URL(url).host.replace(/:/g, '');

export function createResolver({ manifest, pages, entryUrl, options }) {
  const entryHostDir = sarHostDir(entryUrl);
  const toTemplatePath = (logical) => {
    const [first, ...rest] = logical.split('/');
    if (first === entryHostDir) return `assets/site/${rest.join('/')}`;
    if (first === '_DataURI') return `assets/data/${rest.join('/')}`;
    return `assets/ext/${first}/${rest.join('/')}`;
  };
  const pageUrls = new Map(); // canonical url -> page
  for (const p of pages) {
    for (const u of [p.requestedUrl, p.finalUrl]) {
      const c = u && canonicalizeUrl(u, undefined, options);
      if (c && !pageUrls.has(c)) pageUrls.set(c, p);
    }
  }
  const bodyOwner = new Map(); // raw localPath -> template path of the stored body
  const assets = new Map(); // url (no fragment) -> { templatePath, resource }
  const variantsByPage = new Map(); // `${pageId} ${url}` -> templatePath
  for (const r of manifest.resources) {
    if (!r.logicalPath) continue;
    const c = canonicalizeUrl(r.url, undefined, { ...options, hashRoutes: false });
    if (c && pageUrls.has(c) && /html/.test(r.contentType || '')) continue; // pages are generated, not copied
    const storedLogical = (r.dedupedTo || r.localPath).replace(/^raw-capture\/resources\//, '');
    if (!bodyOwner.has(storedLogical)) bodyOwner.set(storedLogical, toTemplatePath(storedLogical));
    r.templatePath = bodyOwner.get(storedLogical);
    assets.set(r.url, { templatePath: r.templatePath, resource: r });
    for (const v of r.variants || []) {
      const vLogical = (v.dedupedTo || v.localPath).replace(/^raw-capture\/resources\//, '');
      if (!bodyOwner.has(vLogical)) bodyOwner.set(vLogical, toTemplatePath(vLogical));
      v.templatePath = bodyOwner.get(vLogical);
      for (const pid of v.pages) variantsByPage.set(`${pid} ${r.url}`, v.templatePath);
    }
  }

  return {
    bodyOwner,
    assets,
    /** Template path (relative to template root, no leading slash) for an absolute URL, or null. */
    asset(absUrl, pageId) {
      const noHash = absUrl.split('#')[0];
      const v = pageId && variantsByPage.get(`${pageId} ${noHash}`);
      if (v) return v;
      const hit = assets.get(noHash) || assets.get(decodeSafe(noHash));
      return hit ? hit.templatePath : null;
    },
    /** Page record (following aliases) for an absolute URL, or null. */
    page(absUrl) {
      const c = canonicalizeUrl(absUrl, undefined, options);
      if (!c) return null;
      let p = pageUrls.get(c);
      if (!p) {
        const u = new URL(c);
        u.pathname = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) || '/' : `${u.pathname}/`;
        p = pageUrls.get(u.toString());
      }
      while (p && p.aliasOf) p = pages.find((x) => x.id === p.aliasOf);
      return p || null;
    },
    inScope(absUrl) {
      try {
        return new URL(absUrl).origin === new URL(entryUrl).origin || (options.allowedOrigins || []).includes(new URL(absUrl).origin);
      } catch {
        return false;
      }
    },
  };
}

function decodeSafe(s) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** Route (output file path) for each templatised page, mirroring the original URL path. */
export function assignRoutes(pages) {
  const taken = new Set();
  for (const p of pages) {
    const u = new URL(p.finalUrl || p.requestedUrl);
    let path = decodeSafe(u.pathname).replace(/^\/+/, '');
    if (!path || path.endsWith('/')) path += 'index.html';
    else if (!/\.html?$/i.test(path)) path += '/index.html';
    path = path.replace(/[<>:"|?*\\]/g, '_');
    if (u.search || u.hash) path = path.replace(/(\.html?)$/i, `__q${shortHash(u.search + u.hash)}$1`);
    let route = path;
    let n = 2;
    while (taken.has(route.toLowerCase())) route = path.replace(/(\.html?)$/i, `-${n++}$1`);
    taken.add(route.toLowerCase());
    p.route = route;
  }
}

/** Copy captured asset bodies into template/assets; CSS files are rewritten. */
export function writeAssets({ outDir, templateDir, manifest, resolver, tokens, report, onTokenUse }) {
  const written = new Set();
  for (const r of manifest.resources) {
    if (!r.templatePath || written.has(r.templatePath)) continue;
    const write = (templatePath, rawLocal, url, contentType) => {
      if (written.has(templatePath)) return;
      written.add(templatePath);
      const src = join(outDir, rawLocal);
      const dest = join(templateDir, templatePath);
      mkdirSync(dirname(dest), { recursive: true });
      if (/css/.test(contentType || '') || templatePath.endsWith('.css')) {
        const css = readFileSync(src, 'utf8');
        const { root, error } = parseCss(css, url);
        if (!root) {
          report.cssParseErrors.push({ url, error });
          writeFileSync(dest, css);
          return;
        }
        transformCss(root, {
          baseUrl: url,
          resolve: (abs) => {
            const target = resolver.asset(abs);
            return target ? posix.relative(posix.dirname(templatePath), target) || posix.basename(target) : null;
          },
          tokens,
          onMissing: (abs) => report.missing.push({ from: url, url: abs, kind: 'css-reference' }),
          onTokenUse: (t) => onTokenUse?.(templatePath, t),
        });
        writeFileSync(dest, root.toString());
      } else {
        copyFileSync(src, dest);
        if (/javascript/.test(contentType || '') || /\.m?js$/.test(templatePath)) scanScript(readFileSync(src, 'utf8'), url, report);
      }
    };
    write(r.templatePath, r.dedupedTo || r.localPath, r.url, r.contentType);
    for (const v of r.variants || []) write(v.templatePath, v.dedupedTo || v.localPath, r.url, v.contentType);
  }
  return written;
}

export function scanScript(code, url, report) {
  const deps = [];
  if (/\bimport\s*\(/.test(code)) deps.push('dynamic-import');
  if (/serviceWorker\s*\.\s*register\s*\(/.test(code)) deps.push('service-worker');
  if (/\bfetch\s*\(|XMLHttpRequest|axios\.|\$\.ajax\(/.test(code)) deps.push('network-requests');
  if (/new\s+WebSocket\s*\(|new\s+EventSource\s*\(/.test(code)) deps.push('realtime-connection');
  if (/(from\s+|import\s*\()\s*["']\/(?!\/)/.test(code)) deps.push('root-absolute-module-imports');
  if (/\.m3u8|\.mpd|MediaSource/.test(code)) deps.push('streaming-media');
  for (const d of deps) report.scriptDependencies.push({ script: url, dependency: d });
}

function rewriteStyleText(text, { baseUrl, resolver, pageId, tokens, report, onTokenUse }) {
  const { root, error } = parseCss(text, baseUrl);
  if (!root) {
    report.cssParseErrors.push({ url: `${baseUrl} (inline)`, error });
    return text;
  }
  transformCss(root, {
    baseUrl,
    resolve: (abs) => {
      const t = resolver.asset(abs, pageId);
      return t ? `{{@root}}${t}` : null;
    },
    tokens,
    onMissing: (abs) => report.missing.push({ from: `${baseUrl} (inline style)`, url: abs, kind: 'css-reference' }),
    onTokenUse,
  });
  return root.toString();
}

function rewriteStyleAttr(value, ctx) {
  // Wrap declarations in a rule so postcss can parse them, then unwrap.
  const out = rewriteStyleText(`x{${value}}`, ctx);
  const m = out.match(/^x\s*\{([\s\S]*)\}\s*$/);
  return m ? m[1].trim() : value;
}

const ASSET_ATTRS = [
  ['script[src]', 'src'],
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['audio[src]', 'src'],
  ['track[src]', 'src'],
  ['embed[src]', 'src'],
  ['input[type=image][src]', 'src'],
  ['video[poster]', 'poster'],
  ['object[data]', 'data'],
];
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background'];

/**
 * Rewrite one page document in place.
 * @returns report fragment for the page
 */
export function rewriteDocument($, { page, resolver, tokens, report, onTokenUse }) {
  const pageId = page.id;
  let baseUrl = page.finalUrl || page.requestedUrl;
  const baseEl = $('base[href]').first();
  if (baseEl.length) {
    try {
      baseUrl = new URL(baseEl.attr('href'), baseUrl).href;
    } catch {
      /* invalid base: ignore */
    }
  }
  $('base').remove();
  const abs = (v) => {
    try {
      return new URL(v.trim(), baseUrl).href;
    } catch {
      return null;
    }
  };
  const pageReport = { removedTrackers: [], disabledForms: [], uncapturedLinks: [], externalFrames: [], removedHeadLinks: [] };
  const missing = (url, kind) => report.missing.push({ from: page.finalUrl, url, kind, page: pageId });
  const toAsset = (raw, kind) => {
    if (!raw || /^(data:|blob:|javascript:|about:|#|\{\{@)/i.test(raw.trim())) return null;
    const a = abs(raw);
    if (!a) return null;
    const t = resolver.asset(a, pageId);
    if (t) return `{{@root}}${t}${a.includes('#') ? '#' + a.split('#')[1] : ''}`;
    missing(a, kind);
    return a;
  };

  // Trackers (scripts, noscript pixels, tracking images).
  $('script').each((_, el) => {
    const s = $(el);
    const src = s.attr('src') || '';
    const inline = src ? '' : s.html() || '';
    const hit = (src && TRACKER_SRC.find(([, re]) => re.test(src))) || (!src && TRACKER_INLINE.find(([, re]) => re.test(inline)));
    if (hit) {
      pageReport.removedTrackers.push({ vendor: hit[0], src: src || '(inline)' });
      s.replaceWith(`<!-- template: removed ${hit[0]} ${src ? 'script' : 'inline snippet'}; see integrations.analytics in site.config.json -->`);
    }
  });
  $('noscript').each((_, el) => {
    const html = $(el).html() || '';
    const hit = TRACKER_SRC.find(([, re]) => re.test(html));
    if (hit) {
      pageReport.removedTrackers.push({ vendor: hit[0], src: '(noscript)' });
      $(el).remove();
    }
  });
  $('img[src]').each((_, el) => {
    const hit = TRACKER_SRC.find(([, re]) => re.test($(el).attr('src')));
    if (hit) {
      pageReport.removedTrackers.push({ vendor: hit[0], src: $(el).attr('src') });
      $(el).remove();
    }
  });

  // Head links.
  $('link[href]').each((_, el) => {
    const l = $(el);
    const rel = (l.attr('rel') || '').toLowerCase();
    if (/\b(canonical|alternate|preconnect|dns-prefetch|pingback|shortlink|edituri|wlwmanifest)\b/.test(rel)) {
      pageReport.removedHeadLinks.push({ rel, href: l.attr('href') });
      l.remove();
      return;
    }
    const a = abs(l.attr('href'));
    const t = a && resolver.asset(a, pageId);
    if (t) {
      l.attr('href', `{{@root}}${t}`);
      l.removeAttr('integrity');
    } else if (/\b(preload|prefetch|modulepreload|prerender|manifest)\b/.test(rel)) {
      pageReport.removedHeadLinks.push({ rel, href: a });
      l.remove();
    } else if (a) {
      missing(a, `link[rel=${rel}]`);
      l.attr('href', a);
    }
  });
  $('meta[http-equiv]').each((_, el) => {
    if (/content-security-policy|refresh/i.test($(el).attr('http-equiv'))) $(el).remove();
  });

  for (const [sel, attr] of ASSET_ATTRS) {
    $(sel).each((_, el) => {
      const v = toAsset($(el).attr(attr), `${sel}`);
      if (v) $(el).attr(attr, v);
      if (attr === 'src' && el.tagName === 'script') $(el).removeAttr('integrity');
    });
  }
  for (const [sel, attr] of [['img[srcset]', 'srcset'], ['source[srcset]', 'srcset'], ['[data-srcset]', 'data-srcset']]) {
    $(sel).each((_, el) => {
      const cands = parseSrcset($(el).attr(attr)).map((c) => ({ ...c, url: toAsset(c.url, 'srcset') || c.url }));
      $(el).attr(attr, serializeSrcset(cands));
    });
  }
  for (const attr of LAZY_ATTRS) {
    $(`[${attr}]`).each((_, el) => {
      const raw = $(el).attr(attr);
      const a = raw && abs(raw);
      const t = a && resolver.asset(a, pageId);
      if (t) $(el).attr(attr, `{{@root}}${t}`);
    });
  }
  $('use, image').each((_, el) => {
    for (const attr of ['href', 'xlink:href']) {
      const v = $(el).attr(attr);
      if (v && !v.startsWith('#')) {
        const r = toAsset(v, `svg ${attr}`);
        if (r) $(el).attr(attr, r);
      }
    }
  });
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    const a = abs($(el).attr('content') || '');
    const t = a && resolver.asset(a, pageId);
    if (t) $(el).attr('content', `{{@root}}${t}`);
  });

  // Inline CSS.
  const cssCtx = { baseUrl, resolver, pageId, tokens, report, onTokenUse };
  $('style').each((_, el) => {
    $(el).text(rewriteStyleText($(el).text(), cssCtx));
  });
  $('[style]').each((_, el) => {
    $(el).attr('style', rewriteStyleAttr($(el).attr('style'), cssCtx));
  });

  // Navigation.
  $('a[href], area[href]').each((_, el) => {
    const raw = $(el).attr('href').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|sms:|javascript:)/i.test(raw)) return;
    const a = abs(raw);
    if (!a || !/^https?:/.test(a)) return;
    const target = resolver.page(a);
    if (target && target.route) {
      const frag = a.includes('#') && !/#!?\//.test(a) ? '#' + a.split('#')[1] : '';
      $(el).attr('href', `{{@root}}${target.route}${frag}`);
      $(el).attr('data-sar-internal', '');
      return;
    }
    const asset = resolver.asset(a, pageId);
    if (asset) {
      $(el).attr('href', `{{@root}}${asset}`);
      return;
    }
    if (resolver.inScope(a)) {
      // In-scope page that was not captured (failed, skipped, limited): keep the site path so the
      // template never links back to the reference site; reported as an uncaptured target.
      pageReport.uncapturedLinks.push(a);
      const u = new URL(a);
      $(el).attr('href', u.pathname + u.search + u.hash);
      $(el).attr('data-sar-uncaptured', '');
      return;
    }
    $(el).attr('href', a);
  });

  // Frames.
  $('iframe[src]').each((_, el) => {
    const a = abs($(el).attr('src'));
    if (!a || !/^https?:/.test(a)) return;
    const target = resolver.page(a);
    if (target?.route) $(el).attr('src', `{{@root}}${target.route}`);
    else {
      const t = resolver.asset(a, pageId);
      if (t) $(el).attr('src', `{{@root}}${t}`);
      else {
        pageReport.externalFrames.push(a);
        $(el).attr('src', a);
      }
    }
  });

  // Forms: original endpoints are disconnected; build.mjs reconnects configured ones.
  let n = 0;
  $('form').each((_, el) => {
    const f = $(el);
    const id = `${pageId}-form-${++n}`;
    const action = f.attr('action');
    pageReport.disabledForms.push({ id, originalAction: action ? abs(action) : page.finalUrl, method: (f.attr('method') || 'get').toLowerCase() });
    f.removeAttr('action');
    f.removeAttr('method');
    f.removeAttr('target');
    f.attr('data-sar-form', id);
  });
  $('[formaction]').each((_, el) => $(el).removeAttr('formaction'));

  return pageReport;
}

// URL canonicalisation, crawl scope and crawl-trap protection.
// Pure module: used by the extension service worker and imported directly by Node tests.

export const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^dclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^_ga$/i,
  /^_gl$/i,
  /^yclid$/i,
  /^igshid$/i,
  /^ref_src$/i,
];

// Query parameter names whose values must never be written to manifests (credentials, signed URLs).
export const SENSITIVE_PARAMS = /^(token|access_token|id_token|auth|authorization|key|api_key|apikey|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|session|sessionid|sid|code|password|pass|secret|jwt)$/i;

// Links that must never be followed: they can change server state when requested with GET.
export const UNSAFE_PATH = /(^|[\/_.-])(log-?out|sign-?out|logoff|delete|remove|unsubscribe|cancel-?subscription|cart\/(add|remove)|add-to-cart|checkout|wp-admin|wp-login|admin)([\/_.?-]|$)/i;

const NON_PAGE_EXT = /\.(pdf|zip|rar|7z|gz|tar|dmg|exe|msi|apk|jpg|jpeg|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mkv|mp3|wav|ogg|flac|m4a|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?)$/i;

export const DEFAULT_SCOPE_OPTIONS = {
  allowedOrigins: [], // extra origins (e.g. https://www.example.com) to include besides the entry origin
  hashRoutes: true, // treat #/route and #!/route fragments as distinct client-side routes
  maxQueryParams: 3, // URLs with more (non-tracking) query params are treated as crawl traps
  maxQueryVariantsPerPath: 3, // distinct query strings allowed per path
  maxUrlsPerPattern: 25, // distinct URLs per numeric path pattern (e.g. /calendar/{n}/{n})
  maxUrlLength: 512,
};

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Canonicalise a URL for page de-duplication.
 * Returns null for URLs that can never be pages (mailto:, javascript:, data:, ...).
 * Distinct content is preserved: path case and trailing slashes are kept, non-tracking query
 * parameters are kept (sorted), and client-side hash routes are kept when enabled.
 */
export function canonicalizeUrl(input, base, options = {}) {
  const opts = { ...DEFAULT_SCOPE_OPTIONS, ...options };
  let u;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  // Normalise percent-encoding case without decoding reserved characters.
  u.pathname = u.pathname.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase()) || '/';

  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)));
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const search = new URLSearchParams(params).toString();
  u.search = search ? `?${search}` : '';

  const hash = u.hash;
  if (opts.hashRoutes && /^#!?\//.test(hash)) {
    u.hash = hash.replace(/^#!/, '#');
  } else {
    u.hash = '';
  }
  return u.toString();
}

/** Redact sensitive query parameter values so manifests never contain credentials. */
export function redactUrl(input) {
  try {
    const u = new URL(input);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.test(key)) {
        u.searchParams.set(key, 'REDACTED');
        changed = true;
      }
    }
    return changed || input.includes('@') ? u.toString() : input;
  } catch {
    return input;
  }
}

export function pathPattern(url) {
  const u = new URL(url);
  return (
    u.origin +
    u.pathname
      .split('/')
      .map((seg) => (/^\d+$/.test(seg) || /^\d{4}-\d{2}(-\d{2})?$/.test(seg) ? '{n}' : seg))
      .join('/')
  );
}

/**
 * Stateful scope + trap guard. `check(url)` returns { ok: true, url } or { ok: false, reason }.
 * `register(url)` must be called once a URL is accepted so per-pattern counters advance.
 */
export class CrawlScope {
  constructor(entryUrl, options = {}) {
    this.options = { ...DEFAULT_SCOPE_OPTIONS, ...options };
    const entry = canonicalizeUrl(entryUrl, undefined, this.options);
    if (!entry) throw new Error('Entry URL must be an absolute http(s) URL');
    this.entry = entry;
    this.origins = new Set([originOf(entry), ...(this.options.allowedOrigins || []).map(originOf).filter(Boolean)]);
    this.queryVariants = new Map(); // origin+path -> Set(search)
    this.patternCounts = new Map(); // pattern -> count
  }

  inScope(url) {
    return this.origins.has(originOf(url));
  }

  check(rawUrl, base) {
    const url = canonicalizeUrl(rawUrl, base, this.options);
    if (!url) return { ok: false, reason: 'not-http' };
    if (url.length > this.options.maxUrlLength) return { ok: false, reason: 'url-too-long', url };
    if (!this.inScope(url)) return { ok: false, reason: 'out-of-scope', url };
    const u = new URL(url);
    if (NON_PAGE_EXT.test(u.pathname)) return { ok: false, reason: 'not-a-page', url };
    if (UNSAFE_PATH.test(u.pathname + u.search)) return { ok: false, reason: 'unsafe-link', url };
    const paramCount = [...u.searchParams.keys()].length;
    if (paramCount > this.options.maxQueryParams) return { ok: false, reason: 'too-many-query-params', url };
    if (u.search) {
      const key = u.origin + u.pathname;
      const seen = this.queryVariants.get(key) || new Set();
      if (!seen.has(u.search) && seen.size >= this.options.maxQueryVariantsPerPath) {
        return { ok: false, reason: 'query-variant-limit', url };
      }
    }
    const pattern = pathPattern(url);
    if (pattern.includes('{n}') && (this.patternCounts.get(pattern) || 0) >= this.options.maxUrlsPerPattern) {
      return { ok: false, reason: 'pattern-limit', url };
    }
    return { ok: true, url };
  }

  register(url) {
    const u = new URL(url);
    if (u.search) {
      const key = u.origin + u.pathname;
      const seen = this.queryVariants.get(key) || new Set();
      seen.add(u.search);
      this.queryVariants.set(key, seen);
    }
    const pattern = pathPattern(url);
    if (pattern.includes('{n}')) this.patternCounts.set(pattern, (this.patternCounts.get(pattern) || 0) + 1);
  }

  toJSON() {
    return {
      entry: this.entry,
      origins: [...this.origins],
      queryVariants: [...this.queryVariants].map(([k, v]) => [k, [...v]]),
      patternCounts: [...this.patternCounts],
    };
  }

  static fromJSON(json, options) {
    const scope = new CrawlScope(json.entry, options);
    scope.queryVariants = new Map((json.queryVariants || []).map(([k, v]) => [k, new Set(v)]));
    scope.patternCounts = new Map(json.patternCounts || []);
    return scope;
  }
}

/** Stable, readable, collision-safe page id from a canonical URL. */
export function pageIdForUrl(url, taken = new Set()) {
  const u = new URL(url);
  let slug = decodeURIComponentSafe(u.pathname)
    .replace(/\/index\.html?$/i, '/')
    .replace(/\.html?$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) slug = 'home';
  if (u.search) slug += '-q' + shortHash(u.search);
  if (u.hash) slug += '-r' + shortHash(u.hash);
  let id = slug;
  let n = 2;
  while (taken.has(id)) id = `${slug}-${n++}`;
  return id;
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** cyrb53 -> 8 hex chars. Deterministic, synchronous, adequate for path disambiguation. */
export function shortHash(str, len = 8) {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0').slice(0, len);
}

/**
 * Save All Resources maps URLs to paths with its own resolveURLToPath(), which drops the query
 * string (so ?v=1 and ?v=2 collide). This adds a deterministic query/hash discriminator to a path
 * produced by resolveURLToPath without changing paths for query-less URLs.
 */
export function addQueryDiscriminator(path, url) {
  let search = '';
  try {
    search = new URL(url).search;
  } catch {
    return path;
  }
  if (!search) return path;
  const tag = `__q${shortHash(search)}`;
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${dir}${name.slice(0, dot)}.${tag}${name.slice(dot)}` : `${dir}${name}.${tag}`;
}

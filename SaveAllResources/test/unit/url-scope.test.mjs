import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeUrl, CrawlScope, pageIdForUrl, addQueryDiscriminator, redactUrl } from '../../extension/src/shared/url-scope.js';
import { parseSitemap, parseRobots, isAllowedByRobots } from '../../extension/src/shared/sitemap.js';

test('canonicalisation removes tracking params, sorts query, drops default port and plain fragments', () => {
  assert.equal(canonicalizeUrl('HTTP://Example.COM:80/a/b?z=1&utm_source=x&a=2#top'), 'http://example.com/a/b?a=2&z=1');
  assert.equal(canonicalizeUrl('https://example.com:443/'), 'https://example.com/');
  assert.equal(canonicalizeUrl('../c', 'https://example.com/a/b/'), 'https://example.com/a/c');
});

test('canonicalisation keeps distinct content: path case, trailing slash and hash routes', () => {
  assert.notEqual(canonicalizeUrl('https://e.com/About'), canonicalizeUrl('https://e.com/about'));
  assert.notEqual(canonicalizeUrl('https://e.com/about/'), canonicalizeUrl('https://e.com/about'));
  assert.equal(canonicalizeUrl('https://e.com/#/pricing'), 'https://e.com/#/pricing');
  assert.equal(canonicalizeUrl('https://e.com/#!/pricing'), 'https://e.com/#/pricing');
  assert.equal(canonicalizeUrl('https://e.com/#/pricing', undefined, { hashRoutes: false }), 'https://e.com/');
});

test('non-page schemes are rejected', () => {
  for (const u of ['mailto:a@b.c', 'tel:+1', 'javascript:void(0)', 'data:text/html,hi']) assert.equal(canonicalizeUrl(u), null);
});

test('scope: entry origin only unless configured', () => {
  const scope = new CrawlScope('https://example.com/', { allowedOrigins: ['https://docs.example.com'] });
  assert.equal(scope.check('https://other.com/').reason, 'out-of-scope');
  assert.equal(scope.check('https://www.example.com/').reason, 'out-of-scope');
  assert.ok(scope.check('https://docs.example.com/guide').ok);
  assert.ok(scope.check('/about', 'https://example.com/').ok);
});

test('scope: unsafe and non-page links are not followed', () => {
  const scope = new CrawlScope('https://example.com/');
  assert.equal(scope.check('https://example.com/logout').reason, 'unsafe-link');
  assert.equal(scope.check('https://example.com/account/sign-out?x=1').reason, 'unsafe-link');
  assert.equal(scope.check('https://example.com/cart/add?id=3').reason, 'unsafe-link');
  assert.equal(scope.check('https://example.com/brochure.pdf').reason, 'not-a-page');
});

test('crawl traps: query variants, parameter count and numeric path patterns are bounded', () => {
  const scope = new CrawlScope('https://e.com/', { maxQueryVariantsPerPath: 2, maxUrlsPerPattern: 3, maxQueryParams: 2 });
  for (const q of ['?page=1', '?page=2']) {
    const c = scope.check(`https://e.com/blog${q}`);
    assert.ok(c.ok);
    scope.register(c.url);
  }
  assert.equal(scope.check('https://e.com/blog?page=3').reason, 'query-variant-limit');
  assert.ok(scope.check('https://e.com/blog?page=1').ok, 'already-seen variant is still in scope');
  assert.equal(scope.check('https://e.com/s?a=1&b=2&c=3').reason, 'too-many-query-params');
  for (let m = 1; m <= 3; m++) {
    const c = scope.check(`https://e.com/calendar/2026/0${m}`);
    assert.ok(c.ok);
    scope.register(c.url);
  }
  assert.equal(scope.check('https://e.com/calendar/2026/04').reason, 'pattern-limit');
  const restored = CrawlScope.fromJSON(JSON.parse(JSON.stringify(scope.toJSON())), { maxUrlsPerPattern: 3 });
  assert.equal(restored.check('https://e.com/calendar/2026/05').reason, 'pattern-limit', 'state survives persistence');
});

test('page ids are readable, stable and collision-safe', () => {
  const taken = new Set();
  const a = pageIdForUrl('https://e.com/', taken);
  taken.add(a);
  const b = pageIdForUrl('https://e.com/About/Team.html', taken);
  taken.add(b);
  const c = pageIdForUrl('https://e.com/about/team', taken);
  assert.equal(a, 'home');
  assert.equal(b, 'about-team');
  assert.equal(c, 'about-team-2');
  assert.match(pageIdForUrl('https://e.com/blog?page=2'), /^blog-q[0-9a-f]{8}$/);
});

test('query-string variants of a resource get distinct, deterministic paths', () => {
  const p1 = addQueryDiscriminator('e.com/css/theme.css', 'https://e.com/css/theme.css?v=1');
  const p2 = addQueryDiscriminator('e.com/css/theme.css', 'https://e.com/css/theme.css?v=2');
  assert.notEqual(p1, p2);
  assert.match(p1, /^e\.com\/css\/theme\.__q[0-9a-f]{8}\.css$/);
  assert.equal(p1, addQueryDiscriminator('e.com/css/theme.css', 'https://e.com/css/theme.css?v=1'));
  assert.equal(addQueryDiscriminator('e.com/a.css', 'https://e.com/a.css'), 'e.com/a.css');
});

test('sensitive query values are redacted for manifests', () => {
  assert.equal(redactUrl('https://cdn.e.com/a.png?X-Amz-Signature=abc&w=2'), 'https://cdn.e.com/a.png?X-Amz-Signature=REDACTED&w=2');
  assert.equal(redactUrl('https://user:pw@e.com/x'), 'https://e.com/x');
  assert.equal(redactUrl('https://e.com/x?w=1'), 'https://e.com/x?w=1');
});

test('sitemap parser handles urlset, index, CDATA, entities and comments', () => {
  const xml = `<?xml version="1.0"?><!-- c --><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://e.com/a?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://e.com/b]]></loc></url>
    <url><loc>  https://e.com/c  </loc><lastmod>2026</lastmod></url></urlset>`;
  assert.deepEqual(parseSitemap(xml), { type: 'urlset', locs: ['https://e.com/a?x=1&y=2', 'https://e.com/b', 'https://e.com/c'] });
  const idx = parseSitemap('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(idx.type, 'sitemapindex');
  assert.deepEqual(idx.locs, ['https://e.com/s1.xml']);
  assert.equal(parseSitemap(xml, 1).locs.length, 1, 'bounded by maxUrls');
});

test('robots.txt: sitemaps, groups and longest-match allow/disallow', () => {
  const r = parseRobots('User-agent: other\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/press\nDisallow: /*.pdf$\nSitemap: https://e.com/sm.xml');
  assert.deepEqual(r.sitemaps, ['https://e.com/sm.xml']);
  assert.equal(isAllowedByRobots(r.rules, 'https://e.com/private/x'), false);
  assert.equal(isAllowedByRobots(r.rules, 'https://e.com/private/press/1'), true);
  assert.equal(isAllowedByRobots(r.rules, 'https://e.com/docs/a.pdf'), false);
  assert.equal(isAllowedByRobots(r.rules, 'https://e.com/docs/a.pdf?x'), true);
  assert.equal(isAllowedByRobots(r.rules, 'https://e.com/'), true);
});

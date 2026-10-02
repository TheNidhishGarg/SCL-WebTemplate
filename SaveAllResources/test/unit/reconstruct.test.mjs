import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { parseCss, transformCss, parseSrcset, serializeSrcset, normalizeColor, newStats, collectStats } from '../../app/processing/css.mjs';
import { createResolver, rewriteDocument, assignRoutes } from '../../app/processing/reconstruct.mjs';
import valueParser from 'postcss-value-parser';

const ORIGIN = 'https://e.com';
const res = (url, logical, contentType = 'image/png') => ({ url, logicalPath: logical, localPath: `raw-capture/resources/${logical}`, contentType, pages: ['home'] });

function fixture() {
  const pages = [
    { id: 'home', requestedUrl: `${ORIGIN}/`, finalUrl: `${ORIGIN}/`, status: 'captured' },
    { id: 'about', requestedUrl: `${ORIGIN}/about/`, finalUrl: `${ORIGIN}/about/`, status: 'captured' },
    { id: 'old', requestedUrl: `${ORIGIN}/old`, finalUrl: `${ORIGIN}/about/`, status: 'alias', aliasOf: 'about' },
  ];
  assignRoutes(pages.filter((p) => p.status === 'captured'));
  const manifest = {
    resources: [
      res(`${ORIGIN}/css/site.css`, 'e.com/css/site.css', 'text/css'),
      res(`${ORIGIN}/img/a.png`, 'e.com/img/a.png'),
      res(`${ORIGIN}/img/a,2x.png`, 'e.com/img/a,2x.png'),
      res(`${ORIGIN}/img/bg.png`, 'e.com/img/bg.png'),
      res(`${ORIGIN}/js/app.js`, 'e.com/js/app.js', 'text/javascript'),
      res(`${ORIGIN}/css/theme.css?v=1`, 'e.com/css/theme.__q11111111.css', 'text/css'),
      res(`${ORIGIN}/css/theme.css?v=2`, 'e.com/css/theme.__q22222222.css', 'text/css'),
      res('https://cdn.other.net/font.woff2', 'cdn.other.net/font.woff2', 'font/woff2'),
      res(`${ORIGIN}/sprite.svg`, 'e.com/sprite.svg', 'image/svg+xml'),
    ],
  };
  const resolver = createResolver({ manifest, pages, entryUrl: `${ORIGIN}/`, options: {} });
  return { pages, manifest, resolver };
}

test('srcset parser follows the candidate grammar (commas inside URLs, descriptors)', () => {
  assert.deepEqual(parseSrcset('a.png 1x, /img/a,2x.png 2x'), [
    { url: 'a.png', descriptor: '1x' },
    { url: '/img/a,2x.png', descriptor: '2x' },
  ]);
  // Per the spec a comma without following whitespace is part of the URL.
  assert.deepEqual(parseSrcset('a.jpg,b.jpg 1x'), [{ url: 'a.jpg,b.jpg', descriptor: '1x' }]);
  assert.deepEqual(parseSrcset('  one.jpg, two.jpg 640w ,three.jpg'), [
    { url: 'one.jpg', descriptor: '' },
    { url: 'two.jpg', descriptor: '640w' },
    { url: 'three.jpg', descriptor: '' },
  ]);
  assert.equal(serializeSrcset(parseSrcset('a.png 640w, b.png 1280w')), 'a.png 640w, b.png 1280w');
});

test('CSS url() and @import are rewritten with a parser relative to the stylesheet', () => {
  const { resolver } = fixture();
  const css = `@import url("theme.css?v=1"); @import 'theme.css?v=2' screen;
.a{background:url(../img/bg.png) no-repeat, url("data:image/png;base64,AAA")}
.b{background-image:image-set("../img/a.png" 1x, "../img/a,2x.png" 2x)}
@font-face{font-family:X;src:url(https://cdn.other.net/font.woff2) format("woff2"), url(missing.woff)}
.c{content:"url(not-a-url.png)"}`;
  const { root } = parseCss(css);
  const missing = [];
  transformCss(root, {
    baseUrl: `${ORIGIN}/css/site.css`,
    resolve: (abs) => {
      const t = resolver.asset(abs);
      return t ? `REL:${t}` : null;
    },
    onMissing: (u) => missing.push(u),
  });
  const out = root.toString();
  assert.match(out, /@import url\("REL:assets\/site\/css\/theme\.__q11111111\.css"\)/);
  assert.match(out, /@import 'REL:assets\/site\/css\/theme\.__q22222222\.css' screen/);
  assert.match(out, /url\("REL:assets\/site\/img\/bg\.png"\) no-repeat/);
  assert.match(out, /data:image\/png;base64,AAA/);
  assert.match(out, /image-set\("REL:assets\/site\/img\/a\.png" 1x, "REL:assets\/site\/img\/a,2x\.png" 2x\)/);
  assert.match(out, /REL:assets\/ext\/cdn\.other\.net\/font\.woff2/);
  assert.match(out, /content:"url\(not-a-url\.png\)"/, 'strings are not rewritten');
  assert.deepEqual(missing, [`${ORIGIN}/css/missing.woff`]);
  assert.match(out, /url\("https:\/\/e\.com\/css\/missing\.woff"\)/, 'unresolved relative refs become absolute, not silently broken');
});

test('colour normalisation and brand-token replacement', () => {
  const n = (v) => normalizeColor(valueParser(v).nodes[0]);
  assert.equal(n('#FFF'), '#ffffff');
  assert.equal(n('rgb(11, 61, 92)'), '#0b3d5c');
  assert.equal(n('rgba(11,61,92,.5)'), '#0b3d5c80');
  assert.equal(n('hsl(0, 100%, 50%)'), '#ff0000');
  assert.equal(n('white'), '#ffffff');
  const { root } = parseCss('a{color:#0B3D5C;border:1px solid rgb(11,61,92);background:#0b3d5c80}body{font-family:"X Sans", Arial}');
  const stats = newStats();
  collectStats(root, stats);
  assert.equal(stats.colors.get('#0b3d5c').count, 2);
  transformCss(root, { baseUrl: ORIGIN, resolve: () => null, tokens: { colors: new Map([['#0b3d5c', 'primary']]), fonts: new Map([['"X Sans", Arial', 'body']]), sizes: new Map() } });
  const out = root.toString();
  assert.match(out, /color:var\(--sar-color-primary\)/);
  assert.match(out, /border:1px solid var\(--sar-color-primary\)/);
  assert.match(out, /background:#0b3d5c80/, 'different alpha is a different colour');
  assert.match(out, /font-family:var\(--sar-font-body\)/);
});

test('HTML reconstruction: base tag, relative URLs, srcset, internal routes, aliases, trackers, forms', () => {
  const { pages, resolver } = fixture();
  const report = { missing: [], cssParseErrors: [], scriptDependencies: [] };
  const $ = cheerio.load(`<!doctype html><html><head><base href="/"><link rel="stylesheet" href="css/site.css" integrity="sha-x">
<link rel="canonical" href="https://e.com/"><link rel="preconnect" href="https://cdn.other.net">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script><script>gtag('config','G-1')</script>
<style>.x{background:url(img/bg.png)}</style></head><body>
<img src="img/a.png" srcset="img/a.png 1x, img/a,2x.png 2x" style="background:url('img/bg.png')">
<img src="img/nope.png"><a href="/about/">About</a><a href="/old#team">Old</a><a href="https://e.com/pricing">Pricing (not captured)</a>
<a href="https://other.net/x">Ext</a><a href="#top">Top</a><a href="mailto:a@e.com">Mail</a>
<svg><use href="sprite.svg#icon"></use></svg><script src="js/app.js"></script>
<form action="/subscribe" method="post"><input name="e"><button formaction="/x">Go</button></form></body></html>`);
  const r = rewriteDocument($, { page: pages[0], resolver, report });
  const html = $.html();
  assert.equal($('base').length, 0);
  assert.equal($('link[rel=stylesheet]').attr('href'), '{{@root}}assets/site/css/site.css');
  assert.equal($('link[rel=stylesheet]').attr('integrity'), undefined);
  assert.equal($('link[rel=canonical]').length + $('link[rel=preconnect]').length, 0);
  assert.equal(r.removedTrackers.length, 2);
  assert.doesNotMatch(html, /googletagmanager\.com\/gtag/);
  assert.equal($('img').first().attr('srcset'), '{{@root}}assets/site/img/a.png 1x, {{@root}}assets/site/img/a,2x.png 2x');
  assert.match($('img').first().attr('style'), /url\(['"]\{\{@root\}\}assets\/site\/img\/bg\.png['"]\)/);
  assert.match($('style').text(), /\{\{@root\}\}assets\/site\/img\/bg\.png/);
  assert.equal($('img').eq(1).attr('src'), 'https://e.com/img/nope.png');
  assert.ok(report.missing.some((m) => m.url === 'https://e.com/img/nope.png'));
  assert.equal($('a').eq(0).attr('href'), '{{@root}}about/index.html');
  assert.equal($('a').eq(1).attr('href'), '{{@root}}about/index.html#team', 'redirect alias resolves to its target page');
  assert.equal($('a').eq(2).attr('href'), '/pricing', 'uncaptured in-scope page keeps a site path, never the reference origin');
  assert.deepEqual(r.uncapturedLinks, ['https://e.com/pricing']);
  assert.equal($('a').eq(3).attr('href'), 'https://other.net/x');
  assert.equal($('a').eq(4).attr('href'), '#top');
  assert.equal($('use').attr('href'), '{{@root}}assets/site/sprite.svg#icon');
  assert.equal($('script[src]').attr('src'), '{{@root}}assets/site/js/app.js');
  assert.equal($('form').attr('action'), undefined);
  assert.equal($('form').attr('data-sar-form'), 'home-form-1');
  assert.equal($('[formaction]').length, 0);
  assert.equal(r.disabledForms[0].originalAction, 'https://e.com/subscribe');
});

test('routes mirror original paths and stay unique', () => {
  const pages = [
    { id: 'a', finalUrl: 'https://e.com/' },
    { id: 'b', finalUrl: 'https://e.com/about' },
    { id: 'c', finalUrl: 'https://e.com/about/' },
    { id: 'd', finalUrl: 'https://e.com/p.html' },
    { id: 'e', finalUrl: 'https://e.com/blog?page=2' },
  ];
  assignRoutes(pages);
  assert.deepEqual(
    pages.map((p) => p.route),
    ['index.html', 'about/index.html', 'about/index-2.html', 'p.html', pages[4].route]
  );
  assert.match(pages[4].route, /^blog__q[0-9a-f]{8}\/index\.html$|^blog\/index__q[0-9a-f]{8}\.html$/);
});

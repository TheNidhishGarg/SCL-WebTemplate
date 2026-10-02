// Full workflow on the fixture site with the real extension in Chrome for Testing:
// launch page -> extension (discovery + Save All Resources capture) -> upload -> packaging ->
// templatising -> verification -> export. Then the exported template is rebuilt from the ZIP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { startStack } from './harness.mjs';

let stack;
let job;
let files; // export entries
const J = (name) => JSON.parse(strFromU8(files[`website-template/${name}`]));
const T = (name) => strFromU8(files[`website-template/${name}`]);

before(async () => {
  stack = await startStack();
  ({ job } = await stack.runJob(`${stack.fixture.url}/`, { maxPages: 15, maxUrlsPerPattern: 3 }, { timeoutMs: 900_000 }));
  files = unzipSync(new Uint8Array(readFileSync(job.exportFile)));
});
after(async () => stack?.close());

test('one command produced a finished job and an export', () => {
  assert.ok(['completed', 'completed_with_warnings'].includes(job.status), `status ${job.status}: ${job.errors.join('; ')}`);
  assert.equal(job.status, 'completed_with_warnings', 'the fixture contains an inaccessible page and a missing asset, so warnings are expected');
  for (const required of ['README.md', 'manifest.json', 'page-inventory.json', 'section-inventory.json', 'verification-report.json', 'verification-report.html', 'raw-capture/manifest.json', 'template/site.config.json', 'template/build.mjs', 'template/dist/index.html', 'template/content/shared.json']) {
    assert.ok(files[`website-template/${required}`], `export contains ${required}`);
  }
});

test('discovery: sitemap, navigation, footer and links within scope; traps and unsafe links bounded', () => {
  const inv = J('page-inventory.json');
  const byPath = (p) => inv.pages.find((x) => new URL(x.requestedUrl).pathname + new URL(x.requestedUrl).search === p);
  assert.ok(byPath('/sitemap-only.html'), 'sitemap-only page discovered');
  assert.ok(byPath('/sitemap-only.html').discoveredVia.includes('sitemap'));
  assert.ok(byPath('/about/').discoveredVia.includes('nav'));
  assert.equal(byPath('/private/').captureStatus, 'inaccessible');
  assert.equal(byPath('/old-pricing').captureStatus, 'alias', 'redirect deduplicated against its target');
  const skipped = Object.fromEntries(inv.skippedUrls.map((s) => [new URL(s.url).pathname + new URL(s.url).search, s.reason]));
  assert.equal(skipped['/logout'], 'unsafe-link');
  assert.equal(skipped['/drafts/secret.html'], 'robots-disallow');
  assert.ok(Object.values(skipped).includes('pattern-limit'), 'calendar trap bounded');
  assert.ok(Object.values(skipped).includes('query-variant-limit') || Object.values(skipped).includes('too-many-query-params'), 'query trap bounded');
  assert.equal(stack.fixture.requests.some((r) => r.path.startsWith('/logout')), false, '/logout was never requested');
  assert.equal(inv.pages.filter((p) => p.requestedUrl.includes('utm_source')).length, 0, 'tracking parameters canonicalised away');
});

test('capture used Save All Resources without manual steps and preserved raw artifacts', () => {
  const m = J('manifest.json');
  const captured = m.pages.filter((p) => p.status === 'captured');
  assert.ok(captured.length >= 8, `captured ${captured.length}`);
  for (const p of captured) {
    assert.ok(files[`website-template/${p.sarZip}`], `${p.id}: original SAR zip preserved`);
    assert.ok(p.hasOriginalHtml && p.hasRenderedHtml, `${p.id}: original and rendered HTML`);
    assert.ok(p.screenshots.desktop && p.screenshots.mobile, `${p.id}: screenshots`);
  }
  assert.match(m.capture.engine, /Save All Resources/);
  const res = (path) => m.resources.find((r) => new URL(r.url).pathname + new URL(r.url).search === path);
  assert.ok(res('/css/base.css') && res('/css/components/cards.css'), 'CSS imports captured');
  assert.ok(res('/img/hero-640.png') && res('/img/hero-1280.png'), 'all srcset candidates captured');
  for (const n of [1, 2, 3, 4]) assert.ok(res(`/img/work-${n}.png`), `lazy image work-${n} captured`);
  const v1 = res('/css/theme.css?v=1');
  const v2 = res('/css/theme.css?v=2');
  assert.ok(v1 && v2 && v1.localPath !== v2.localPath, 'query-string variants have distinct paths');
  assert.ok(m.resources.every((r) => r.sha256 && r.size >= 0), 'checksums and sizes recorded');
  const logo = res('/img/logo.svg');
  assert.ok(logo.pages.length >= 4, 'shared resource body stored once and mapped to every page');
  assert.equal(res('/img/missing.png'), undefined, '404 body not stored as an asset');
  assert.ok(m.failedRequests.some((f) => f.url.endsWith('/img/missing.png')), 'missing resource reported');
  assert.ok(m.redirects.length === 0 || m.redirects.every((r) => r.chain.length));
  assert.deepEqual([m.privacy.cookiesExported, m.privacy.requestHeadersExported], [false, false]);
  const { privacy, ...rest } = m;
  assert.doesNotMatch(JSON.stringify(rest), /cookie|authorization|set-cookie/i, 'no cookies or auth headers in the manifest');
});

test('reconstruction: local assets, rewritten CSS imports and srcset, internal navigation', () => {
  const home = T('template/dist/index.html');
  assert.match(home, /<link rel="stylesheet" href="\.\/assets\/site\/css\/site\.css">/);
  assert.match(home, /srcset="\.\/assets\/site\/img\/hero-640\.png 640w, \.\/assets\/site\/img\/hero-1280\.png 1280w"/);
  assert.match(home, /href="\.\/about\/index\.html"/);
  assert.match(home, /href="\.\/pricing\.html"[^>]*>Old pricing link/, 'link to redirecting URL points at the captured target');
  assert.doesNotMatch(home, /googletagmanager/, 'tracking removed');
  const css = T('template/assets/site/css/site.css');
  assert.match(css, /@import url\("base\.css"\)/);
  assert.match(css, /@import "components\/cards\.css"/);
  assert.match(css, /url\("\.\.\/fonts\/fixture-sans\.woff2"\)/);
  assert.match(css, /var\(--sar-color-primary\)/, 'brand tokens wired into CSS');
  const about = T('template/dist/about/index.html');
  assert.match(about, /href="\.\.\/assets\/site\/css\/theme\.__q[0-9a-f]{8}\.css"/, 'base tag resolved, variant v2 used on about');
  assert.doesNotMatch(about, /<base /);
  const pricing = T('template/dist/pricing.html');
  assert.match(pricing, /<form class="contact-form" data-sar-form="pricing-form-1" data-sar-form-disabled>/, 'original form endpoint disconnected');
  assert.doesNotMatch(pricing, /api\.northwind\.invalid/);
  const cfg = J('template/site.config.json');
  assert.ok(cfg.integrations.blockedEndpoints.includes('/api/newsletter-count'), 'operational API endpoint blocked by default');
  assert.equal(cfg.integrations.forms['pricing-form-1'].originalAction, 'https://api.northwind.invalid/contact');
});

test('sections: every page and section has a tracked outcome; shared and unique components', () => {
  const inv = J('section-inventory.json').sections;
  const pages = J('page-inventory.json').pages.filter((p) => p.templateStatus === 'templatised');
  for (const p of pages) assert.ok(inv.some((s) => s.page === p.id), `${p.id} has sections`);
  for (const s of inv) {
    assert.ok(['templatised', 'needs_manual_review'].includes(s.processingStatus));
    assert.ok(s.verificationStatus && s.verificationStatus !== 'pending', `${s.sectionId} verified`);
    assert.ok(files[`website-template/template/${s.component}`], `${s.sectionId} component file exists`);
  }
  const types = new Set(inv.filter((s) => ['home', 'about', 'pricing', 'gallery'].includes(s.page)).map((s) => s.type));
  for (const t of ['navigation', 'hero', 'cards', 'testimonials', 'pricing', 'faq', 'form', 'gallery', 'cta', 'footer']) assert.ok(types.has(t), `section type ${t} identified`);
  const footer = inv.filter((s) => s.type === 'footer' && ['home', 'about', 'pricing', 'gallery'].includes(s.page));
  assert.ok(footer.every((s) => s.shared && s.component === 'components/shared/footer.html'), 'footer is one shared component');
  const nav = inv.filter((s) => s.type === 'navigation');
  assert.ok(nav.every((s) => s.shared), 'navigation shared');
  assert.equal(nav.find((s) => s.page === 'about').variant, 'v2', 'about navigation (active item) is a variant');
  assert.ok(inv.find((s) => s.sectionId === 'pricing/s02-pricing' && !s.shared), 'unique section stays page-specific');
  const order = inv.filter((s) => s.page === 'home').map((s) => s.order);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'section order preserved');
});

test('brand and content configuration is extracted from the reference', () => {
  const cfg = J('template/site.config.json');
  assert.equal(cfg.brand.name, 'Northwind Studio');
  assert.equal(cfg.brand.logo.src, '/assets/site/img/logo.svg');
  assert.equal(cfg.brand.contact.email, 'hello@northwind.test');
  assert.equal(cfg.brand.social.instagram, 'https://instagram.com/northwind.test');
  assert.equal(cfg.colors.primary.value, '#0b3d5c');
  assert.ok(Object.keys(cfg.fonts).length >= 2);
  const home = J('template/content/pages/home.json');
  assert.equal(home.page.title, 'Home | {{brand.name}}');
  assert.equal(home.sections['s03-cards'].cards.length, 3, 'repeated cards are a list');
  assert.equal(home.sections['s02-hero'].cta.label, 'See pricing');
});

test('verification: isolated preview, all page checks and the configuration-change test', () => {
  const r = J('verification-report.json');
  assert.ok(r.checks.pages.length >= 8);
  for (const p of r.checks.pages) {
    for (const [name, c] of Object.entries(p.checks)) assert.notEqual(c.passed, false, `${p.page}: ${name} ${JSON.stringify(c).slice(0, 300)}`);
    assert.equal(p.checks.externalRequests.blocked.filter((b) => !/instagram|linkedin/.test(b.url)).length, 0, `${p.page}: no unexpected external requests`);
  }
  const home = r.checks.pages.find((p) => p.page === 'home');
  assert.deepEqual(home.checks.interactions.guardBlocked, [{ kind: 'fetch', url: '/api/newsletter-count' }], 'operational request blocked by the runtime guard');
  const pricing = r.checks.pages.find((p) => p.page === 'pricing');
  assert.ok(pricing.checks.interactions.forms.every((f) => f.blocked), 'form submission prevented');
  assert.ok(pricing.checks.interactions.details.every((d) => d.toggled), 'FAQ disclosure works');
  assert.ok(r.checks.configChange.passed, JSON.stringify(r.checks.configChange).slice(0, 800));
  assert.ok(r.checks.configChange.sectionEdits.some((e) => e.kind === 'shared-section'), 'shared section edit verified');
  assert.match(r.disclaimer, /not a pixel-perfect clone/);
  assert.equal(stack.fixture.posts.length, 0, 'no form was ever submitted to the reference site');
});

test('the exported template rebuilds from the ZIP and reflects config edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sar-export-'));
  try {
    for (const [name, data] of Object.entries(files)) {
      if (!name.startsWith('website-template/template/') || name.endsWith('/')) continue;
      const out = join(dir, name.slice('website-template/template/'.length));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, data);
    }
    const cfg = JSON.parse(readFileSync(join(dir, 'site.config.json'), 'utf8'));
    cfg.brand.name = 'Southwind Labs';
    cfg.colors.primary.value = '#123456';
    writeFileSync(join(dir, 'site.config.json'), JSON.stringify(cfg));
    execFileSync(process.execPath, ['build.mjs'], { cwd: dir });
    const home = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    assert.match(home, /<title>Home \| Southwind Labs<\/title>/);
    assert.match(home, /Southwind Labs designs and builds/);
    assert.match(readFileSync(join(dir, 'dist/brand/brand.css'), 'utf8'), /--sar-color-primary: #123456;/);
    assert.ok(existsSync(join(dir, 'dist/about/index.html')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { render, parse, interpolate } from '../../app/processing/template-runtime/lib/engine.mjs';
import { buildSite } from '../../app/processing/template-runtime/build.mjs';
import { findSections, classifySection } from '../../app/processing/sections.mjs';
import { createExtractor } from '../../app/processing/fields.mjs';

test('engine: escaping, rich text, loops, URL relativisation, config interpolation', () => {
  const cfg = { brand: { name: 'Acme & Co', logo: { src: '/assets/logo.svg' } } };
  const out = render('<h1>{{@ title}}</h1><div>{{@html body}}</div><img src="{{@url img}}" srcset="{{@srcset set}}">{{@each items}}<li>{{@ label}}</li>{{@end}}<i>{{@brand brand.name}}</i><img src="{{@brandurl brand.logo.src}}">', {
    scope: { title: '<b>{{brand.name}}</b>', body: '<a href="/about/index.html">About</a>', img: '/assets/a.png', set: '/assets/a.png 1x, /assets/b.png 2x', items: [{ label: 'One' }, { label: 'Two' }] },
    config: cfg,
    root: '../',
  });
  assert.equal(
    out,
    '<h1>&lt;b&gt;Acme &amp; Co&lt;/b&gt;</h1><div><a href="../about/index.html">About</a></div><img src="../assets/a.png" srcset="../assets/a.png 1x, ../assets/b.png 2x"><li>One</li><li>Two</li><i>Acme &amp; Co</i><img src="../assets/logo.svg">'
  );
  assert.equal(interpolate('Hi {{brand.missing}}', cfg), 'Hi {{brand.missing}}');
  assert.throws(() => parse('{{@each a}}x'), /unclosed/);
  assert.throws(() => render('{{@bogus x}}', { scope: {} }), /unknown template token/);
  assert.equal(render('{{ vue }} {{@root}}', { scope: {}, root: './' }), '{{ vue }} ./', 'framework templates in captured markup are untouched');
});

const PAGE = `<!doctype html><html><head><title>Home | Acme</title></head><body><div id="app">
<header class="site-header"><nav><a class="logo" href="/"><img src="/logo.svg" alt="Acme"></a><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav></header>
<main>
<section class="hero"><h1>Big claim</h1><p>Some <strong>bold</strong> copy.</p><a class="btn" href="/pricing">Start</a></section>
<section class="features"><h2>Features</h2><div class="grid"><article class="card"><h3>A</h3><p>a</p></article><article class="card"><h3>B</h3><p>b</p></article><article class="card"><h3>C</h3><p>c</p></article></div></section>
<section class="quotes"><h2>Reviews</h2><blockquote><p>Great</p><cite>Ann</cite></blockquote><blockquote><p>Good</p><cite>Bo</cite></blockquote></section>
<section><h2>Plans</h2><div><h3>Basic</h3><p>$10 / month</p></div><div><h3>Pro</h3><p>$20 / month</p></div></section>
<section class="faq"><h2>FAQ</h2><details><summary>Q1</summary><p>A1</p></details><details><summary>Q2</summary><p>A2</p></details></section>
<section class="contact"><form><label>Name <input name="n" placeholder="Your name"></label><label>Email <input name="e"></label><button>Send</button></form></section>
<section class="gallery"><img src="/1.png" alt=""><img src="/2.png" alt=""><img src="/3.png" alt=""><img src="/4.png" alt=""></section>
<section class="cta"><h2>Ready?</h2><a class="btn" href="/signup">Go</a></section>
<section class="prose"><h2>Story</h2><p>Long text that is not a call to action at all, it is just a description of the company history which goes on for a while to make sure it is not classified as a CTA because it is a long block of narrative content about things and stuff and more things that happened over the years in various places with various people. It keeps going for a long time indeed and then some more.</p></section>
</main>
<footer><p>© 2026 Acme</p></footer></div></body></html>`;

test('sections: every top-level block is found and classified', () => {
  const $ = cheerio.load(PAGE);
  const els = findSections($);
  const types = els.map((el, i) => classifySection($, el, { index: i, total: els.length, firstContentIndex: 1 }).type);
  assert.deepEqual(types, ['navigation', 'hero', 'cards', 'testimonials', 'pricing', 'faq', 'form', 'gallery', 'cta', 'content', 'footer']);
});

test('fields: text, rich text, links, images, placeholders and loops', () => {
  const $ = cheerio.load(PAGE);
  const els = findSections($);
  const ex = createExtractor($);
  const fieldsOf = (i) => ex.extract(els[i]);
  const nav = fieldsOf(0);
  assert.deepEqual(nav.items.map((i) => i.link), [{ href: '/', label: 'Home' }, { href: '/about', label: 'About' }]);
  assert.deepEqual(fieldsOf(1), { heading: 'Big claim', text: 'Some <strong>bold</strong> copy.', cta: { href: '/pricing', label: 'Start' } });
  const cards = fieldsOf(2);
  assert.equal(cards.cards.length, 3);
  assert.match($.html(els[2]), /\{\{@each cards\}\}<article class="card">\s*<h3>\{\{@ heading\}\}<\/h3>/);
  assert.equal(fieldsOf(3).quotes[1].cite, 'Bo');
  assert.equal(fieldsOf(5).questions.length, 2);
  const form = fieldsOf(6);
  assert.equal(form.placeholder, 'Your name');
  assert.equal(form.button, 'Send');
  assert.equal(fieldsOf(7).images.length, 4);
});

function writeTemplate(dir) {
  const w = (p, c) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), typeof c === 'string' ? c : JSON.stringify(c));
  };
  w('site.config.json', {
    brand: { name: 'Acme', logo: { src: '/assets/logo.svg', alt: 'Acme' }, favicon: '' },
    colors: { primary: { value: '#0b3d5c' } },
    fonts: { body: { family: 'Arial, sans-serif' } },
    typography: {},
    images: {},
    integrations: { allowedOrigins: [], blockedEndpoints: ['/api/x'], analytics: { enabled: false, headHtml: '<script>window.a=1</script>' }, forms: { 'home-form-1': { action: '', method: 'post' } } },
  });
  w('content/shared.json', { footer: { text: '© {{brand.name}}' } });
  w('content/pages/home.json', { page: { title: 'Home | {{brand.name}}' }, sections: { 's01-hero': { heading: 'Hello' } } });
  w('content/pages/about.json', { page: { title: 'About' }, sections: { 's02-footer': { text: 'About footer override' } } });
  w('components/pages/home/s01-hero.html', '<section data-sar-section="{{@sectionid}}"><h1>{{@ heading}}</h1><a href="{{@root}}about/index.html">About</a><form data-sar-form="home-form-1"></form></section>');
  w('components/shared/footer.html', '<footer data-sar-section="{{@sectionid}}">{{@ text}}</footer>');
  const layout = '<!doctype html><html><head><meta charset="utf-8">{{@head-start}}<title>{{@ page.title}}</title>{{@head-end}}</head><body>{{@section ID1}}{{@section ID2}}</body></html>';
  w('layouts/home.html', layout.replace('ID1', 'home/s01-hero').replace('ID2', 'home/s02-footer'));
  w('layouts/about.html', layout.replace('{{@section ID1}}', '').replace('ID2', 'about/s02-footer'));
  w('pages/home.json', { id: 'home', route: 'index.html', layout: 'layouts/home.html', sections: [{ id: 'home/s01-hero', localId: 's01-hero', component: 'pages/home/s01-hero', content: 'page' }, { id: 'home/s02-footer', localId: 's02-footer', component: 'shared/footer', content: 'shared:footer' }] });
  w('pages/about.json', { id: 'about', route: 'about/index.html', layout: 'layouts/about.html', sections: [{ id: 'about/s02-footer', localId: 's02-footer', component: 'shared/footer', content: 'shared:footer' }] });
  w('runtime/sar-runtime.js', '/* runtime */');
  w('assets/logo.svg', '<svg/>');
}

test('build: config and content changes update the rendered pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sar-tpl-'));
  try {
    writeTemplate(dir);
    buildSite({ root: dir });
    let home = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    let about = readFileSync(join(dir, 'dist/about/index.html'), 'utf8');
    assert.match(home, /<title>Home \| Acme<\/title>/);
    assert.match(home, /<h1>Hello<\/h1>/);
    assert.match(home, /href="\.\/about\/index\.html"/);
    assert.match(about, /src="\.\.\/runtime\/sar-runtime\.js"/, 'relative prefix per page depth');
    assert.match(home, /<footer data-sar-section="home\/s02-footer">© Acme<\/footer>/);
    assert.match(about, /About footer override/, 'page-level override of shared content');
    assert.match(home, /data-sar-form="home-form-1" data-sar-form-disabled/, 'unconfigured form stays disabled');
    assert.match(home, /Content-Security-Policy" content="[^"]*connect-src &#39;self&#39;;/);
    assert.match(home, /"blockedEndpoints":\["\/api\/x"\]/);
    assert.doesNotMatch(home, /window\.a=1/, 'analytics disabled by default');
    assert.match(readFileSync(join(dir, 'dist/brand/brand.css'), 'utf8'), /--sar-color-primary: #0b3d5c;/);

    const cfg = JSON.parse(readFileSync(join(dir, 'site.config.json'), 'utf8'));
    cfg.brand.name = 'Zenith';
    cfg.colors.primary.value = '#ff0000';
    cfg.integrations.forms['home-form-1'].action = 'https://forms.example.org/f/1';
    cfg.integrations.analytics.enabled = true;
    cfg.integrations.allowedOrigins = ['https://forms.example.org'];
    writeFileSync(join(dir, 'site.config.json'), JSON.stringify(cfg));
    const content = JSON.parse(readFileSync(join(dir, 'content/pages/home.json'), 'utf8'));
    content.sections['s01-hero'].heading = 'Changed heading';
    writeFileSync(join(dir, 'content/pages/home.json'), JSON.stringify(content));
    buildSite({ root: dir });
    home = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    about = readFileSync(join(dir, 'dist/about/index.html'), 'utf8');
    assert.match(home, /<title>Home \| Zenith<\/title>/);
    assert.match(home, /<h1>Changed heading<\/h1>/);
    assert.match(home, /© Zenith/);
    assert.doesNotMatch(about, /Changed heading/, 'content edits stay on their page');
    assert.match(home, /data-sar-form="home-form-1" action="https:\/\/forms\.example\.org\/f\/1" method="post"/);
    assert.match(home, /form-action &#39;self&#39; https:\/\/forms\.example\.org/);
    assert.match(home, /window\.a=1/);
    assert.match(readFileSync(join(dir, 'dist/brand/brand.css'), 'utf8'), /--sar-color-primary: #ff0000;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

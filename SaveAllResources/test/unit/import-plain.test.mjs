import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { readPlainDownload, packagePlainDownload, ImportError } from '../../app/processing/import-plain.mjs';
import { sarPathCandidates } from '../../app/lib/sar-path.mjs';
import { processJob } from '../../app/processing/pipeline.mjs';

// A download as the Chrome Web Store build of Save All Resources writes it: one folder per host,
// query strings dropped, extension-less names given one by response type. No manifest.
const page = (title, body) => `<!doctype html><html lang="hi"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/css/site.css?v=42"><link rel="stylesheet" href="https://fonts.cdn.test/css2?family=Noto+Sans"></head>
<body><header><nav><a href="/">Home</a><a href="/about">About</a><a href="/सेवाएं/">Services</a></nav></header>
<main>${body}</main><footer><p>© Studio</p></footer></body></html>`;

function download(prefix = '') {
  const files = {
    'www.studio.test/index.html': page('Home', '<section class="hero"><h1>Hello</h1><img src="/img/hero.png?w=800" alt=""></section>'),
    'www.studio.test/about.html': page('About', '<section><h2>About us</h2><p>Text</p></section>'),
    'www.studio.test/सेवाएं/index.html': page('Services', '<section><h2>Services</h2></section>'),
    'www.studio.test/css/site.css': 'body{background:url(../img/bg.png)}',
    'www.studio.test/img/hero.png': 'png',
    'www.studio.test/img/bg.png': 'png',
    'fonts.cdn.test/css2.css': '@font-face{font-family:x}',
    '_DataURI/data.image.png.abc.txt': 'x',
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}${k}`, strToU8(v)])));
}

test('SAR path rule: query strings dropped, extension-less names get a type extension', () => {
  assert.deepEqual(sarPathCandidates('https://www.studio.test/css/site.css?v=42'), ['www.studio.test/css/site.css']);
  assert.ok(sarPathCandidates('https://www.studio.test/about').includes('www.studio.test/about.html'));
  assert.deepEqual(sarPathCandidates('https://www.studio.test/'), ['www.studio.test/index.html']);
  assert.deepEqual(sarPathCandidates('https://www.studio.test/%E0%A4%B8/'), ['www.studio.test/स/index.html']);
  assert.ok(sarPathCandidates('https://fonts.cdn.test/css2?family=Noto+Sans').includes('fonts.cdn.test/css2.css'));
});

test('recognises a download, with or without a wrapper folder, and finds the entry host', () => {
  for (const prefix of ['', 'Downloads/']) {
    const d = readPlainDownload(download(prefix), { zipName: 'www.studio.test.zip' });
    assert.equal(d.entryHost, 'www.studio.test');
    assert.equal(d.entryUrl, 'https://www.studio.test/');
    assert.equal(d.pagePaths.length, 3);
  }
  // Without a file-name hint: the host with the most HTML pages.
  assert.equal(readPlainDownload(download(), { zipName: 'archive (2).zip' }).entryHost, 'www.studio.test');
  // An explicit entry URL wins, including its scheme.
  assert.equal(readPlainDownload(download(), { entryUrl: 'http://www.studio.test/about' }).entryUrl, 'http://www.studio.test/about');
  assert.throws(() => readPlainDownload(download(), { entryUrl: 'https://other.test/' }), /no folder for other.test/);
  assert.throws(() => readPlainDownload(zipSync({ 'site/index.html': strToU8('<p>') })), ImportError);
  assert.throws(() => readPlainDownload(zipSync({ 'manifest.json': strToU8('{}'), 'a.com/index.html': strToU8('<p>') })), /already a website-template export/);
  assert.throws(() => readPlainDownload(strToU8('not a zip')), /Not a readable ZIP/);
});

test('imports a download through packaging and templatising, resolving every reference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sar-import-'));
  try {
    mkdirSync(join(dir, 'import'), { recursive: true });
    writeFileSync(join(dir, 'import', 'download.zip'), download());
    const job = { jobId: 'job_test_import', url: 'https://www.studio.test/', options: { allowedOrigins: [], interactionRecipes: [] }, import: { fileName: 'www.studio.test.zip' }, createdAt: Date.now() };
    const r = await processJob({ jobDir: dir, job, verification: { enabled: false }, packager: packagePlainDownload });
    assert.ok(r.exportFile, `export written (${r.errors.join('; ')})`);
    assert.deepEqual(r.errors, []);
    const out = join(dir, 'work', 'website-template');
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.generator, 'sar-website-template');
    assert.equal(manifest.capture.importedFrom, 'save-all-resources-download');
    assert.equal(manifest.pages.filter((p) => p.templateStatus !== 'not_templatised').length, 3);
    const report = JSON.parse(readFileSync(join(out, 'verification-report.json'), 'utf8'));
    assert.deepEqual((report.missing || []).map((m) => m.url), []);
    const home = readFileSync(join(out, 'template', 'layouts', 'home.html'), 'utf8');
    assert.match(home, /assets\/site\/css\/site\.css/);
    assert.match(home, /assets\/ext\/fonts\.cdn\.test\/css2\.css/);
    const all = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [readFileSync(join(d, e.name), 'utf8')]));
    assert.ok(all(join(out, 'template', 'content')).concat(all(join(out, 'template', 'components'))).some((t) => /assets\/site\/img\/hero\.png/.test(t)), 'the hero image resolves despite ?w=800');
    // Links to extension-less and non-ASCII page URLs reach the imported pages.
    assert.ok(all(join(out, 'template', 'dist')).some((t) => /href="[^"]*about\.html"/.test(t) && /%E0%A4%B8|सेवाएं/.test(t)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Builds dist/ from site.config.json + content/ + components/ + layouts/ + assets/.
// Usage: node build.mjs [--out dist]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, parse, deepMerge, escapeHtml, interpolate, getPath } from './lib/engine.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function brandCss(config) {
  const lines = [];
  for (const [key, c] of Object.entries(config.colors || {})) lines.push(`  --sar-color-${key}: ${c.value};`);
  for (const [key, f] of Object.entries(config.fonts || {})) lines.push(`  --sar-font-${key}: ${f.family};`);
  for (const [key, t] of Object.entries(config.typography || {})) lines.push(`  --sar-${key}: ${t.value};`);
  return `/* Generated from site.config.json by build.mjs — edit the config, not this file. */\n:root {\n${lines.join('\n')}\n}\n`;
}

function csp(config) {
  const integ = config.integrations || {};
  const allowed = (integ.allowedOrigins || []).join(' ');
  const formOrigins = Object.values(integ.forms || {})
    .map((f) => {
      try {
        return f.action ? new URL(f.action).origin : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join(' ');
  return [
    `default-src 'self' data: blob:`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${allowed}`,
    `style-src 'self' 'unsafe-inline' ${allowed}`,
    `img-src 'self' data: blob: ${allowed}`,
    `font-src 'self' data: ${allowed}`,
    `media-src 'self' data: blob: ${allowed}`,
    `connect-src 'self' ${allowed}`,
    `frame-src 'self' ${allowed}`,
    `worker-src 'self' blob:`,
    `form-action 'self' ${formOrigins}`,
  ]
    .map((s) => s.trim())
    .join('; ');
}

export function buildSite({ root = dirname(fileURLToPath(import.meta.url)), outDir } = {}) {
  outDir = resolve(root, outDir || 'dist');
  const config = readJson(join(root, 'site.config.json'));
  const shared = existsSync(join(root, 'content/shared.json')) ? readJson(join(root, 'content/shared.json')) : {};
  const pagesDir = join(root, 'pages');
  const componentCache = new Map();
  const component = (id) => {
    if (!componentCache.has(id)) componentCache.set(id, parse(readFileSync(join(root, 'components', `${id}.html`), 'utf8')));
    return componentCache.get(id);
  };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const integ = config.integrations || {};
  const runtimeConfig = { allowedOrigins: integ.allowedOrigins || [], blockedEndpoints: integ.blockedEndpoints || [] };
  const built = [];

  for (const file of readdirSync(pagesDir).filter((f) => f.endsWith('.json')).sort()) {
    const page = readJson(join(pagesDir, file));
    const content = existsSync(join(root, 'content/pages', `${page.id}.json`)) ? readJson(join(root, 'content/pages', `${page.id}.json`)) : { page: {}, sections: {} };
    const depth = page.route.split('/').length - 1;
    const rootPrefix = depth ? '../'.repeat(depth) : './';
    const sectionsById = new Map(page.sections.map((s) => [s.id, s]));

    const renderSection = (id) => {
      const s = sectionsById.get(id);
      if (!s) throw new Error(`page ${page.id}: unknown section ${id}`);
      const local = content.sections?.[s.localId];
      const scope = s.content === 'page' ? local || {} : deepMerge(getPath(shared, s.content.replace(/^shared:/, '')) || {}, local);
      return render(component(s.component), { scope, config, root: rootPrefix, sectionId: s.id });
    };
    const head = {
      start:
        `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp(config))}">\n` +
        `<script>window.__SAR_RUNTIME__=${JSON.stringify(runtimeConfig).replace(/</g, '\\u003c')};</script>\n` +
        `<script src="${rootPrefix}runtime/sar-runtime.js"></script>`,
      end:
        `<link rel="stylesheet" href="${rootPrefix}brand/brand.css">` +
        (integ.analytics?.enabled && integ.analytics.headHtml ? `\n${integ.analytics.headHtml}` : ''),
    };
    let html = render(readFileSync(join(root, page.layout), 'utf8'), {
      scope: { page: Object.fromEntries(Object.entries(content.page || {}).map(([k, v]) => [k, interpolate(v, config)])) },
      config,
      root: rootPrefix,
      renderSection,
      head,
    });
    // Forms: connect configured endpoints; everything else stays disabled by the runtime guard.
    html = html.replace(/data-sar-form="([^"]+)"/g, (m, id) => {
      const f = integ.forms?.[id];
      if (f?.action) return `${m} action="${escapeHtml(f.action)}" method="${escapeHtml(f.method || 'post')}"`;
      return `${m} data-sar-form-disabled`;
    });
    const out = join(outDir, page.route);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    built.push(page.route);
  }

  if (existsSync(join(root, 'assets'))) cpSync(join(root, 'assets'), join(outDir, 'assets'), { recursive: true });
  cpSync(join(root, 'runtime'), join(outDir, 'runtime'), { recursive: true });
  mkdirSync(join(outDir, 'brand'), { recursive: true });
  writeFileSync(join(outDir, 'brand/brand.css'), brandCss(config));
  // Browsers request /favicon.ico for pages without an icon link: serve the configured favicon.
  const fav = config.brand?.favicon;
  if (fav && fav.startsWith('/') && existsSync(join(root, fav.slice(1)))) cpSync(join(root, fav.slice(1)), join(outDir, 'favicon.ico'));
  return { outDir, pages: built };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const { outDir, pages } = buildSite({ outDir: i > 0 ? process.argv[i + 1] : undefined });
  console.log(`Built ${pages.length} page(s) into ${outDir}`);
}


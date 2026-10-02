// Templatising stage: reconstructed pages -> runnable, editable multi-page template.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { assignRoutes, createResolver, rewriteDocument, writeAssets } from './reconstruct.mjs';
import { collectStats, newStats, parseCss, saturation, luminance } from './css.mjs';
import { findSections, classifySection, structureSignature, interactionDependencies } from './sections.mjs';
import { createExtractor } from './fields.mjs';
import { buildSite } from './template-runtime/build.mjs';

const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), 'template-runtime');
const SOCIAL = [
  ['facebook', /(^|\.)facebook\.com$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['x', /(^|\.)(twitter|x)\.com$/],
  ['linkedin', /(^|\.)linkedin\.com$/],
  ['youtube', /(^|\.)youtube\.com$|(^|\.)youtu\.be$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['github', /(^|\.)github\.com$/],
  ['pinterest', /(^|\.)pinterest\.[a-z.]+$/],
  ['threads', /(^|\.)threads\.net$/],
  ['mastodon', /mastodon|(^|\.)fosstodon\.org$/],
];

const writeJson = (p, data) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
};
const writeText = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const pad = (n) => String(n).padStart(2, '0');

function decideTokens(stats) {
  const colors = [...stats.colors.entries()].filter(([, s]) => s.count >= 2).sort((a, b) => b[1].count - a[1].count).slice(0, 16);
  const names = new Map();
  const used = new Set();
  const take = (hex, name) => {
    if (!names.has(hex) && !used.has(name)) {
      names.set(hex, name);
      used.add(name);
    }
  };
  const saturated = colors.filter(([hex]) => hex.length === 7 && saturation(hex) > 0.25 && luminance(hex) > 0.05 && luminance(hex) < 0.95);
  if (saturated[0]) take(saturated[0][0], 'primary');
  if (saturated[1]) take(saturated[1][0], 'accent');
  const byBucket = (bucket) => colors.filter(([hex]) => !names.has(hex)).sort((a, b) => (b[1].props[bucket] || 0) - (a[1].props[bucket] || 0))[0];
  const text = byBucket('text');
  if (text && text[1].props.text) take(text[0], 'text');
  const bg = byBucket('background');
  if (bg && bg[1].props.background) take(bg[0], 'background');
  let n = 1;
  for (const [hex] of colors) if (!names.has(hex)) take(hex, `color-${n++}`);

  const fonts = [...stats.fonts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  const fontNames = new Map();
  const usedF = new Set();
  let fn = 1;
  for (const [family, s] of fonts) {
    const sels = [...s.selectors].join(',').toLowerCase();
    let name = /\b(body|html)\b/.test(sels) && !usedF.has('body') ? 'body' : /\bh[1-3]\b/.test(sels) && !usedF.has('heading') ? 'heading' : `font-${fn++}`;
    usedF.add(name);
    fontNames.set(family, name);
  }
  const sizes = new Map();
  for (const sel of stats.sizes.keys()) sizes.set(sel, `size-${sel === 'html' ? 'root' : sel}`);

  const config = {
    colors: Object.fromEntries([...names].map(([hex, name]) => [name, { value: hex, uses: stats.colors.get(hex).count }])),
    fonts: Object.fromEntries([...fontNames].map(([family, name]) => [name, { family, uses: stats.fonts.get(family).count }])),
    typography: Object.fromEntries([...sizes].map(([sel, name]) => [name, { value: stats.sizes.get(sel), selector: sel }])),
  };
  return { colors: names, fonts: fontNames, sizes, config };
}

/** Walk content values, calling fn(string) -> string for every string. */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

function collectImageSrcs(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => collectImageSrcs(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.src === 'string' && value.src.startsWith('/assets/')) out.push(value.src);
    Object.values(value).forEach((v) => collectImageSrcs(v, out));
  }
  return out;
}

function fieldPaths(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    out.push(`${prefix}[]`);
    if (value[0]) fieldPaths(value[0], `${prefix}[]`, out);
  } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) fieldPaths(v, prefix ? `${prefix}.${k}` : k, out);
  else out.push(prefix);
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function templatiseSite({ outDir, manifest, job }) {
  const templateDir = join(outDir, 'template');
  mkdirSync(templateDir, { recursive: true });
  const pages = manifest.pages.filter((p) => p.status === 'captured' && (p.hasRenderedHtml || p.hasOriginalHtml));
  for (const p of manifest.pages) if (!pages.includes(p)) p.templateStatus = p.status === 'alias' ? 'alias' : 'not_templatised';
  assignRoutes(pages);
  const resolver = createResolver({ manifest, pages: manifest.pages, entryUrl: job.url, options: job.options });
  const report = { missing: [], cssParseErrors: [], scriptDependencies: [], pages: {} };

  // 1. Brand statistics across external and inline CSS.
  const stats = newStats();
  const docs = new Map();
  for (const r of manifest.resources) {
    if (!r.templatePath || !(/css/.test(r.contentType || '') || r.templatePath.endsWith('.css'))) continue;
    const { root } = parseCss(readFileSync(join(outDir, r.dedupedTo || r.localPath), 'utf8'), r.url);
    if (root) collectStats(root, stats);
  }
  for (const p of pages) {
    const file = join(outDir, 'raw-capture/pages', p.id, p.hasRenderedHtml ? 'document.rendered.html' : 'document.original.html');
    p.templateSource = p.hasRenderedHtml ? 'rendered-dom' : 'original-html';
    const $ = cheerio.load(readFileSync(file, 'utf8'));
    docs.set(p.id, $);
    $('style').each((_, el) => {
      const { root } = parseCss($(el).text());
      if (root) collectStats(root, stats);
    });
    $('[style]').each((_, el) => {
      const { root } = parseCss(`x{${$(el).attr('style')}}`);
      if (root) collectStats(root, stats);
    });
  }
  const tokens = decideTokens(stats);

  // 2. Assets (CSS rewritten: local URLs + brand tokens).
  const tokenUseByAsset = new Map();
  writeAssets({
    outDir,
    templateDir,
    manifest,
    resolver,
    tokens,
    report,
    onTokenUse: (asset, t) => {
      if (!tokenUseByAsset.has(asset)) tokenUseByAsset.set(asset, new Set());
      tokenUseByAsset.get(asset).add(t);
    },
  });

  // 3. Rewrite documents and detect sections.
  const brandSignals = { siteNames: new Map(), titles: [], favicon: null, emails: new Map(), phones: new Map(), social: new Map(), logo: null };
  const instances = [];
  for (const p of pages) {
    const $ = docs.get(p.id);
    const pageReport = rewriteDocument($, { page: p, resolver, tokens, report });
    report.pages[p.id] = pageReport;
    const site = $('meta[property="og:site_name"]').attr('content');
    if (site) brandSignals.siteNames.set(site.trim(), (brandSignals.siteNames.get(site.trim()) || 0) + 1);
    brandSignals.titles.push($('title').first().text().trim());
    const fav = $('link[rel~="icon"][href]').first().attr('href');
    if (fav && !brandSignals.favicon && fav.startsWith('{{@root}}')) brandSignals.favicon = '/' + fav.slice(9);
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      const inFooter = $(a).closest('footer,[role=contentinfo]').length > 0;
      const bump = (map, key, val) => map.set(key, { count: (map.get(key)?.count || 0) + (inFooter ? 2 : 1), val });
      if (/^mailto:/i.test(href)) bump(brandSignals.emails, href.slice(7).split('?')[0], $(a).text().trim());
      else if (/^tel:/i.test(href)) bump(brandSignals.phones, href.slice(4), $(a).text().trim());
      else if (/^https?:/i.test(href)) {
        try {
          const host = new URL(href).hostname.replace(/^www\./, '');
          const net = SOCIAL.find(([, re]) => re.test(host));
          if (net && !brandSignals.social.has(net[0])) brandSignals.social.set(net[0], href);
        } catch {
          /* ignore */
        }
      }
    });

    const els = findSections($);
    const firstContentIndex = els.findIndex((el) => !['header', 'nav'].includes(el.name) && !/nav|header|menu/i.test(`${$(el).attr('class') || ''} ${$(el).attr('id') || ''}`));
    els.forEach((el, i) => {
      const { type, reasons } = classifySection($, el, { index: i, total: els.length, firstContentIndex });
      const localId = `s${pad(i + 1)}-${type}`;
      instances.push({
        pageId: p.id,
        page: p,
        el,
        index: i,
        type,
        reasons,
        localId,
        sectionId: `${p.id}/${localId}`,
        signature: `${type}:${structureSignature($, el)}`,
        interactions: interactionDependencies($, el),
        selector: el.name + ($(el).attr('id') ? `#${$(el).attr('id')}` : '') + ($(el).attr('class') ? '.' + $(el).attr('class').trim().split(/\s+/).join('.') : ''),
      });
    });
  }

  // 4. Brand detection: logo (first navigation image that looks like a logo).
  for (const inst of instances.filter((s) => s.type === 'navigation')) {
    const $ = docs.get(inst.pageId);
    const homeRoute = pages[0]?.route;
    const img = $(inst.el)
      .find('img')
      .filter((_, im) => /logo|brand/i.test(`${$(im).attr('class') || ''} ${$(im).attr('id') || ''} ${$(im).attr('alt') || ''} ${$(im).attr('src') || ''} ${$(im).parent().attr('class') || ''}`) || $(im).closest('a[data-sar-internal]').attr('href') === `{{@root}}${homeRoute}`)
      .first();
    if (img.length && img.attr('src')?.startsWith('{{@root}}')) {
      brandSignals.logo = { src: '/' + img.attr('src').slice(9), alt: img.attr('alt') || '' };
      break;
    }
  }
  if (brandSignals.logo) {
    for (const inst of instances.filter((s) => s.type === 'navigation' || s.type === 'footer')) {
      const $ = docs.get(inst.pageId);
      $(inst.el)
        .find('img')
        .filter((_, im) => $(im).attr('src') === `{{@root}}${brandSignals.logo.src.slice(1)}`)
        .attr('data-sar-brand-logo', '');
    }
  }
  for (const $ of docs.values()) $('[data-sar-internal]').removeAttr('data-sar-internal');
  const siteName =
    [...brandSignals.siteNames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
    (() => {
      const counts = new Map();
      for (const t of brandSignals.titles) for (const part of t.split(/\s+[|–—·:-]\s+/).map((s) => s.trim()).filter(Boolean)) counts.set(part, (counts.get(part) || 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return best && best[1] >= Math.max(2, Math.ceil(pages.length / 2)) ? best[0] : null;
    })() ||
    new URL(job.url).hostname;
  const top = (map) => [...map.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const email = top(brandSignals.emails);
  const phone = top(brandSignals.phones);

  // 5. Field extraction per section; layout placeholders.
  for (const inst of instances) {
    const $ = docs.get(inst.pageId);
    const extractor = createExtractor($);
    const unsupported = [];
    if ($(inst.el).find('canvas').length) unsupported.push('canvas content is script-rendered');
    if ($(inst.el).find('*').filter((_, e) => e.name.includes('-')).length && inst.page.unsupported?.shadowHosts) unsupported.push('custom elements with shadow DOM (shadow content is not in the snapshot)');
    if ($(inst.el).find('iframe').filter((_, f) => /^https?:/.test($(f).attr('src') || '')).length) unsupported.push('cross-origin iframe');
    const original = $.html(inst.el);
    try {
      inst.fields = extractor.extract(inst.el);
      $(inst.el).attr('data-sar-section', '{{@sectionid}}');
      $(inst.el).attr('data-sar-type', inst.type);
      inst.markup = $.html(inst.el);
      inst.status = unsupported.length ? 'needs_manual_review' : 'templatised';
      if (!Object.keys(inst.fields).length) inst.notes = ['no editable text or media found; markup kept as-is'];
    } catch (e) {
      // Retain the reconstructed markup unchanged and flag it — never drop a section.
      inst.fields = {};
      inst.markup = original.replace(/^<([a-z0-9-]+)/i, '<$1 data-sar-section="{{@sectionid}}" data-sar-type="' + inst.type + '"');
      inst.status = 'needs_manual_review';
      unsupported.push(`field extraction failed: ${e.message}`);
    }
    inst.unsupported = unsupported;
    $(inst.el).replaceWith(`{{@section ${inst.sectionId}}}`);
  }

  // 6. Brand interpolation in content values.
  const brand = {
    name: siteName,
    logo: brandSignals.logo || { src: '', alt: siteName },
    favicon: brandSignals.favicon || '',
    contact: { email: email?.[0] || '', phone: phone?.[0] || '', phoneDisplay: phone?.[1].val || '' },
    social: Object.fromEntries(brandSignals.social),
  };
  const replacements = [];
  if (brand.contact.email) replacements.push([new RegExp(escapeRe(brand.contact.email), 'g'), '{{brand.contact.email}}']);
  if (brand.contact.phone) replacements.push([new RegExp(`(?<=tel:)${escapeRe(brand.contact.phone)}`, 'g'), '{{brand.contact.phone}}']);
  if (brand.contact.phoneDisplay && brand.contact.phoneDisplay.length >= 5) replacements.push([new RegExp(escapeRe(brand.contact.phoneDisplay), 'g'), '{{brand.contact.phoneDisplay}}']);
  for (const [net, url] of Object.entries(brand.social)) replacements.push([new RegExp(`^${escapeRe(url)}$`), `{{brand.social.${net}}}`]);
  if (siteName && siteName.length >= 3 && !/^[\d.]+$/.test(siteName)) replacements.push([new RegExp(`(?<![\\w-])${escapeRe(siteName)}(?![\\w-])`, 'g'), '{{brand.name}}']);
  const brandify = (s) => replacements.reduce((acc, [re, to]) => acc.replace(re, to), s);
  for (const inst of instances) inst.fields = mapStrings(inst.fields, brandify);
  if (brand.logo.alt) brand.logo.alt = brand.logo.alt; // kept literal; edit in site.config.json

  // Shared images: same asset in sections of at least two pages -> central config.
  const imagePages = new Map();
  for (const inst of instances) for (const src of collectImageSrcs(inst.fields)) {
    if (src === brand.logo.src) continue;
    if (!imagePages.has(src)) imagePages.set(src, new Set());
    imagePages.get(src).add(inst.pageId);
  }
  const images = {};
  let imgN = 1;
  for (const [src, set] of imagePages) if (set.size >= 2) images[`image-${imgN++}`] = src;
  const imageKeys = new Map(Object.entries(images).map(([k, v]) => [v, k]));
  for (const inst of instances) inst.fields = mapStrings(inst.fields, (s) => (imageKeys.has(s) ? `{{images.${imageKeys.get(s)}}}` : s));

  // 7. Shared components and variants.
  const groups = new Map();
  for (const inst of instances.filter((i) => ['navigation', 'footer'].includes(i.type))) {
    if (!groups.has(inst.signature)) groups.set(inst.signature, []);
    groups.get(inst.signature).push(inst);
  }
  const markupGroups = new Map();
  for (const inst of instances) {
    if (!markupGroups.has(inst.markup)) markupGroups.set(inst.markup, []);
    markupGroups.get(inst.markup).push(inst);
  }
  const sharedNames = new Set();
  const uniqueName = (base) => {
    let name = base;
    let n = 2;
    while (sharedNames.has(name)) name = `${base}-${n++}`;
    sharedNames.add(name);
    return name;
  };
  const shared = {};
  const assignShared = (members, name, variantOf) => {
    const byMarkup = new Map();
    for (const m of members) {
      if (!byMarkup.has(m.markup)) byMarkup.set(m.markup, []);
      byMarkup.get(m.markup).push(m);
    }
    const variants = [...byMarkup.values()];
    variants.forEach((vMembers, vi) => {
      const variant = variants.length > 1 ? `v${vi + 1}` : null;
      const componentId = variant ? `shared/${name}/${variant}` : `shared/${name}`;
      const contentPath = variant ? `${name}.${variant}` : name;
      const base = vMembers[0].fields;
      if (variant) (shared[name] = shared[name] || {})[variant] = base;
      else shared[name] = base;
      for (const m of vMembers) {
        m.componentId = componentId;
        m.contentRef = `shared:${contentPath}`;
        m.sharedName = name;
        m.variant = variant;
        m.sharedWith = [...new Set(members.map((x) => x.pageId))];
        const overrides = {};
        for (const [k, v] of Object.entries(m.fields)) if (JSON.stringify(v) !== JSON.stringify(base[k])) overrides[k] = v;
        m.overrides = Object.keys(overrides).length ? overrides : null;
      }
    });
    void variantOf;
  };
  for (const members of groups.values()) {
    if (new Set(members.map((m) => m.pageId)).size < 2) continue;
    assignShared(members, uniqueName(members[0].type), true);
  }
  for (const members of markupGroups.values()) {
    const fresh = members.filter((m) => !m.componentId);
    if (new Set(fresh.map((m) => m.pageId)).size < 2) continue;
    assignShared(fresh, uniqueName(fresh[0].type), false);
  }
  for (const inst of instances) {
    if (inst.componentId) continue;
    inst.componentId = `pages/${inst.pageId}/${inst.localId}`;
    inst.contentRef = 'page';
    inst.sharedWith = [inst.pageId];
  }

  // 8. Write template files.
  cpSync(RUNTIME_DIR, templateDir, { recursive: true, filter: (src) => !src.endsWith('README.md') });
  const writtenComponents = new Set();
  for (const inst of instances) {
    if (writtenComponents.has(inst.componentId)) continue;
    writtenComponents.add(inst.componentId);
    writeText(join(templateDir, 'components', `${inst.componentId}.html`), inst.markup + '\n');
  }
  writeJson(join(templateDir, 'content/shared.json'), shared);

  const formsConfig = {};
  for (const p of pages) {
    const $ = docs.get(p.id);
    const title = $('title').first();
    const pageContent = { title: brandify(title.text().trim()), description: brandify($('meta[name="description"]').attr('content') || '') };
    if (title.length) title.text('{{@ page.title}}');
    const desc = $('meta[name="description"]');
    if (desc.length) desc.attr('content', '{{@ page.description}}');
    if (brand.favicon) $('link[rel~="icon"]').each((_, l) => {
      if ($(l).attr('href') === `{{@root}}${brand.favicon.slice(1)}`) $(l).attr('href', '{{@brandurl brand.favicon}}');
    });
    const head = $('head');
    const charset = head.find('meta[charset]').first();
    if (charset.length) charset.after('\n{{@head-start}}\n');
    else head.prepend('{{@head-start}}\n');
    head.append('{{@head-end}}\n');
    writeText(join(templateDir, 'layouts', `${p.id}.html`), $.html());

    const own = instances.filter((i) => i.pageId === p.id);
    const sections = {};
    for (const inst of own) {
      if (inst.contentRef === 'page') sections[inst.localId] = inst.fields;
      else if (inst.overrides) sections[inst.localId] = inst.overrides;
    }
    writeJson(join(templateDir, 'content/pages', `${p.id}.json`), { page: pageContent, sections });
    writeJson(join(templateDir, 'pages', `${p.id}.json`), {
      id: p.id,
      route: p.route,
      sourceUrl: p.finalUrl,
      layout: `layouts/${p.id}.html`,
      sections: own.map((i) => ({ id: i.sectionId, localId: i.localId, type: i.type, component: i.componentId, content: i.contentRef })),
    });
    for (const f of report.pages[p.id].disabledForms) formsConfig[f.id] = { action: '', method: f.method === 'get' ? 'get' : 'post', originalAction: f.originalAction, page: p.id };
    p.templateStatus = 'templatised';
    p.localPath = `template/dist/${p.route}`;
  }

  const entryOrigin = new URL(job.url).origin;
  const blockedEndpoints = [...new Set(pages.flatMap((p) => (p.operationalRequests || []).filter((u) => u.startsWith(entryOrigin)).map((u) => new URL(u).pathname)))];
  const siteConfig = {
    $schema: 'Edit these values and run `npm run build`. Every key below is wired into the generated pages.',
    brand,
    colors: tokens.config.colors,
    fonts: tokens.config.fonts,
    typography: tokens.config.typography,
    images,
    integrations: {
      allowedOrigins: [],
      blockedEndpoints,
      analytics: { enabled: false, headHtml: '', removedFromReference: [...new Set(Object.values(report.pages).flatMap((r) => r.removedTrackers.map((t) => t.vendor)))] },
      forms: formsConfig,
    },
  };
  writeJson(join(templateDir, 'site.config.json'), siteConfig);
  writeJson(join(templateDir, 'site.config.reference.json'), {
    note: 'Initial values captured from the reference site (read-only copy for comparison).',
    ...siteConfig,
  });

  // 9. Build dist/ so the template is runnable immediately.
  const built = buildSite({ root: templateDir });

  const sectionInventory = instances.map((i) => ({
    sectionId: i.sectionId,
    page: i.pageId,
    pageUrl: i.page.finalUrl,
    order: i.index + 1,
    type: i.type,
    classification: i.reasons,
    sourceSelector: i.selector,
    component: `components/${i.componentId}.html`,
    shared: i.contentRef !== 'page',
    sharedName: i.sharedName || null,
    variant: i.variant || null,
    sharedWithPages: i.sharedWith,
    content: i.contentRef === 'page' ? `content/pages/${i.pageId}.json#/sections/${i.localId}` : `content/shared.json#/${i.contentRef.slice(7).replace('.', '/')}`,
    contentOverrides: i.overrides ? `content/pages/${i.pageId}.json#/sections/${i.localId}` : null,
    editableFields: fieldPaths(i.fields),
    assets: [...new Set([...collectImageSrcs(i.fields), ...[...i.markup.matchAll(/\{\{@root\}\}(assets\/[^"'\s)]+)/g)].map((m) => '/' + m[1])])],
    brandTokens: { configReferences: [...new Set([...JSON.stringify(i.fields).matchAll(/\{\{((brand|images)\.[\w.-]+)\}\}/g)].map((m) => m[1]).concat(i.markup.includes('{{@brandurl brand.logo.src}}') ? ['brand.logo'] : []))], cssVariables: [] },
    interactionDependencies: i.interactions,
    unsupported: i.unsupported,
    notes: i.notes || [],
    processingStatus: i.status,
    verificationStatus: 'pending',
  }));

  return {
    templateDir,
    distDir: built.outDir,
    pages: pages.map((p) => ({ id: p.id, route: p.route, sourceUrl: p.finalUrl, templateSource: p.templateSource, screenshots: p.screenshots })),
    sections: sectionInventory,
    brand: siteConfig,
    tokens: tokens.config,
    tokenUseByAsset: Object.fromEntries([...tokenUseByAsset].map(([k, v]) => [k, [...v]])),
    report,
  };
}


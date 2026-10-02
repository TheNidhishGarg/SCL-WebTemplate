// Verification stage. The generated template is untrusted: it is served from its own preview
// origin (separate port, no cookies, no application credentials) and loaded in a fresh browser
// context without extensions. Every non-local request is blocked and recorded.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { createPreviewServer } from './template-runtime/serve.mjs';
import { buildSite } from './template-runtime/build.mjs';
import { VIEWPORTS } from '../../extension/src/shared/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return h.length === 8 ? `rgba(${r}, ${g}, ${b}, ${Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000})` : `rgb(${r}, ${g}, ${b})`;
};

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
}

function comparePng(sourceFile, templateBuf, diffFile) {
  if (!sourceFile || !existsSync(sourceFile)) return { compared: false, reason: 'no source screenshot' };
  const a = PNG.sync.read(readFileSync(sourceFile));
  const b = PNG.sync.read(templateBuf);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const crop = (img) => {
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y++) img.data.copy(out.data, y * width * 4, y * img.width * 4, y * img.width * 4 + width * 4);
    return out;
  };
  const ca = crop(a);
  const cb = crop(b);
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(ca.data, cb.data, diff.data, width, height, { threshold: 0.1 });
  writeFileSync(diffFile, PNG.sync.write(diff));
  return {
    compared: true,
    width,
    height,
    sourceHeight: a.height,
    templateHeight: b.height,
    heightDelta: b.height - a.height,
    mismatchedPixels: mismatched,
    mismatchRatio: Math.round((mismatched / (width * height)) * 10000) / 10000,
  };
}

async function openPage(browser, previewOrigin, url, viewport, timeoutMs) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const log = { external: [], localFailures: [], consoleErrors: [], pageErrors: [], blockedByGuard: [] };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(previewOrigin) || u.startsWith('data:') || u.startsWith('blob:')) return req.continue();
    log.external.push({ url: u, type: req.resourceType() });
    return req.abort('blockedbyclient');
  });
  page.on('console', (m) => {
    if (m.type() === 'error') log.consoleErrors.push(m.text());
    if (m.type() === 'info' && m.text().startsWith('[template] blocked')) log.blockedByGuard.push(m.text());
  });
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  page.on('response', (r) => {
    if (r.url().startsWith(previewOrigin) && r.status() >= 400) log.localFailures.push({ url: r.url(), status: r.status() });
  });
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(previewOrigin)) log.localFailures.push({ url: r.url(), error: r.failure()?.errorText });
  });
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, isMobile: viewport.mobile, hasTouch: viewport.mobile });
  let response = null;
  let loadError = null;
  try {
    response = await page.goto(url, { waitUntil: 'networkidle0', timeout: timeoutMs });
  } catch (e) {
    loadError = e.message;
  }
  return { context, page, log, response, loadError };
}

function classifyConsole(log) {
  const blockedRe = /Blocked by template runtime|Content Security Policy|ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/;
  const all = [...log.consoleErrors, ...log.pageErrors];
  return { errors: all.filter((e) => !blockedRe.test(e)), blockedDependencyMessages: all.filter((e) => blockedRe.test(e)) };
}

async function sectionProbe(page, colorTokens, fontTokens) {
  return page.evaluate(
    (colorTokens, fontTokens) => {
      const norm = (f) => f.replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim().toLowerCase();
      const fontMap = Object.fromEntries(Object.entries(fontTokens).map(([k, v]) => [norm(v), k]));
      return [...document.querySelectorAll('[data-sar-section]')].map((el) => {
        const rect = el.getBoundingClientRect();
        const used = new Set();
        const nodes = [el, ...el.querySelectorAll('*')].slice(0, 400);
        for (const n of nodes) {
          const cs = getComputedStyle(n);
          for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor']) {
            for (const [name, rgb] of Object.entries(colorTokens)) if (cs[prop] === rgb) used.add(`color-${name}`);
          }
          const f = fontMap[norm(cs.fontFamily)];
          if (f) used.add(`font-${f}`);
        }
        return { id: el.dataset.sarSection, type: el.dataset.sarType, height: Math.round(rect.height), visible: rect.height > 0 && getComputedStyle(el).display !== 'none', text: el.innerText.slice(0, 5000), tokens: [...used] };
      });
    },
    colorTokens,
    fontTokens
  );
}

/** Same incremental scroll as the capture, so lazy-loaded media is present for comparison. */
async function scrollThrough(page) {
  await page
    .evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let y = 0, i = 0; y <= document.documentElement.scrollHeight && i < 40; y += Math.max(200, Math.floor(innerHeight * 0.8)), i++) {
        window.scrollTo(0, y);
        await wait(150);
      }
      window.scrollTo(0, 0);
      await wait(150);
    })
    .catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
}

function routeExists(distDir, pathname) {
  let p = join(distDir, decodeURIComponent(pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  return existsSync(p);
}

export async function verifyTemplate({ outDir, manifest, templ, job, options = {} }) {
  const puppeteer = (await import('puppeteer')).default;
  const timeoutMs = options.pageTimeoutMs || 30_000;
  const verDir = join(outDir, 'verification');
  mkdirSync(join(verDir, 'screenshots'), { recursive: true });
  const config = JSON.parse(readFileSync(join(templ.templateDir, 'site.config.json'), 'utf8'));
  const colorTokens = Object.fromEntries(Object.entries(config.colors).map(([k, v]) => [k, hexToRgb(v.value)]));
  const fontTokens = Object.fromEntries(Object.entries(config.fonts).map(([k, v]) => [k, v.family]));

  const launch = () => puppeteer.launch({ headless: options.headless !== false, args: ['--no-first-run', '--disable-extensions'] });
  let browser = await launch();
  const server = createPreviewServer(templ.distDir);
  const previewOrigin = await listen(server);
  const pagesOut = [];
  const sectionResults = new Map();
  const checks = [];
  try {
    for (const p of templ.pages.slice(0, options.maxPages || 50)) {
      try {
      const url = `${previewOrigin}/${p.route}`;
      const result = { page: p.id, route: p.route, url: `/${p.route}`, checks: {} };
      // Desktop.
      const d = await openPage(browser, previewOrigin, url, VIEWPORTS.desktop, timeoutMs);
      result.checks.load = { passed: !d.loadError && d.response?.status() === 200, status: d.response?.status() ?? null, error: d.loadError };
      await sleep(300);
      const probe = await sectionProbe(d.page, colorTokens, fontTokens).catch(() => []);
      for (const s of probe) sectionResults.set(s.id, { ...s, page: p.id });
      const expected = templ.sections.filter((s) => s.page === p.id).map((s) => s.sectionId);
      const present = new Set(probe.map((s) => s.id));
      result.checks.sections = { passed: expected.every((id) => present.has(id)), expected: expected.length, rendered: probe.length, missing: expected.filter((id) => !present.has(id)) };

      const links = await d.page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.href, uncaptured: a.hasAttribute('data-sar-uncaptured') }))).catch(() => []);
      const local = links.filter((l) => l.href.startsWith(previewOrigin));
      const internal = [...new Set(local.filter((l) => !l.uncaptured).map((l) => new URL(l.href).pathname))];
      const uncapturedTargets = [...new Set(local.filter((l) => l.uncaptured).map((l) => new URL(l.href).pathname))];
      const broken = internal.filter((path) => !routeExists(templ.distDir, path));
      result.checks.internalNavigation = { passed: broken.length === 0, internalLinks: internal.length, broken, uncapturedTargets };
      // Follow the first internal link to confirm navigation works in the browser.
      const nextLink = internal.find((x) => x !== `/${p.route}` && x.endsWith('.html'));
      if (nextLink) {
        const nav = await d.page.goto(`${previewOrigin}${nextLink}`, { waitUntil: 'load', timeout: timeoutMs }).catch((e) => ({ error: e.message }));
        result.checks.internalNavigation.followed = { path: nextLink, status: nav?.status?.() ?? null, error: nav?.error || null };
        await d.page.goto(url, { waitUntil: 'networkidle0', timeout: timeoutMs }).catch(() => {});
      }

      result.checks.resources = { passed: d.log.localFailures.length === 0, localFailures: d.log.localFailures };
      result.checks.externalRequests = { passed: d.log.external.length === 0, blocked: d.log.external };
      const consoleD = classifyConsole(d.log);
      result.checks.console = { passed: consoleD.errors.length === 0, errors: consoleD.errors, blockedDependencyMessages: consoleD.blockedDependencyMessages };

      // Screenshots and comparison (desktop).
      const shot = async (pg, vp, name) => {
        await scrollThrough(pg);
        const h = await pg.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)).catch(() => vp.height);
        await pg.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        const height = Math.min(Math.max(h, vp.height), job.options.maxScreenshotHeight || 8000);
        const buf = await pg.screenshot({ clip: { x: 0, y: 0, width: vp.width, height }, captureBeyondViewport: true });
        const file = join(verDir, 'screenshots', `${p.id}-${name}.png`);
        writeFileSync(file, buf);
        const src = p.screenshots?.[name]?.path ? join(outDir, p.screenshots[name].path) : null;
        return { template: `verification/screenshots/${p.id}-${name}.png`, source: p.screenshots?.[name]?.path || null, ...comparePng(src, buf, join(verDir, 'screenshots', `${p.id}-${name}.diff.png`)), diff: `verification/screenshots/${p.id}-${name}.diff.png` };
      };
      result.checks.desktopRendering = await shot(d.page, VIEWPORTS.desktop, 'desktop').catch((e) => ({ compared: false, error: e.message }));

      // Interactions: form guard, disclosure widgets, configured recipes.
      const interactions = await d.page.evaluate(async () => {
        const out = { forms: [], details: [] };
        for (const f of document.querySelectorAll('form[data-sar-form]')) {
          const ev = new Event('submit', { bubbles: true, cancelable: true });
          f.dispatchEvent(ev);
          out.forms.push({ id: f.dataset.sarForm, blocked: ev.defaultPrevented && f.hasAttribute('data-sar-submit-blocked'), configured: f.hasAttribute('action') });
        }
        for (const det of [...document.querySelectorAll('details')].slice(0, 5)) {
          const s = det.querySelector('summary');
          const before = det.open;
          s?.click();
          await new Promise((r) => setTimeout(r, 50));
          out.details.push({ toggled: det.open !== before });
        }
        out.guardBlocked = (window.__SAR_BLOCKED__ || []).slice(0, 50);
        return out;
      }).catch((e) => ({ error: e.message }));
      const recipes = [];
      for (const r of job.options.interactionRecipes || []) {
        if (r.urlPattern && !new RegExp(r.urlPattern).test(p.sourceUrl)) continue;
        const errsBefore = d.log.pageErrors.length;
        const ok = await d.page.evaluate((sel, action) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          if (action === 'click') el.click();
          else if (action === 'hover') el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          else el.focus();
          return true;
        }, r.selector, r.action).catch(() => false);
        await sleep(r.waitMs || 300);
        recipes.push({ selector: r.selector, action: r.action, found: ok, noErrors: d.log.pageErrors.length === errsBefore });
      }
      result.checks.interactions = {
        passed: !interactions.error && (interactions.forms || []).every((f) => f.blocked || f.configured) && (interactions.details || []).every((x) => x.toggled) && recipes.every((r) => r.found && r.noErrors),
        ...interactions,
        recipes,
      };

      // Mobile: switch emulation in place, exactly as the capture did (no reload), then compare.
      const errorsBefore = d.log.consoleErrors.length + d.log.pageErrors.length;
      await d.page.goto(url, { waitUntil: 'networkidle0', timeout: timeoutMs }).catch(() => {});
      const mv = VIEWPORTS.mobile;
      await d.page.setViewport({ width: mv.width, height: mv.height, deviceScaleFactor: mv.deviceScaleFactor, isMobile: true, hasTouch: true });
      await sleep(600);
      result.checks.mobileRendering = await shot(d.page, mv, 'mobile').catch((e) => ({ compared: false, error: e.message }));
      result.checks.mobileRendering.consoleErrors = classifyConsole({ consoleErrors: d.log.consoleErrors.slice(errorsBefore), pageErrors: [] }).errors;
      await d.context.close().catch(() => {});
      for (const k of ['desktopRendering', 'mobileRendering']) {
        const c = result.checks[k];
        c.passed = c.compared ? c.mismatchRatio <= (options.maxMismatchRatio ?? 0.15) : false;
      }
      result.passed = Object.values(result.checks).every((c) => c.passed !== false);
      pagesOut.push(result);
      } catch (e) {
        // One page's failure (or a browser crash) must not abort verification of the others.
        pagesOut.push({ page: p.id, route: p.route, url: `/${p.route}`, passed: false, checks: { harness: { passed: false, error: e.message } } });
        if (!browser.connected) browser = await launch();
      }
    }

    // Configuration change test on a copy of the template.
    const configChange = await configChangeTest({ templ, verDir, browser, timeoutMs, colorTokens });
    checks.push(configChange);

    for (const s of templ.sections) {
      const r = sectionResults.get(s.sectionId);
      s.brandTokens.cssVariables = r ? r.tokens : [];
      if (!r) s.verificationStatus = 'missing_in_output';
      else if (!r.visible) s.verificationStatus = 'rendered_hidden';
      else s.verificationStatus = 'rendered';
      const edit = configChange.sectionEdits.find((e) => e.sectionId === s.sectionId || e.affects?.includes(s.sectionId));
      if (edit) s.configEditVerified = edit.passed;
    }
    return { previewIsolation: { previewOrigin: 'separate 127.0.0.1 port', browserContext: 'fresh incognito context per page, no extensions, no cookies', externalRequests: 'blocked and recorded' }, pages: pagesOut, configChange };
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

async function configChangeTest({ templ, verDir, browser, timeoutMs, colorTokens }) {
  const work = join(verDir, 'config-change-test');
  rmSync(work, { recursive: true, force: true });
  cpSync(templ.templateDir, work, { recursive: true, filter: (src) => !src.includes(`${join(templ.templateDir, 'dist')}`) });
  const cfgPath = join(work, 'site.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const result = { performed: [], sectionEdits: [], pages: [], passed: true };

  const colorKey = cfg.colors.primary ? 'primary' : Object.keys(cfg.colors)[0];
  const NEW_COLOR = '#d6336c';
  if (colorKey) {
    result.performed.push({ change: `colors.${colorKey}`, from: cfg.colors[colorKey].value, to: NEW_COLOR });
    cfg.colors[colorKey].value = NEW_COLOR;
  }
  const NEW_NAME = 'Config Test Brand';
  result.performed.push({ change: 'brand.name', from: cfg.brand.name, to: NEW_NAME });
  cfg.brand.name = NEW_NAME;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // One page-specific text field per page, and one shared field (nested fields and variants included).
  const firstString = (value, path = []) => {
    if (typeof value === 'string') return value.trim() && !value.includes('<') && !value.includes('{{') && !/^(\/|https?:|mailto:|tel:)/.test(value) ? path : null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const r = firstString(value[i], [...path, i]);
        if (r) return r;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (['href', 'src', 'srcset', 'lazySrc', 'poster'].includes(k)) continue;
        const r = firstString(v, [...path, k]);
        if (r) return r;
      }
    }
    return null;
  };
  const setPath = (obj, path, value) => {
    let o = obj;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]] = value;
  };
  let marker = 0;
  const nextMarker = () => `SAR-EDIT-${++marker}-X`;
  const pageContent = new Map();
  for (const page of templ.pages) {
    const file = join(work, 'content/pages', `${page.id}.json`);
    const content = JSON.parse(readFileSync(file, 'utf8'));
    pageContent.set(page.id, content);
    const def = JSON.parse(readFileSync(join(work, 'pages', `${page.id}.json`), 'utf8'));
    const target = def.sections.find((s) => s.content === 'page' && firstString(content.sections[s.localId]));
    if (!target) continue;
    const path = firstString(content.sections[target.localId]);
    const value = nextMarker();
    setPath(content.sections[target.localId], path, value);
    writeFileSync(file, JSON.stringify(content, null, 2));
    result.sectionEdits.push({ kind: 'page-section', sectionId: target.id, page: page.id, field: path.join('.'), value, expectOn: [page.id] });
  }
  const sharedFile = join(work, 'content/shared.json');
  const shared = JSON.parse(readFileSync(sharedFile, 'utf8'));
  outer: for (const [name, val] of Object.entries(shared)) {
    const isVariants = val && typeof val === 'object' && Object.keys(val).length && Object.keys(val).every((k) => /^v\d+$/.test(k));
    for (const [variant, holder] of isVariants ? Object.entries(val) : [[null, val]]) {
      const path = firstString(holder);
      if (!path) continue;
      const users = templ.sections.filter((s) => s.sharedName === name && (s.variant || null) === variant);
      const value = nextMarker();
      setPath(holder, path, value);
      writeFileSync(sharedFile, JSON.stringify(shared, null, 2));
      // Pages that override this top-level field keep their own value by design.
      const visible = users.filter((u) => !(pageContent.get(u.page)?.sections?.[u.sectionId.split('/')[1]] || {})[path[0]]);
      result.sectionEdits.push({ kind: 'shared-section', sharedName: name, variant, field: path.join('.'), value, affects: users.map((u) => u.sectionId), expectOn: [...new Set(visible.map((u) => u.page))] });
      break outer;
    }
  }

  buildSite({ root: work });
  const server = createPreviewServer(join(work, 'dist'));
  const origin = await listen(server);
  try {
    for (const page of templ.pages) {
      const { context, page: pg } = await openPage(browser, origin, `${origin}/${page.route}`, VIEWPORTS.desktop, timeoutMs);
      const info = await pg.evaluate((colorKey) => {
        // textContent (not innerText): edits to responsive/hidden elements (e.g. a mobile menu button) still count.
        const sections = Object.fromEntries([...document.querySelectorAll('[data-sar-section]')].map((e) => [e.dataset.sarSection, e.textContent]));
        const varValue = colorKey ? getComputedStyle(document.documentElement).getPropertyValue(`--sar-color-${colorKey}`).trim() : null;
        let painted = 0;
        for (const n of document.querySelectorAll('*')) {
          const cs = getComputedStyle(n);
          if ([cs.color, cs.backgroundColor, cs.borderTopColor].includes('rgb(214, 51, 108)')) painted++;
        }
        return { sections, varValue, painted, title: document.title, body: document.body.innerText, html: document.documentElement.outerHTML.length };
      }, colorKey);
      const pageRes = { page: page.id, colorVariable: info.varValue, elementsUsingNewColor: info.painted, title: info.title };
      pageRes.colorPassed = !colorKey || (info.varValue.toLowerCase() === NEW_COLOR && (info.painted > 0 || !colorTokens[colorKey]));
      pageRes.brandNameApplied = info.title.includes(NEW_NAME) || info.body.includes(NEW_NAME) || info.sections && Object.values(info.sections).some((t) => t.includes(NEW_NAME));
      for (const edit of result.sectionEdits) {
        const shouldAppear = edit.expectOn.includes(page.id);
        const ids = edit.kind === 'page-section' ? [edit.sectionId] : edit.affects.filter((id) => id.startsWith(`${page.id}/`));
        const appearsInTarget = ids.some((id) => (info.sections[id] || '').includes(edit.value));
        const leaked = Object.entries(info.sections).some(([id, text]) => !ids.includes(id) && text.includes(edit.value));
        edit.results = edit.results || [];
        edit.results.push({ page: page.id, shouldAppear, appearsInTarget, leakedElsewhere: leaked });
      }
      result.pages.push(pageRes);
      await context.close().catch(() => {});
    }
  } finally {
    server.close();
  }
  for (const edit of result.sectionEdits) {
    edit.passed = edit.results.every((r) => (r.shouldAppear ? r.appearsInTarget : !r.appearsInTarget) && !r.leakedElsewhere);
    if (!edit.passed) edit.note = 'edit did not render where expected — the section may be re-rendered by captured JavaScript';
  }
  result.colorPassed = result.pages.every((p) => p.colorPassed);
  result.brandNamePassed = result.pages.some((p) => p.brandNameApplied);
  result.passed = result.colorPassed && result.brandNamePassed && result.sectionEdits.every((e) => e.passed);
  rmSync(work, { recursive: true, force: true });
  return result;
}

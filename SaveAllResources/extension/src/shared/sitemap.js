// Minimal sitemap / robots.txt parsing. Service workers have no DOMParser, so this is a small
// streaming XML tokenizer that understands elements, CDATA, comments and entities — enough for
// <urlset>/<sitemapindex> documents.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Returns { type: 'urlset' | 'sitemapindex' | 'unknown', locs: string[] } */
export function parseSitemap(xml, maxUrls = 50_000) {
  const stack = [];
  const locs = [];
  let root = null;
  let text = '';
  let i = 0;
  while (i < xml.length && locs.length < maxUrls) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (stack.length && stack[stack.length - 1] === 'loc') text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (stack[stack.length - 1] === 'loc') text += xml.slice(lt + 9, end === -1 ? xml.length : end);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt);
      i = end === -1 ? xml.length : end + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) break;
    const raw = xml.slice(lt + 1, gt);
    const closing = raw.startsWith('/');
    const selfClosing = raw.endsWith('/');
    const name = raw.replace(/^\//, '').split(/[\s/]/)[0].replace(/^.*:/, '').toLowerCase();
    if (closing) {
      if (name === 'loc' && stack[stack.length - 1] === 'loc') {
        const value = text.trim();
        if (value) locs.push(value);
        text = '';
      }
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.length = idx;
    } else if (!selfClosing) {
      if (!root) root = name;
      stack.push(name);
      if (name === 'loc') text = '';
    }
    i = gt + 1;
  }
  return { type: root === 'urlset' || root === 'sitemapindex' ? root : 'unknown', locs };
}

/** Parse robots.txt for the `*` group (or a group naming our agent) and Sitemap lines. */
export function parseRobots(txt, agent = 'saveallresources') {
  const sitemaps = [];
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean) continue;
    const m = clean.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', path: value });
  }
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && agent.includes(a))) || groups.find((g) => g.agents.includes('*'));
  return { sitemaps, rules: group ? group.rules.filter((r) => r.path !== '' || r.allow) : [] };
}

function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/** Longest-match semantics (RFC 9309). */
export function isAllowedByRobots(rules, url) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    if (ruleMatches(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

// Reproducible fixture website used by unit and end-to-end tests.
// Static pages live in ./site; dynamic routes cover redirects, access control, query variants,
// crawl traps, an operational API, a never-finishing page and generated images.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const SITE = join(fileURLToPath(new URL('.', import.meta.url)), 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain' };

const IMAGES = {
  'hero-640': [640, 400, [11, 61, 92]],
  'hero-1280': [1280, 800, [11, 61, 92]],
  'icon-design': [48, 48, [242, 165, 65]],
  'icon-build': [48, 48, [11, 61, 92]],
  'icon-grow': [48, 48, [29, 36, 51]],
  'icon-bg': [8, 8, [245, 247, 250]],
  'bg-dots': [8, 8, [230, 235, 240]],
  'plan-bg': [32, 32, [242, 165, 65]],
  'team-1': [200, 200, [180, 120, 90]],
  'team-2': [200, 200, [90, 120, 180]],
  'team-3': [200, 200, [120, 180, 90]],
  'team-4': [200, 200, [180, 90, 150]],
  'work-1': [600, 400, [200, 80, 60]],
  'work-2': [600, 400, [60, 140, 200]],
  'work-3': [600, 400, [90, 170, 110]],
  'work-4': [600, 400, [170, 110, 190]],
  favicon: [32, 32, [242, 165, 65]],
};

const pngCache = new Map();
function png(name) {
  if (!pngCache.has(name)) {
    const [w, h, [r, g, b]] = IMAGES[name];
    const img = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (w * y + x) << 2;
        const stripe = ((x >> 4) + (y >> 4)) % 2 ? 18 : 0;
        img.data[i] = Math.min(255, r + stripe);
        img.data[i + 1] = Math.min(255, g + stripe);
        img.data[i + 2] = Math.min(255, b + stripe);
        img.data[i + 3] = 255;
      }
    pngCache.set(name, PNG.sync.write(img));
  }
  return pngCache.get(name);
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="32" viewBox="0 0 140 32"><rect width="32" height="32" rx="6" fill="#f2a541"/><text x="40" y="22" font-family="Georgia" font-size="16" fill="#ffffff">Northwind</text></svg>`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Northwind Studio</title><link rel="stylesheet" href="/css/site.css"></head><body><div id="app"><main><section class="page-intro"><h1>${title}</h1>${body}</section></main></div></body></html>`;
}

export function startFixtureServer({ port = 0, host = '127.0.0.1' } = {}) {
  const requests = [];
  const posts = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    requests.push({ method: req.method, path: p + url.search, ua: req.headers['user-agent'] || '' });
    if (req.method === 'POST') posts.push(p);
    const origin = `http://${req.headers.host}`;
    const reply = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...headers });
      res.end(body);
    };

    if (p === '/robots.txt') return reply(200, 'text/plain', `User-agent: *\nDisallow: /drafts/\nSitemap: ${origin}/sitemap.xml\n`);
    if (p === '/sitemap.xml') {
      const locs = ['/', '/about/', '/pricing.html', '/gallery.html', '/sitemap-only.html', '/drafts/secret.html', '/?utm_source=sitemap'];
      return reply(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${origin}${l.replace(/&/g, '&amp;')}</loc></url>`).join('')}</urlset>`);
    }
    if (p === '/old-pricing') return reply(301, 'text/plain', 'moved', { Location: '/pricing.html' });
    if (p.startsWith('/private')) return reply(403, 'text/html', page('Forbidden', '<p>Members only.</p>'));
    if (p === '/logout') return reply(200, 'text/html', page('Logged out', '<p>bye</p>'));
    if (p === '/api/newsletter-count') return reply(200, 'application/json', JSON.stringify({ count: 42 }));
    if (p === '/css/theme.css') {
      const v = url.searchParams.get('v');
      return reply(200, 'text/css', v === '2' ? `/* theme v2 */\n.page-intro { border-left: 6px solid #f2a541; }\n` : `/* theme v1 */\n.hero h1 { letter-spacing: -0.5px; }\n`);
    }
    if (p === '/blog/' || p === '/blog') {
      const n = Number(url.searchParams.get('page') || 1);
      const links = [`<a href="/blog/?page=${n + 1}">Older</a>`, `<a href="/blog/?page=${n + 1}&amp;sort=new">Older (new first)</a>`, `<a href="/blog/?page=${n}&amp;tag=a&amp;sort=x&amp;view=grid">Filtered</a>`, `<a href="/blog/post-1.html">Post 1</a>`];
      return reply(200, 'text/html', page(`Blog page ${n}`, `<ul>${links.map((l) => `<li>${l}</li>`).join('')}</ul>`));
    }
    if (p === '/blog/post-1.html') return reply(200, 'text/html', page('Post 1', '<p>First post.</p><p><a href="/">Home</a></p>'));
    const cal = p.match(/^\/calendar\/(\d{4})\/(\d{2})$/);
    if (cal) {
      const d = new Date(Date.UTC(+cal[1], +cal[2] - 1, 1));
      const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      const fmt = (x) => `/calendar/${x.getUTCFullYear()}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
      return reply(200, 'text/html', page(`Events ${cal[1]}-${cal[2]}`, `<a href="${fmt(prev)}">Previous</a> <a href="${fmt(next)}">Next</a>`));
    }
    if (p === '/sitemap-only.html') return reply(200, 'text/html', page('Sitemap only', '<p>Only discoverable via sitemap.</p>'));
    if (p === '/timeout-entry.html') return reply(200, 'text/html', page('Timeout entry', '<p><a href="/slow.html">Slow page</a> <a href="/about/">About</a></p>'));
    if (p === '/slow.html') return reply(200, 'text/html', page('Slow', '<img src="/never-ending.png" alt="never">'));
    if (p === '/never-ending.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.write(png('icon-bg').subarray(0, 20)); // never ends
      return;
    }
    if (p === '/img/logo.svg') return reply(200, 'image/svg+xml', LOGO);
    const img = p.match(/^\/img\/([a-z0-9-]+)\.png$/);
    if (img && IMAGES[img[1]]) return reply(200, 'image/png', png(img[1]));
    if (p === '/fonts/fixture-sans.woff2') return reply(200, 'font/woff2', Buffer.from('wOF2' + 'fixture-font-bytes'.repeat(8)));

    let file = normalize(join(SITE, decodeURIComponent(p)));
    if (!file.startsWith(SITE)) return reply(400, 'text/plain', 'bad path');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return reply(404, 'text/html', page('Not found', '<p>404</p>'));
    return reply(200, TYPES[extname(file)] || 'application/octet-stream', readFileSync(file));
  });
  return new Promise((r) =>
    server.listen(port, host, () => {
      const addr = server.address();
      r({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        requests,
        posts,
        close: () => new Promise((c) => { server.closeAllConnections?.(); server.close(() => c()); }),
      });
    })
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startFixtureServer({ port: Number(process.env.PORT || 4200) });
  console.log(`Fixture site on ${s.url}`);
}

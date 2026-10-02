// Local preview server for dist/. Binds to 127.0.0.1 only and never sets cookies.
// Usage: node serve.mjs [--port 8080] [--watch]   (--watch rebuilds when sources change)
import http from 'node:http';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from './build.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain',
};

export function createPreviewServer(distDir) {
  const root = resolve(distDir);
  return http.createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pi = process.argv.indexOf('--port');
  const port = pi > 0 ? Number(process.argv[pi + 1]) : 8080;
  if (!existsSync(join(here, 'dist'))) buildSite({ root: here });
  if (process.argv.includes('--watch')) {
    let timer;
    for (const dir of ['site.config.json', 'content', 'components', 'layouts', 'pages', 'assets']) {
      if (!existsSync(join(here, dir))) continue;
      watch(join(here, dir), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            buildSite({ root: here });
            console.log('rebuilt', new Date().toLocaleTimeString());
          } catch (e) {
            console.error('build failed:', e.message);
          }
        }, 150);
      });
    }
  }
  createPreviewServer(join(here, 'dist')).listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}/`));
}

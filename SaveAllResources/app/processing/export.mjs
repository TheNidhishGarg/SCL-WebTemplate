// Export stage: zip the website-template directory (raw capture, template, inventories, reports).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const STORE_ONLY = /\.(png|jpe?g|gif|webp|avif|woff2?|zip|mp4|webm|mp3|gz)$/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function exportPackage({ outDir, exportFile, rootName = 'website-template' }) {
  const files = {};
  for (const file of walk(outDir)) {
    const rel = relative(outDir, file).split('\\').join('/');
    files[`${rootName}/${rel}`] = [new Uint8Array(readFileSync(file)), { level: STORE_ONLY.test(rel) ? 0 : 6 }];
  }
  writeFileSync(exportFile, zipSync(files));
  return { exportFile, files: Object.keys(files).length };
}

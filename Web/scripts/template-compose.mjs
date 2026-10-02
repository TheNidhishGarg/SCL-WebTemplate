// Page composition for generated website templates. Written for Web; no
// SaveAllResources code is used here, and the template's own build (build.mjs)
// is left exactly as generated.
//
// A generated template renders layouts/<page>.html, whose {{@section <id>}}
// placeholders decide which sections a page shows and in what order. Web keeps
// that order as editable configuration instead:
//
//   composition/<page>.json             regions, and the ordered sections in each
//   composition/skeletons/<page>.html   the generated layout, with each region's
//                                       run of placeholders replaced by {{@region <id>}}
//   composition/frames/<page>/<x>.html  the wrapper of a split section (holds a {{@region}})
//
// and this script writes layouts/<page>.html from them. A region is a run of
// sections that were siblings inside one wrapper element, so reordering,
// duplicating or removing sections inside a region never changes the
// surrounding markup.
//
// Usage (also copied into every edited template as compose.mjs):
//   node compose.mjs [--dir <template folder>] && node build.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGION = /\{\{@region\s+([A-Za-z0-9_-]+)\s*\}\}/g;
const SAFE_FILE = /^composition\/frames\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.html$/;
const SAFE_LAYOUT = /^layouts\/[A-Za-z0-9_-]+\.html$/;

/**
 * Writes layouts/<page>.html for every page that has a composition.
 * @param {string} dir template folder
 * @returns {{ pages: string[], written: string[] }}
 */
export function composeTemplate(dir) {
  const root = resolve(dir);
  const compDir = join(root, 'composition');
  const out = { pages: [], written: [] };
  if (!existsSync(compDir)) return out;
  for (const file of readdirSync(compDir).filter((f) => f.endsWith('.json')).sort()) {
    const comp = JSON.parse(readFileSync(join(compDir, file), 'utf8'));
    const pageId = comp.page;
    const page = JSON.parse(readFileSync(join(root, 'pages', `${pageId}.json`), 'utf8'));
    if (!SAFE_LAYOUT.test(page.layout)) throw new Error(`page ${pageId}: unexpected layout path ${page.layout}`);
    const known = new Set((page.sections || []).map((s) => s.id));
    const used = new Set();

    const renderItem = (item, joiner) => {
      if (item.section) {
        if (!known.has(item.section)) throw new Error(`page ${pageId}: composition lists unknown section ${item.section}`);
        return `{{@section ${item.section}}}`;
      }
      if (item.group) return item.items.map((i) => renderItem(i, joiner)).join(joiner);
      if (item.frame) {
        if (!SAFE_FILE.test(item.file)) throw new Error(`page ${pageId}: unexpected frame path ${item.file}`);
        return readFileSync(join(root, item.file), 'utf8').replace(REGION, (_m, id) => renderRegion(id));
      }
      throw new Error(`page ${pageId}: unknown composition item ${JSON.stringify(item)}`);
    };
    const renderRegion = (id) => {
      const region = comp.regions[id];
      if (!region) throw new Error(`page ${pageId}: unknown region ${id}`);
      if (used.has(id)) throw new Error(`page ${pageId}: region ${id} is used twice`);
      used.add(id);
      // gaps: the whitespace between positions, as generated; joiner beyond them.
      const joiner = region.joiner ?? '';
      return region.items.map((i, n) => (n ? (region.gaps?.[n - 1] ?? joiner) : '') + renderItem(i, joiner)).join('');
    };

    const skeleton = readFileSync(join(root, 'composition', 'skeletons', `${pageId}.html`), 'utf8');
    const html = skeleton.replace(REGION, (_m, id) => renderRegion(id));
    const unused = Object.keys(comp.regions).filter((id) => !used.has(id));
    if (unused.length) throw new Error(`page ${pageId}: region(s) ${unused.join(', ')} are not in the page`);
    const target = resolve(root, page.layout);
    if (!target.startsWith(root + sep)) throw new Error(`page ${pageId}: layout outside the template`);
    const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (before !== html) {
      writeFileSync(target, html);
      out.written.push(page.layout);
    }
    out.pages.push(pageId);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 ? process.argv[i + 1] : dirname(fileURLToPath(import.meta.url));
  try {
    const { pages, written } = composeTemplate(dir);
    console.log(`Composed ${pages.length} page(s); ${written.length} layout(s) changed.`);
  } catch (e) {
    console.error(`compose failed: ${e.message}`);
    process.exit(1);
  }
}

// Field extraction: turns a section subtree into a component template (with {{@…}} tokens) and an
// editable content object. Repeated sibling structures become {{@each}} loops only when every
// item produces exactly the same template (verified by a dry run on clones).
import { parseSrcset, serializeSrcset } from './css.mjs';

const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'del', 'ins', 'font']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'canvas', 'select', 'object', 'embed', 'audio']);
const BASE_KEY = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  p: 'text', li: 'item', a: 'link', button: 'button', label: 'label', summary: 'summary', blockquote: 'quote', q: 'quote',
  figcaption: 'caption', cite: 'cite', dt: 'term', dd: 'definition', th: 'cell', td: 'cell', legend: 'legend', option: 'option',
};

const LOOP_KEY = { a: 'links', blockquote: 'quotes', details: 'questions', figure: 'figures', img: 'images', tr: 'rows', dt: 'terms' };

class Keyer {
  constructor() {
    this.counts = new Map();
  }
  next(base) {
    const n = (this.counts.get(base) || 0) + 1;
    this.counts.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  }
}

const isElement = (n) => n && n.type === 'tag';
const kids = (n) => n.children || [];
const elKids = (n) => kids(n).filter(isElement);
const hasText = (n) => kids(n).some((c) => c.type === 'text' && c.data.trim());

function allInline(node) {
  for (const c of kids(node)) {
    if (c.type === 'comment') continue;
    if (c.type === 'text') continue;
    if (!isElement(c) || !INLINE.has(c.name)) return false;
    if (!allInline(c)) return false;
  }
  return true;
}

function deepText(node) {
  let t = '';
  for (const c of kids(node)) {
    if (c.type === 'text') t += c.data;
    else if (isElement(c)) t += deepText(c);
  }
  return t;
}

/** Element whose content is phrasing-only text: becomes one text or rich-text field. */
function isTextBlock(node) {
  return deepText(node).trim().length > 0 && allInline(node);
}

function linkKey(node, $) {
  const cls = `${$(node).attr('class') || ''} ${$(node).attr('role') || ''}`;
  return /btn|button|cta/i.test(cls) ? 'cta' : 'link';
}

/** Site-root path for a template reference "{{@root}}assets/x" -> "/assets/x". */
const toSitePath = (v) => (typeof v === 'string' && v.startsWith('{{@root}}') ? '/' + v.slice('{{@root}}'.length) : v);
const srcsetToSite = (v) => serializeSrcset(parseSrcset(v).map((c) => ({ ...c, url: toSitePath(c.url) })));

export function createExtractor($, { onImage } = {}) {
  /** Plain/rich value for a text block. Rich HTML keeps inline markup with site-root URLs. */
  function blockValue(node) {
    const hasEl = elKids(node).length > 0;
    if (!hasEl) return { rich: false, value: deepText(node).replace(/\s+/g, ' ').trim() };
    const html = $(node)
      .html()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(href|src)="\{\{@root\}\}/g, '$1="/');
    return { rich: true, value: html };
  }

  function setTextToken(node, token) {
    const text = deepText(node);
    const lead = /^\s/.test(text) ? ' ' : '';
    const trail = /\s$/.test(text) ? ' ' : '';
    $(node).empty();
    $(node).append(`${lead}${token}${trail}`);
  }

  function imageField(node, keyer, fields) {
    const $n = $(node);
    if ($n.attr('data-sar-brand-logo') !== undefined) {
      $n.removeAttr('data-sar-brand-logo');
      $n.attr('src', '{{@brandurl brand.logo.src}}');
      if ($n.attr('alt') !== undefined) $n.attr('alt', '{{@brand brand.logo.alt}}');
      $n.removeAttr('srcset');
      return;
    }
    const key = keyer.next('image');
    const f = { src: toSitePath($n.attr('src') || '') };
    $n.attr('src', `{{@url ${key}.src}}`);
    if ($n.attr('alt') !== undefined) {
      f.alt = $n.attr('alt');
      $n.attr('alt', `{{@ ${key}.alt}}`);
    }
    if ($n.attr('srcset')) {
      f.srcset = srcsetToSite($n.attr('srcset'));
      $n.attr('srcset', `{{@srcset ${key}.srcset}}`);
    }
    for (const a of ['data-src', 'data-lazy-src']) {
      if ($n.attr(a)) {
        f.lazySrc = toSitePath($n.attr(a));
        $n.attr(a, `{{@url ${key}.lazySrc}}`);
      }
    }
    fields[key] = f;
    onImage?.(f.src);
  }

  /** Walk a subtree, replacing editable values with tokens. Returns fields object. */
  function extract(root, { keyer = new Keyer(), fields = {}, isRoot = true } = {}) {
    const walk = (node) => {
      if (!isElement(node) || SKIP.has(node.name)) return;
      const $n = $(node);
      if (node.name === 'img') return imageField(node, keyer, fields);
      if (node.name === 'source' && $n.attr('srcset')) {
        const key = keyer.next('image_source');
        fields[key] = { srcset: srcsetToSite($n.attr('srcset')) };
        $n.attr('srcset', `{{@srcset ${key}.srcset}}`);
        return;
      }
      if (node.name === 'video') {
        const key = keyer.next('video');
        const f = {};
        if ($n.attr('poster')) {
          f.poster = toSitePath($n.attr('poster'));
          $n.attr('poster', `{{@url ${key}.poster}}`);
        }
        if ($n.attr('src')) {
          f.src = toSitePath($n.attr('src'));
          $n.attr('src', `{{@url ${key}.src}}`);
        }
        if (Object.keys(f).length) fields[key] = f;
      }
      if ((node.name === 'input' || node.name === 'textarea') && $n.attr('placeholder')) {
        const key = keyer.next('placeholder');
        fields[key] = $n.attr('placeholder');
        $n.attr('placeholder', `{{@ ${key}}}`);
      }
      if (node.name === 'input' && /^(submit|button)$/i.test($n.attr('type') || '') && $n.attr('value')) {
        const key = keyer.next('button');
        fields[key] = $n.attr('value');
        $n.attr('value', `{{@ ${key}}}`);
        return;
      }
      if (node.name === 'input' || node.name === 'textarea') return;

      // A block whose only content is one link: edit the link (label + href), not raw HTML.
      if (node.name !== 'a' && !hasText(node) && elKids(node).length === 1 && elKids(node)[0].name === 'a' && allInline(node)) {
        walkChildren(node);
        return;
      }

      if (node.name === 'a' && $n.attr('href') !== undefined) {
        const key = keyer.next(linkKey(node, $));
        const f = { href: toSitePath($n.attr('href')) };
        $n.attr('href', `{{@url ${key}.href}}`);
        if (isTextBlock(node)) {
          const { rich, value } = blockValue(node);
          if (rich) {
            f.html = value;
            $n.html(`{{@html ${key}.html}}`);
          } else {
            f.label = value;
            setTextToken(node, `{{@ ${key}.label}}`);
          }
          fields[key] = f;
          return;
        }
        if ($n.attr('aria-label')) {
          f.ariaLabel = $n.attr('aria-label');
          $n.attr('aria-label', `{{@ ${key}.ariaLabel}}`);
        }
        fields[key] = f;
        walkChildren(node);
        return;
      }

      if (isTextBlock(node) && !(isRoot && node === root)) {
        const key = keyer.next(BASE_KEY[node.name] || 'text');
        const { rich, value } = blockValue(node);
        fields[key] = value;
        if (rich) $n.html(`{{@html ${key}}}`);
        else setTextToken(node, `{{@ ${key}}}`);
        return;
      }
      walkChildren(node);
    };

    // Children in order; runs of >= 2 consecutive same-tag siblings are tried as a loop.
    const walkChildren = (node) => {
      const children = [...kids(node)];
      let i = 0;
      while (i < children.length) {
        const c = children[i];
        if (isElement(c) && !SKIP.has(c.name)) {
          const run = [c];
          let k = i + 1;
          while (k < children.length) {
            const n = children[k];
            if (n.type === 'comment' || (n.type === 'text' && !n.data.trim())) k++;
            else if (isElement(n) && n.name === c.name) {
              run.push(n);
              k++;
            } else break;
          }
          if (run.length >= 2 && tryLoopRun(node, run, keyer, fields)) {
            i = k;
            continue;
          }
          walk(c);
          i++;
          continue;
        }
        walkChild(node, c);
        i++;
      }
    };

    const walkChild = (parent, c) => {
      if (c.type === 'text') {
        if (!c.data.trim()) return;
        const key = keyer.next(BASE_KEY[parent.name] || 'text');
        fields[key] = c.data.replace(/\s+/g, ' ').trim();
        const lead = /^\s/.test(c.data) ? ' ' : '';
        const trail = /\s$/.test(c.data) ? ' ' : '';
        $(c).replaceWith(`${lead}{{@ ${key}}}${trail}`);
      } else walk(c);
    };

    if (isElement(root) && isTextBlock(root) && isRoot) {
      // The whole section is one text block (e.g. a single paragraph).
      walkChildren(root);
    } else walk(root);
    return fields;
  }

  /** A run of same-tag siblings becomes a loop only if every item yields the identical template. */
  function tryLoopRun(parent, run, keyer, fields) {
    const items = [];
    let template = null;
    for (const el of run) {
      const clone = $(el).clone().get(0);
      const wrapper = $('<sar-loop-item></sar-loop-item>');
      wrapper.append(clone);
      const f = extract(clone, { keyer: new Keyer(), fields: {}, isRoot: false });
      if (!Object.keys(f).length) return false;
      const html = wrapper.html();
      if (template === null) template = html;
      else if (html !== template) return false;
      items.push(f);
    }
    const tag = run[0].name;
    const base = ['ul', 'ol', 'menu'].includes(parent.name) ? 'items' : LOOP_KEY[tag] || 'cards';
    const key = keyer.next(base);
    fields[key] = items;
    $(run[0]).before(`{{@each ${key}}}${template}{{@end}}`);
    for (const el of run) $(el).remove();
    return true;
  }

  return { extract };
}

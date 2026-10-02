// CSS handling with real parsers (postcss + postcss-value-parser):
//  - rewrite url() and @import references to local assets
//  - collect colour / font-family / heading size usage for brand tokens
//  - replace token values with var(--sar-…) references
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', navy: '#000080', teal: '#008080', orange: '#ffa500', purple: '#800080', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff',
};
const COLOR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|text-decoration-color|caret-color|column-rule-color|accent-color)$/i;

export function parseCss(css, from) {
  try {
    return { root: postcss.parse(css, { from }), error: null };
  } catch (e) {
    return { root: null, error: e.message };
  }
}

/** Canonical colour key (#rrggbb or #rrggbbaa) for hex / rgb() / hsl() / named colours. */
export function normalizeColor(node) {
  if (node.type === 'word') {
    const w = node.value.toLowerCase();
    if (NAMED[w]) return NAMED[w];
    const m = w.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (!m) return null;
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return h.length === 8 && h.endsWith('ff') ? `#${h.slice(0, 6)}` : `#${h}`;
  }
  if (node.type === 'function' && /^(rgba?|hsla?)$/i.test(node.value)) {
    const nums = node.nodes.filter((n) => n.type === 'word' && n.value !== '/').map((n) => n.value);
    if (nums.length < 3) return null;
    let r, g, b;
    const a = nums[3] !== undefined ? (nums[3].endsWith('%') ? parseFloat(nums[3]) / 100 : parseFloat(nums[3])) : 1;
    if (/^rgb/i.test(node.value)) {
      [r, g, b] = nums.slice(0, 3).map((v) => (v.endsWith('%') ? Math.round(parseFloat(v) * 2.55) : Math.round(parseFloat(v))));
    } else {
      const h = parseFloat(nums[0]) / 360;
      const s = parseFloat(nums[1]) / 100;
      const l = parseFloat(nums[2]) / 100;
      const hue = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      if (s === 0) r = g = b = Math.round(l * 255);
      else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        [r, g, b] = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((x) => Math.round(x * 255));
      }
    }
    if ([r, g, b, a].some((x) => Number.isNaN(x))) return null;
    const hex = (x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(Math.round(a * 255)) : ''}`;
  }
  return null;
}

export function saturation(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const HEADING_SELECTOR = /^(html|body|h[1-6])$/;

/** Accumulate brand-relevant usage statistics from a parsed stylesheet. */
export function collectStats(root, stats) {
  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    if (prop.startsWith('--')) return;
    if (COLOR_PROPS.test(prop)) {
      valueParser(decl.value).walk((node) => {
        const c = normalizeColor(node);
        if (c) {
          const s = stats.colors.get(c) || { count: 0, props: {} };
          s.count++;
          const bucket = /background/.test(prop) ? 'background' : prop === 'color' ? 'text' : 'other';
          s.props[bucket] = (s.props[bucket] || 0) + 1;
          stats.colors.set(c, s);
        }
        return node.type === 'function' && /^(rgba?|hsla?)$/i.test(node.value) ? false : undefined;
      });
    }
    if (prop === 'font-family') {
      const fam = decl.value.trim();
      const s = stats.fonts.get(fam) || { count: 0, selectors: new Set() };
      s.count++;
      if (decl.parent?.selector) s.selectors.add(decl.parent.selector);
      if (decl.parent?.type !== 'atrule') stats.fonts.set(fam, s);
    }
    if (prop === 'font-size' && decl.parent?.type === 'rule' && decl.parent.parent?.type === 'root') {
      for (const sel of decl.parent.selectors || []) {
        const s = sel.trim().toLowerCase();
        if (HEADING_SELECTOR.test(s) && !stats.sizes.has(s)) stats.sizes.set(s, decl.value.trim());
      }
    }
    if (prop === 'font-weight') stats.weights.add(decl.value.trim());
  });
}

export function newStats() {
  return { colors: new Map(), fonts: new Map(), sizes: new Map(), weights: new Set() };
}

/**
 * Rewrite url()/@import references and apply brand tokens.
 * @param resolve (absoluteUrl) => replacement string or null (keep absolute, report missing)
 * @param tokens { colors: Map(hex -> varName), fonts: Map(familyString -> varName), sizes: Map(selector -> varName) }
 */
export function transformCss(root, { baseUrl, resolve, tokens, onMissing, onTokenUse }) {
  const mapUrl = (raw) => {
    const v = raw.trim();
    if (!v || v.startsWith('data:') || v.startsWith('#') || v.startsWith('{{@')) return null;
    let abs;
    try {
      abs = new URL(v, baseUrl).href;
    } catch {
      return null;
    }
    const local = resolve(abs);
    if (local) return local;
    onMissing?.(abs);
    return abs === v ? null : abs; // make relative references absolute so they are not silently broken
  };

  root.walkAtRules('import', (rule) => {
    const parsed = valueParser(rule.params);
    const first = parsed.nodes.find((n) => n.type !== 'space');
    if (!first) return;
    if (first.type === 'string') {
      const next = mapUrl(first.value);
      if (next) first.value = next;
    } else if (first.type === 'function' && first.value.toLowerCase() === 'url') {
      const inner = first.nodes[0];
      if (inner) {
        const next = mapUrl(inner.value);
        if (next) {
          inner.value = next;
          inner.type = 'string';
          inner.quote = '"';
        }
      }
    }
    rule.params = parsed.toString();
  });

  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    let changed = false;
    const parsed = valueParser(decl.value);
    if (decl.value.includes('url(') || /image-set\(/i.test(decl.value)) {
      parsed.walk((node) => {
        if (node.type === 'function' && node.value.toLowerCase() === 'url') {
          const inner = node.nodes[0];
          if (inner) {
            const next = mapUrl(inner.value);
            if (next) {
              inner.value = next;
              if (inner.type === 'word') {
                inner.type = 'string';
                inner.quote = '"';
              }
              changed = true;
            }
          }
          return false;
        }
        if (node.type === 'function' && /image-set$/i.test(node.value)) {
          for (const n of node.nodes) {
            if (n.type === 'string') {
              const next = mapUrl(n.value);
              if (next) {
                n.value = next;
                changed = true;
              }
            }
          }
        }
        return undefined;
      });
    }
    if (tokens && !prop.startsWith('--')) {
      if (COLOR_PROPS.test(prop) && tokens.colors.size) {
        parsed.walk((node) => {
          const c = normalizeColor(node);
          if (c && tokens.colors.has(c)) {
            const name = tokens.colors.get(c);
            node.type = 'word';
            node.value = `var(--sar-color-${name})`;
            node.nodes = undefined;
            onTokenUse?.(`color-${name}`);
            changed = true;
            return false;
          }
          return node.type === 'function' && /^(rgba?|hsla?)$/i.test(node.value) ? false : undefined;
        });
      }
      if (prop === 'font-family' && decl.parent?.type !== 'atrule' && tokens.fonts.has(decl.value.trim())) {
        const name = tokens.fonts.get(decl.value.trim());
        decl.value = `var(--sar-font-${name})`;
        onTokenUse?.(`font-${name}`);
        return;
      }
      if (prop === 'font-size' && decl.parent?.type === 'rule' && decl.parent.parent?.type === 'root') {
        const sels = (decl.parent.selectors || []).map((s) => s.trim().toLowerCase());
        if (sels.length === 1 && tokens.sizes.has(sels[0])) {
          const name = tokens.sizes.get(sels[0]);
          decl.value = `var(--sar-${name})`;
          onTokenUse?.(name);
          return;
        }
      }
    }
    if (changed) decl.value = parsed.toString();
  });
  return root;
}

// ---- srcset ---------------------------------------------------------------------------------

/** Parse a srcset attribute per the HTML spec's candidate grammar (URLs may contain commas). */
export function parseSrcset(input) {
  const out = [];
  let i = 0;
  const s = String(input || '');
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      let depth = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) break;
        i++;
      }
      descriptor = s.slice(start, i).trim();
      i++;
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

export function serializeSrcset(candidates) {
  return candidates.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(', ');
}

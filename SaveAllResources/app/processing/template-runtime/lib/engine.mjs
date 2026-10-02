// Minimal, dependency-free template engine for the generated website template.
//
// Tokens (all start with "{{@" so they never clash with framework templates in captured markup):
//   {{@ path}}            escaped text from the section content
//   {{@html path}}        trusted rich HTML from the section content
//   {{@url path}}         URL; site-root paths ("/assets/x.png") become page-relative
//   {{@srcset path}}      srcset; each candidate URL is made page-relative
//   {{@brand path}}       escaped value from site.config.json
//   {{@brandurl path}}    URL from site.config.json, made page-relative
//   {{@each path}}…{{@end}}  repeat for every item of an array (item fields are in scope)
//   {{@root}}             relative prefix from the current page to the site root
//   {{@section id}}       (layouts) render a section component
//   {{@sectionid}}        id of the section instance being rendered
//   {{@head-start}} {{@head-end}}  generated head content (CSP, runtime guard, brand.css, integrations)
// Content values may reference configuration with {{brand.name}}, {{images.hero}}, … .

const TOKEN = /\{\{@([a-z-]*)(?:\s+([^}]*?))?\s*\}\}/g;

export function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

/** Replace {{config.path}} references inside content values. */
export function interpolate(value, config) {
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  return value.replace(/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g, (m, p) => {
    const v = getPath(config, p);
    return v == null || typeof v === 'object' ? m : String(v);
  });
}

export function relativizeUrl(url, root) {
  if (typeof url !== 'string') return url;
  if (url.startsWith('/') && !url.startsWith('//')) return root + url.slice(1);
  return url;
}

function relativizeSrcset(srcset, root) {
  return String(srcset)
    .split(/,(?=\s*\S)/)
    .map((c) => {
      const parts = c.trim().split(/\s+/);
      parts[0] = relativizeUrl(parts[0], root);
      return parts.join(' ');
    })
    .join(', ');
}

/** Root-relative href/src/srcset/poster/action attributes inside trusted rich HTML. */
function relativizeHtml(html, root) {
  return String(html).replace(/\s(href|src|poster|action)="(\/(?!\/)[^"]*)"/g, (m, a, v) => ` ${a}="${relativizeUrl(v, root)}"`);
}

export function parse(template) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ type: 'text', value: template.slice(last, m.index) });
    last = m.index + m[0].length;
    const [, name, arg = ''] = m;
    if (name === 'each') {
      const node = { type: 'each', path: arg.trim(), children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (name === 'end') {
      if (stack.length === 1) throw new Error(`unbalanced {{@end}} at offset ${m.index}`);
      stack.pop();
    } else {
      top.children.push({ type: 'tag', name, arg: arg.trim() });
    }
  }
  if (stack.length !== 1) throw new Error('unclosed {{@each}}');
  if (last < template.length) root.children.push({ type: 'text', value: template.slice(last) });
  return root;
}

/**
 * @param {string|object} template template string or parsed tree
 * @param {object} ctx { scope, config, root, sectionId, renderSection(id), head: {start, end} }
 */
export function render(template, ctx) {
  const tree = typeof template === 'string' ? parse(template) : template;
  return renderNodes(tree.children, ctx, ctx.scope || {});
}

function renderNodes(nodes, ctx, scope) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.value;
    else if (node.type === 'each') {
      const list = getPath(scope, node.path);
      if (Array.isArray(list)) for (const item of list) out += renderNodes(node.children, ctx, item ?? {});
    } else out += renderTag(node, ctx, scope);
  }
  return out;
}

function renderTag({ name, arg }, ctx, scope) {
  const cfg = ctx.config || {};
  const val = () => interpolate(getPath(scope, arg), cfg);
  switch (name) {
    case '':
      return escapeHtml(val());
    case 'html':
      return relativizeHtml(val() ?? '', ctx.root);
    case 'url':
      return escapeHtml(relativizeUrl(val() ?? '', ctx.root));
    case 'srcset':
      return escapeHtml(relativizeSrcset(val() ?? '', ctx.root));
    case 'brand':
      return escapeHtml(interpolate(getPath(cfg, arg), cfg) ?? '');
    case 'brandurl':
      return escapeHtml(relativizeUrl(interpolate(getPath(cfg, arg), cfg) ?? '', ctx.root));
    case 'root':
      return ctx.root;
    case 'sectionid':
      return escapeHtml(ctx.sectionId || '');
    case 'section':
      return ctx.renderSection(arg);
    case 'head-start':
      return ctx.head?.start || '';
    case 'head-end':
      return ctx.head?.end || '';
    default:
      throw new Error(`unknown template token {{@${name}}}`);
  }
}

export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object' || !base || !override) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

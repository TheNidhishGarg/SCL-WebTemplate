// Section inventory: find the meaningful top-level blocks of a page body and classify them.
// Every element-level child of the section container becomes a section, so no content is lost:
// blocks that cannot be classified are kept as "content".

const NON_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'base', 'title']);
const SEMANTIC = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form']);
const MEDIA = 'img,svg,video,picture,iframe,canvas,input,button,select,textarea,object,embed';
const WRAPPER_HINT = /(^|[\s_-])(wrap|wrapper|container|page|site|app|root|layout|content|main|inner|body)([\s_-]|$)/i;

const elementChildren = (el) => (el.children || []).filter((c) => c.type === 'tag' || c.type === 'script' || c.type === 'style');

export function isMeaningful($, el) {
  if (!el || el.type !== 'tag' || NON_CONTENT.has(el.name)) return false;
  const $el = $(el);
  if ($el.attr('hidden') !== undefined || $el.attr('aria-hidden') === 'true') {
    return $el.text().trim().length > 0; // hidden menus etc. still carry content
  }
  return $el.text().trim().length > 0 || $el.find(MEDIA).length > 0 || ['img', 'svg', 'video', 'picture', 'iframe', 'canvas', 'hr'].includes(el.name);
}

const meaningfulChildren = ($, el) => elementChildren(el).filter((c) => isMeaningful($, c));
const hint = ($, el) => `${$(el).attr('id') || ''} ${$(el).attr('class') || ''} ${$(el).attr('role') || ''}`.toLowerCase();

function shouldExpand($, el, depth) {
  if (depth > 4) return false;
  const kids = meaningfulChildren($, el);
  if (kids.length < 2) return false;
  if (el.name === 'main' || $(el).attr('role') === 'main') return true;
  if (!['div', 'span'].includes(el.name)) return false;
  const ownText = (el.children || []).some((c) => c.type === 'text' && c.data.trim());
  if (ownText) return false;
  const blockKids = kids.filter((k) => SEMANTIC.has(k.name) || /section|block|row|band|hero|footer|header/i.test(hint($, k)));
  return blockKids.length >= 2 || (WRAPPER_HINT.test(hint($, el)) && kids.length >= 3);
}

/** Returns an ordered list of section elements for the page body. */
export function findSections($) {
  const body = $('body').get(0);
  if (!body) return [];
  let container = body;
  for (let i = 0; i < 8; i++) {
    const kids = meaningfulChildren($, container);
    if (kids.length === 1 && !['header', 'nav', 'footer', 'section', 'article', 'form'].includes(kids[0].name)) container = kids[0];
    else break;
  }
  const out = [];
  const visit = (el, depth) => {
    for (const child of meaningfulChildren($, el)) {
      if (shouldExpand($, child, depth)) visit(child, depth + 1);
      else out.push(child);
    }
  };
  if (shouldExpand($, container, 0) || container === body || meaningfulChildren($, container).length > 1) visit(container, 0);
  else out.push(container);
  return out;
}

const CURRENCY = /[$€£¥₹]\s?\d|\d\s?(usd|eur|gbp|inr)\b/i;

/** Classify a section; returns { type, reasons[] }. */
export function classifySection($, el, { index, total, firstContentIndex }) {
  const $el = $(el);
  const h = hint($, el);
  const text = $el.text().replace(/\s+/g, ' ').trim();
  const reasons = [];
  const tag = el.name;
  const role = ($el.attr('role') || '').toLowerCase();
  const forms = $el.find('form').addBack('form');
  const inputs = forms.find('input:not([type=hidden]):not([type=submit]),textarea,select').length;
  const imgs = $el.find('img,picture').length;
  const headings = $el.find('h1,h2,h3,h4,h5,h6');

  if (tag === 'footer' || role === 'contentinfo' || /\bfooter\b/.test(h) || (index === total - 1 && /©|copyright/i.test(text))) {
    reasons.push(tag === 'footer' ? '<footer> element' : role === 'contentinfo' ? 'role=contentinfo' : /footer/.test(h) ? 'footer class/id' : 'last block with copyright');
    return { type: 'footer', reasons };
  }
  if (tag === 'nav' || tag === 'header' || role === 'navigation' || role === 'banner' || /\b(nav|navbar|header|topbar|menu|masthead)\b/.test(h)) {
    if (!(tag === 'header' && headings.filter('h1').length && $el.find('nav,[role=navigation]').length === 0 && index > 0)) {
      reasons.push(`${tag === 'nav' || tag === 'header' ? `<${tag}>` : role ? `role=${role}` : 'navigation class/id'}`);
      return { type: 'navigation', reasons };
    }
  }
  if (/\bfaq\b/.test(h) || $el.find('details > summary').length >= 2 || /frequently asked|\bfaq\b/i.test(headings.first().text())) {
    reasons.push('FAQ markers (details/summary or FAQ heading/class)');
    return { type: 'faq', reasons };
  }
  if (inputs >= 2 || (forms.length && inputs >= 1 && !/search/i.test(h + forms.attr('role')))) {
    reasons.push(`form with ${inputs} input(s)`);
    return { type: 'form', reasons };
  }
  if (/pric|plan/.test(h) || (text.match(new RegExp(CURRENCY, 'gi')) || []).length >= 2) {
    reasons.push('pricing class or several prices');
    return { type: 'pricing', reasons };
  }
  if (/testimonial|review|quote/.test(h) || $el.find('blockquote').length >= 2 || ($el.find('blockquote').length && $el.find('cite').length)) {
    reasons.push('testimonial class or quotations with attribution');
    return { type: 'testimonials', reasons };
  }
  if (/hero|banner|jumbotron|masthead|splash/.test(h) || (index === firstContentIndex && $el.find('h1').length)) {
    reasons.push(/hero|banner|jumbotron|masthead|splash/.test(h) ? 'hero class/id' : 'first content block with <h1>');
    return { type: 'hero', reasons };
  }
  if (/gallery|portfolio|carousel|slider|lightbox|team/.test(h) || (imgs >= 4 && text.length / imgs < 60)) {
    reasons.push('gallery class or image-dense block');
    return { type: 'gallery', reasons };
  }
  if (/card|feature|service|grid|tiles|benefit/.test(h) || $el.find('article').length >= 3 || $el.find('[class*=card]').length >= 3) {
    reasons.push('card/feature class or repeated articles');
    return { type: 'cards', reasons };
  }
  const buttons = $el.find('a.btn,a.button,button,a[class*=btn],a[class*=cta],[role=button]').length;
  if (/\bcta\b|call-to-action|signup|newsletter|subscribe/.test(h) || (text.length < 300 && headings.length >= 1 && buttons >= 1 && index > 0)) {
    reasons.push('call-to-action class or short heading + button');
    return { type: 'cta', reasons };
  }
  reasons.push('default classification');
  return { type: 'content', reasons };
}

/** Structural signature ignoring text and class/id values (used to group shared variants). */
export function structureSignature($, el) {
  const sig = (node) => {
    if (node.type !== 'tag') return '';
    return `${node.name}(${elementChildren(node).map(sig).join(',')})`;
  };
  return sig(el);
}

/** Interaction dependencies inside a section. */
export function interactionDependencies($, el) {
  const $el = $(el);
  const deps = new Set();
  if ($el.find('[onclick],[onchange],[onsubmit],[onmouseover]').length) deps.add('inline-event-handlers');
  if ($el.find('details').length) deps.add('details-disclosure');
  if ($el.find('[aria-expanded],[aria-controls]').length || $el.is('[aria-expanded]')) deps.add('toggle (aria-expanded)');
  if ($el.find('[data-toggle],[data-bs-toggle],[data-target],[data-bs-target]').length) deps.add('framework toggles (data-toggle)');
  if ($el.find('form').addBack('form').length) deps.add('form (submission disabled until configured)');
  if ($el.find('iframe').length) deps.add('embedded frame');
  if ($el.find('video,audio').length) deps.add('media playback');
  if ($el.find('[class*=carousel],[class*=slider],[class*=swiper],[class*=slick]').length || /carousel|slider|swiper|slick/.test(hint($, el))) deps.add('carousel/slider script');
  if ($el.find('[class*=accordion],[class*=tab]').length) deps.add('accordion/tabs script');
  if ($el.find('[class*=lazy],[data-src],[data-srcset]').length) deps.add('lazy-loading script');
  if ($el.find('canvas').length) deps.add('canvas (script-rendered, not editable)');
  return [...deps];
}

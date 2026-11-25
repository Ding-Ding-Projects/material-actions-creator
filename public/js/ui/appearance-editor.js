// Per-element appearance editing. Any element can get its own typography,
// colours, corners, padding and opacity. Settings live in the store under
// `appearance` as { [elementKey]: { ...properties } } and re-apply on load.
import { STRINGS } from '../core/strings.js';
import { h, t, esc } from '../core/i18n.js';
import * as store from '../core/store.js';
import { notify } from '../core/feedback.js';
import { colorPicker } from './color-picker.js';
import { parse, toCss, format } from './color-math.js';

Object.assign(STRINGS, {
  'ap.title': { en: 'Appearance', yue: '外觀' },
  'ap.for': { en: 'Editing {key}', yue: '而家改緊 {key}' },
  'ap.close': { en: 'Close appearance editor', yue: '關閉外觀編輯器' },
  'ap.type': { en: 'Typography', yue: '字體排版' },
  'ap.family': { en: 'Font', yue: '字型' },
  'ap.family.inherit': { en: 'As designed', yue: '跟原本設計' },
  'ap.family.system': { en: 'System sans', yue: '系統無襯線' },
  'ap.family.serif': { en: 'Serif', yue: '襯線' },
  'ap.family.mono': { en: 'System mono', yue: '系統等寬' },
  'ap.family.bricolage': { en: 'Bricolage Grotesque', yue: 'Bricolage Grotesque' },
  'ap.family.jetbrains': { en: 'JetBrains Mono', yue: 'JetBrains Mono' },
  'ap.size': { en: 'Size (px)', yue: '大細（px）' },
  'ap.weight': { en: 'Weight', yue: '粗幼' },
  'ap.style': { en: 'Style', yue: '樣式' },
  'ap.italic': { en: 'Italic', yue: '斜體' },
  'ap.underline': { en: 'Underline', yue: '底線' },
  'ap.strike': { en: 'Strikethrough', yue: '刪除線' },
  'ap.letterSpacing': { en: 'Letter spacing (em)', yue: '字距（em）' },
  'ap.lineHeight': { en: 'Line height', yue: '行距' },
  'ap.align': { en: 'Alignment', yue: '對齊' },
  'ap.align.left': { en: 'Left', yue: '靠左' },
  'ap.align.center': { en: 'Centre', yue: '置中' },
  'ap.align.right': { en: 'Right', yue: '靠右' },
  'ap.align.justify': { en: 'Justify', yue: '左右對齊' },
  'ap.case': { en: 'Letter case', yue: '大小楷' },
  'ap.case.none': { en: 'As written', yue: '照原文' },
  'ap.case.uppercase': { en: 'UPPERCASE', yue: '全部大楷' },
  'ap.case.lowercase': { en: 'lowercase', yue: '全部細楷' },
  'ap.case.capitalize': { en: 'Capitalise Each Word', yue: '每個字開頭大楷' },
  'ap.colors': { en: 'Colours', yue: '顏色' },
  'ap.textColor': { en: 'Text colour', yue: '字嘅顏色' },
  'ap.background': { en: 'Background', yue: '背景' },
  'ap.useDefault': { en: 'Use the designed colour', yue: '用返原本顏色' },
  'ap.box': { en: 'Shape', yue: '形狀' },
  'ap.radius': { en: 'Corner radius (px)', yue: '圓角（px）' },
  'ap.padding': { en: 'Padding (px)', yue: '內距（px）' },
  'ap.opacity': { en: 'Opacity (%)', yue: '不透明度（%）' },
  'ap.reset': { en: 'Reset this element', yue: '重設呢個元素' },
  'ap.resetAll': { en: 'Reset all', yue: '全部重設' },
  'ap.done': { en: 'Done', yue: '搞掂' },
  'ap.resetDone': { en: 'Appearance reset for this element.', yue: '呢個元素嘅外觀已經重設。' },
  'ap.resetAllDone': {
    en: ['All appearance changes were reset.', 'All appearance changes were reset.', 'Every element is back to its design.', 'Fresh start: every element is back to its design.', 'Clean slate! Everything looks the way it was built.'],
    yue: ['所有外觀改動已重設。', '所有外觀改動已重設。', '全部元素返晒原本設計。', '重新嚟過：全部返晒原本設計。', '一切清零！全部變返原裝樣。'],
  },
  'ap.resetAllHint': { en: 'Undo it from History if that was a mistake.', yue: '如果撳錯咗，可以喺歷史度還原。' },
  'ap.imported': { en: 'Imported appearance for {count} elements.', yue: '已匯入 {count} 個元素嘅外觀。' },
  'ap.importFailed': { en: 'That appearance file could not be imported.', yue: '匯入唔到呢個外觀檔案。' },
  'ap.weight.100': { en: 'Thin', yue: '極幼' },
  'ap.weight.200': { en: 'Extra light', yue: '特幼' },
  'ap.weight.300': { en: 'Light', yue: '幼' },
  'ap.weight.400': { en: 'Regular', yue: '標準' },
  'ap.weight.500': { en: 'Medium', yue: '中等' },
  'ap.weight.600': { en: 'Semibold', yue: '半粗' },
  'ap.weight.700': { en: 'Bold', yue: '粗' },
  'ap.weight.800': { en: 'Extra bold', yue: '特粗' },
  'ap.weight.900': { en: 'Black', yue: '極粗' },
});

// ---------- schema ----------
export const FONT_STACKS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  bricolage: '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif',
  jetbrains: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
};
const ALIGN = ['left', 'center', 'right', 'justify'];
const CASES = ['none', 'uppercase', 'lowercase', 'capitalize'];
const RANGES = {
  fontSize: [8, 96, 1], fontWeight: [100, 900, 100], letterSpacing: [-0.1, 0.5, 0.01], lineHeight: [0.8, 3, 0.05],
  borderRadius: [0, 64, 1], padding: [0, 64, 1], opacity: [0.1, 1, 0.01],
};
const PROPS = ['color', 'background', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'underline', 'strike', 'letterSpacing', 'lineHeight', 'textAlign', 'textTransform', 'borderRadius', 'padding', 'opacity'];
const CSS_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration-line', 'letter-spacing', 'line-height', 'text-align', 'text-transform', 'border-radius', 'padding', 'opacity'];
const MAX_KEYS = 2000;
const PANEL_KEY = 'appearance-editor';

// Returns an error string, or '' when the value is valid for the property.
function checkValue(prop, value) {
  switch (prop) {
    case 'color': case 'background':
      return typeof value === 'string' && parse(value) ? '' : 'colour';
    case 'fontFamily':
      return Object.hasOwn(FONT_STACKS, value) ? '' : 'font';
    case 'italic': case 'underline': case 'strike':
      return typeof value === 'boolean' ? '' : 'boolean';
    case 'textAlign':
      return ALIGN.includes(value) ? '' : 'alignment';
    case 'textTransform':
      return CASES.includes(value) ? '' : 'case';
    default: {
      const range = RANGES[prop];
      if (!range) return 'unknown property';
      if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) return 'out of range';
      if (prop === 'fontWeight' && value % 100 !== 0) return 'weight';
      return '';
    }
  }
}

// Validates a whole appearance map. Returns { value, errors }.
export function validateAppearance(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: null, errors: ['not an object'] };
  const keys = Object.keys(input);
  if (keys.length > MAX_KEYS) return { value: null, errors: ['too many elements'] };
  const value = {};
  for (const key of keys) {
    const entry = input[key];
    if (!key || key.length > 400) { errors.push('invalid element key'); continue; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${key}: not an object`); continue; }
    const clean = {};
    for (const [prop, v] of Object.entries(entry)) {
      if (!PROPS.includes(prop)) { errors.push(`${key}.${prop}: unknown property`); continue; }
      const problem = checkValue(prop, v);
      if (problem) errors.push(`${key}.${prop}: ${problem}`);
      else clean[prop] = v;
    }
    if (Object.keys(clean).length) value[key] = clean;
  }
  return { value, errors };
}

// ---------- keys ----------
const TRANSIENT_CLASS = /^(is-|has-|js-|ap-)|^(active|open|selected|hidden|leaving|current|focus|hover|disabled|teleport-flash)$/;
const cssString = (s) => String(s).replace(/["\\]/g, '\\$&');
const cssIdent = (s) => (globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, (c) => `\\${c}`));

// data-ui value when present, else a stable CSS path anchored at the nearest
// ancestor with an id or data-ui.
export function elementKey(element) {
  if (!element || element.nodeType !== 1) return '';
  if (element.dataset.ui) return element.dataset.ui;
  if (element.id) return `#${cssIdent(element.id)}`;
  const segments = [];
  let node = element;
  let anchor = '';
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    if (node !== element && (node.dataset.ui || node.id)) {
      anchor = node.dataset.ui ? `[data-ui="${cssString(node.dataset.ui)}"]` : `#${cssIdent(node.id)}`;
      break;
    }
    let seg = node.localName;
    const cls = [...node.classList].find((c) => !TRANSIENT_CLASS.test(c));
    if (cls) seg += `.${cssIdent(cls)}`;
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.localName === node.localName);
      if (same.length > 1) seg += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    segments.unshift(seg);
    node = parent;
  }
  return [anchor, ...segments].filter(Boolean).join(' > ');
}

function findElements(key, root) {
  const scope = root.querySelectorAll ? root : document;
  const byUi = [...scope.querySelectorAll(`[data-ui="${cssString(key)}"]`)];
  if (root.nodeType === 1 && root.dataset?.ui === key) byUi.unshift(root);
  if (byUi.length) return byUi;
  try {
    const found = [...scope.querySelectorAll(key)];
    if (root.nodeType === 1 && root.matches(key)) found.unshift(root);
    return found;
  } catch { return []; }
}

// ---------- applying ----------
function clearStyles(el) {
  for (const p of CSS_PROPS) el.style.removeProperty(p);
  el.removeAttribute('data-appearance');
}

function applyEntry(el, entry, key) {
  clearStyles(el);
  if (!entry || !Object.keys(entry).length) return;
  const set = (p, v) => el.style.setProperty(p, v, 'important');
  if (entry.color) { const c = parse(entry.color); if (c) set('color', toCss(c)); }
  if (entry.background) { const c = parse(entry.background); if (c) set('background-color', toCss(c)); }
  if (entry.fontFamily && FONT_STACKS[entry.fontFamily]) set('font-family', FONT_STACKS[entry.fontFamily]);
  if (entry.fontSize != null) set('font-size', `${entry.fontSize}px`);
  if (entry.fontWeight != null) set('font-weight', String(entry.fontWeight));
  if (entry.italic != null) set('font-style', entry.italic ? 'italic' : 'normal');
  if (entry.underline != null || entry.strike != null) {
    const lines = [entry.underline && 'underline', entry.strike && 'line-through'].filter(Boolean);
    set('text-decoration-line', lines.join(' ') || 'none');
  }
  if (entry.letterSpacing != null) set('letter-spacing', `${entry.letterSpacing}em`);
  if (entry.lineHeight != null) set('line-height', String(entry.lineHeight));
  if (entry.textAlign) set('text-align', entry.textAlign);
  if (entry.textTransform) set('text-transform', entry.textTransform);
  if (entry.borderRadius != null) set('border-radius', `${entry.borderRadius}px`);
  if (entry.padding != null) set('padding', `${entry.padding}px`);
  if (entry.opacity != null) set('opacity', String(entry.opacity));
  el.setAttribute('data-appearance', key);
}

function saved() {
  const { value } = validateAppearance(store.get('appearance') ?? {});
  return value || {};
}

// Re-applies every saved appearance under root (idempotent).
export function applyAppearance(root = document) {
  const scope = root.querySelectorAll ? root : document;
  for (const el of scope.querySelectorAll('[data-appearance]')) clearStyles(el);
  if (root.nodeType === 1 && root.hasAttribute('data-appearance')) clearStyles(root);
  const all = saved();
  for (const [key, entry] of Object.entries(all)) {
    for (const el of findElements(key, root)) applyEntry(el, entry, key);
  }
  // Keep the open editor's unsaved preview on top.
  if (current) applyEntry(current.target, current.working, current.key);
}

// ---------- export / import ----------
export function exportAppearance() {
  return JSON.stringify({ format: 'material-actions-creator.appearance', version: 1, appearance: saved() }, null, 2);
}

// Accepts the exported JSON (string or object), or a bare appearance map.
// All or nothing: any invalid entry rejects the whole import.
export function importAppearance(json) {
  let data = json;
  if (typeof json === 'string') {
    if (json.length > 2_000_000) return { ok: false, count: 0, errors: ['file too large'] };
    try { data = JSON.parse(json); } catch { return { ok: false, count: 0, errors: ['not valid JSON'] }; }
  }
  if (data && typeof data === 'object' && 'appearance' in data) {
    if (data.version !== undefined && data.version !== 1) return { ok: false, count: 0, errors: ['unsupported version'] };
    data = data.appearance;
  }
  const { value, errors } = validateAppearance(data);
  if (!value || errors.length) {
    notify(t('ap.importFailed'), { kind: 'error', detail: errors.slice(0, 3).join('; ') });
    return { ok: false, count: 0, errors };
  }
  store.set('appearance', value, { source: 'import' });
  applyAppearance();
  const count = Object.keys(value).length;
  notify(t('ap.imported', { count }), { kind: 'success' });
  return { ok: true, count, errors: [] };
}

// ---------- editor ----------
let current = null; // { panel, target, key, working, restore, cleanup }
let persistTimer = 0;

function persist() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  if (!current) return;
  const all = { ...saved() };
  if (Object.keys(current.working).length) all[current.key] = { ...current.working };
  else delete all[current.key];
  store.set('appearance', all);
}
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 500);
}

function computedDefaults(el) {
  const cs = getComputedStyle(el);
  const size = parseFloat(cs.fontSize) || 16;
  const lh = cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / size;
  const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) / size;
  const bg = parse(cs.backgroundColor);
  return {
    color: format(parse(cs.color) || parse('#eef0f6'), 'hex'),
    background: bg && bg.alpha > 0 ? format(bg, 'hex') : '#12141b',
    fontSize: Math.round(size),
    fontWeight: Math.min(900, Math.max(100, Math.round((Number(cs.fontWeight) || 400) / 100) * 100)),
    letterSpacing: Math.round((Number.isFinite(ls) ? ls : 0) * 100) / 100,
    lineHeight: Math.round((Number.isFinite(lh) ? lh : 1.2) * 20) / 20,
    borderRadius: Math.round(parseFloat(cs.borderTopLeftRadius) || 0),
    padding: Math.round(parseFloat(cs.paddingTop) || 0),
    opacity: Number(cs.opacity) || 1,
    textAlign: ALIGN.includes(cs.textAlign) ? cs.textAlign : 'left',
    textTransform: CASES.includes(cs.textTransform) ? cs.textTransform : 'none',
    italic: cs.fontStyle === 'italic',
    underline: cs.textDecorationLine.includes('underline'),
    strike: cs.textDecorationLine.includes('line-through'),
  };
}

const clampTo = (prop, v) => {
  const [min, max, step] = RANGES[prop];
  const n = Math.min(max, Math.max(min, Number(v)));
  return Math.round(Math.round(n / step) * step * 1000) / 1000;
};

function rangeRow(id, prop, labelKey, scale = 1) {
  const [min, max, step] = RANGES[prop];
  return `<div class="ap-range">
    <label for="${id}-${prop}">${h(labelKey)}</label>
    <input id="${id}-${prop}" type="range" data-prop="${prop}" data-scale="${scale}" min="${min * scale}" max="${max * scale}" step="${step * scale}">
    <input type="number" data-prop="${prop}" data-scale="${scale}" min="${min * scale}" max="${max * scale}" step="${step * scale}" aria-label="${esc(t(labelKey))}">
  </div>`;
}

function panelMarkup(id, key) {
  const fonts = ['inherit', ...Object.keys(FONT_STACKS)].map((f) => `<option value="${f}">${esc(t(`ap.family.${f}`))}</option>`).join('');
  const cases = CASES.map((c) => `<option value="${c}">${esc(t(`ap.case.${c}`))}</option>`).join('');
  const aligns = ALIGN.map((a) => `<button type="button" data-align="${a}" aria-pressed="false">${h(`ap.align.${a}`)}</button>`).join('');
  return `
    <header class="ap-head">
      <div><h2 class="ap-title" id="${id}-title">${h('ap.title')}</h2><p class="ap-key">${esc(t('ap.for', { key }))}</p></div>
      <button type="button" class="ap-x" data-action="done" aria-label="${esc(t('ap.close'))}">×</button>
    </header>
    <section class="ap-section" aria-labelledby="${id}-type">
      <h3 id="${id}-type">${h('ap.type')}</h3>
      <div class="ap-field"><label for="${id}-family">${h('ap.family')}</label><select id="${id}-family" data-prop="fontFamily">${fonts}</select></div>
      ${rangeRow(id, 'fontSize', 'ap.size')}
      <div class="ap-range">
        <label for="${id}-fontWeight">${h('ap.weight')}</label>
        <input id="${id}-fontWeight" type="range" data-prop="fontWeight" data-scale="1" min="100" max="900" step="100">
        <output data-role="weightName" for="${id}-fontWeight"></output>
      </div>
      <div class="ap-field"><span id="${id}-style">${h('ap.style')}</span>
        <div class="ap-toggles" role="group" aria-labelledby="${id}-style">
          <button type="button" data-toggle="italic" aria-pressed="false" aria-label="${esc(t('ap.italic'))}" title="${esc(t('ap.italic'))}"><i>I</i></button>
          <button type="button" data-toggle="underline" aria-pressed="false" aria-label="${esc(t('ap.underline'))}" title="${esc(t('ap.underline'))}"><u>U</u></button>
          <button type="button" data-toggle="strike" aria-pressed="false" aria-label="${esc(t('ap.strike'))}" title="${esc(t('ap.strike'))}"><s>S</s></button>
        </div>
      </div>
      ${rangeRow(id, 'letterSpacing', 'ap.letterSpacing')}
      ${rangeRow(id, 'lineHeight', 'ap.lineHeight')}
      <div class="ap-field"><span id="${id}-align">${h('ap.align')}</span><div class="ap-toggles" role="group" aria-labelledby="${id}-align">${aligns}</div></div>
      <div class="ap-field"><label for="${id}-case">${h('ap.case')}</label><select id="${id}-case" data-prop="textTransform">${cases}</select></div>
    </section>
    <section class="ap-section" aria-labelledby="${id}-colors">
      <h3 id="${id}-colors">${h('ap.colors')}</h3>
      <details class="ap-color" data-color="color"><summary><span class="ap-chip" aria-hidden="true"></span>${h('ap.textColor')}</summary>
        <div data-role="picker"></div><button type="button" class="ap-link" data-default="color">${h('ap.useDefault')}</button></details>
      <details class="ap-color" data-color="background"><summary><span class="ap-chip" aria-hidden="true"></span>${h('ap.background')}</summary>
        <div data-role="picker"></div><button type="button" class="ap-link" data-default="background">${h('ap.useDefault')}</button></details>
    </section>
    <section class="ap-section" aria-labelledby="${id}-box">
      <h3 id="${id}-box">${h('ap.box')}</h3>
      ${rangeRow(id, 'borderRadius', 'ap.radius')}
      ${rangeRow(id, 'padding', 'ap.padding')}
      ${rangeRow(id, 'opacity', 'ap.opacity', 100)}
    </section>
    <footer class="ap-foot">
      <button type="button" class="ap-btn" data-action="reset">${h('ap.reset')}</button>
      <button type="button" class="ap-btn" data-action="resetAll">${h('ap.resetAll')}</button>
      <button type="button" class="ap-btn primary" data-action="done">${h('ap.done')}</button>
    </footer>`;
}

// Places the panel beside the target without covering it, flipping sides
// and shrinking to stay on screen.
function place(panel, target) {
  const margin = 8, gap = 12;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const r = target.getBoundingClientRect();
  const pw = Math.min(380, vw - margin * 2);
  panel.style.width = `${pw}px`;
  panel.style.maxHeight = `${vh - margin * 2}px`;
  const ph = Math.min(panel.scrollHeight, vh - margin * 2);
  const clampY = (y, hgt) => Math.min(Math.max(y, margin), Math.max(margin, vh - hgt - margin));
  const clampX = (x) => Math.min(Math.max(x, margin), Math.max(margin, vw - pw - margin));
  let left, top, maxH = vh - margin * 2, side;
  if (vw - r.right - gap - margin >= pw) { side = 'right'; left = r.right + gap; top = clampY(r.top, ph); }
  else if (r.left - gap - margin >= pw) { side = 'left'; left = r.left - gap - pw; top = clampY(r.top, ph); }
  else {
    const below = vh - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    if (Math.max(below, above) >= 160) {
      side = below >= above ? 'below' : 'above';
      maxH = side === 'below' ? below : above;
      const hgt = Math.min(ph, maxH);
      top = side === 'below' ? r.bottom + gap : r.top - gap - hgt;
      left = clampX(r.left);
    } else {
      // The element fills the screen: use the corner furthest from its centre.
      side = 'corner';
      maxH = Math.max(200, vh / 2);
      left = r.left + r.width / 2 > vw / 2 ? margin : vw - pw - margin;
      top = r.top + r.height / 2 > vh / 2 ? margin : vh - Math.min(ph, maxH) - margin;
    }
  }
  panel.style.maxHeight = `${maxH}px`;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.dataset.side = side;
}

function makeFocusable(el) {
  if (el.matches('a[href], button, input, select, textarea, [tabindex]') || el.isContentEditable) return;
  el.setAttribute('tabindex', '-1');
  el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
}

export function closeAppearanceEditor({ restoreFocus = true } = {}) {
  if (!current) return;
  const { panel, target, cleanup } = current;
  persist();
  cleanup();
  current = null;
  panel.remove();
  target.classList.remove('ap-editing');
  applyAppearance();
  if (restoreFocus && target.isConnected) {
    makeFocusable(target);
    target.focus({ preventScroll: true });
  }
}

let seq = 0;

export function openAppearanceEditor(element) {
  if (!element || element.nodeType !== 1) return null;
  let previousRect = null;
  if (current) {
    if (element === current.panel) previousRect = current.panel.getBoundingClientRect();
    closeAppearanceEditor({ restoreFocus: false });
  }
  const id = `ap${++seq}`;
  const panel = document.createElement('div');
  panel.className = 'ap-panel';
  panel.dataset.ui = PANEL_KEY;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', `${id}-title`);
  const target = previousRect ? panel : element;
  const key = elementKey(target) || PANEL_KEY;
  panel.innerHTML = panelMarkup(id, key);
  document.body.append(panel);

  const working = { ...(saved()[key] || {}) };
  const state = { panel, target, key, working, cleanup: () => {} };
  current = state;
  target.classList.add('ap-editing');

  const defaults = () => computedDefaults(target);

  // Colour pickers (created lazily when their section opens).
  const pickers = {};
  for (const det of panel.querySelectorAll('details[data-color]')) {
    const prop = det.dataset.color;
    det.addEventListener('toggle', () => {
      if (!det.open || pickers[prop]) return;
      pickers[prop] = colorPicker({
        value: working[prop] || defaults()[prop],
        labelKey: prop === 'color' ? 'ap.textColor' : 'ap.background',
        onChange: (css) => { working[prop] = css; changed(); },
      });
      det.querySelector('[data-role="picker"]').append(pickers[prop]);
    });
  }

  function sync() {
    const d = defaults();
    const value = (p) => working[p] ?? d[p];
    for (const input of panel.querySelectorAll('input[data-prop]')) {
      if (input === document.activeElement && input.type === 'number') continue;
      const scale = Number(input.dataset.scale) || 1;
      input.value = String(Math.round(value(input.dataset.prop) * scale * 1000) / 1000);
    }
    panel.querySelector('[data-role="weightName"]').textContent = t(`ap.weight.${value('fontWeight')}`);
    panel.querySelector('[data-prop="fontFamily"]').value = working.fontFamily || 'inherit';
    panel.querySelector('[data-prop="textTransform"]').value = value('textTransform');
    for (const b of panel.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', String(Boolean(value(b.dataset.toggle))));
    for (const b of panel.querySelectorAll('[data-align]')) b.setAttribute('aria-pressed', String(value('textAlign') === b.dataset.align));
    for (const det of panel.querySelectorAll('details[data-color]')) {
      const p = det.dataset.color;
      det.querySelector('.ap-chip').style.background = value(p);
    }
  }

  function changed() {
    applyEntry(target, working, key);
    schedulePersist();
    sync();
  }

  panel.addEventListener('input', (e) => {
    const el = e.target;
    const prop = el.dataset?.prop;
    if (!prop || el.closest('.cp')) return;
    if (prop === 'fontFamily') {
      if (el.value === 'inherit') delete working.fontFamily; else working.fontFamily = el.value;
    } else if (prop === 'textTransform') {
      working.textTransform = el.value;
    } else {
      if (el.value === '' || !Number.isFinite(Number(el.value))) return;
      working[prop] = clampTo(prop, Number(el.value) / (Number(el.dataset.scale) || 1));
    }
    changed();
  });

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !panel.contains(btn) || btn.closest('.cp')) return;
    if (btn.dataset.toggle) {
      const p = btn.dataset.toggle;
      working[p] = !(working[p] ?? defaults()[p]);
      changed();
    } else if (btn.dataset.align) {
      working.textAlign = btn.dataset.align;
      changed();
    } else if (btn.dataset.default) {
      const p = btn.dataset.default;
      delete working[p];
      changed();
      pickers[p]?.setValue(defaults()[p]);
    } else if (btn.dataset.action === 'reset') {
      for (const p of Object.keys(working)) delete working[p];
      changed();
      persist();
      for (const [p, picker] of Object.entries(pickers)) picker.setValue(defaults()[p]);
      notify(t('ap.resetDone'), { kind: 'info' });
    } else if (btn.dataset.action === 'resetAll') {
      for (const p of Object.keys(working)) delete working[p];
      clearTimeout(persistTimer);
      store.set('appearance', {}, { source: 'reset' });
      applyAppearance();
      sync();
      for (const [p, picker] of Object.entries(pickers)) picker.setValue(defaults()[p]);
      notify(t('ap.resetAllDone'), { kind: 'info', detail: t('ap.resetAllHint') });
    } else if (btn.dataset.action === 'done') {
      closeAppearanceEditor();
    }
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAppearanceEditor(); }
  });

  // Keep beside the element while the page scrolls or resizes.
  let frame = 0;
  const reposition = () => {
    if (frame || target === panel) return;
    frame = requestAnimationFrame(() => { frame = 0; if (current === state) place(panel, target); });
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  state.cleanup = () => {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    cancelAnimationFrame(frame);
  };

  applyAppearance(panel);
  applyEntry(target, working, key);
  sync();
  if (previousRect) {
    panel.style.left = `${previousRect.left}px`;
    panel.style.top = `${previousRect.top}px`;
    panel.style.width = `${previousRect.width}px`;
    panel.style.maxHeight = `${document.documentElement.clientHeight - 16}px`;
  } else {
    place(panel, target);
  }
  panel.querySelector('select, input, button:not(.ap-x)')?.focus({ preventScroll: true });
  return panel;
}

// Re-apply whenever settings change (restore from history, import, reset).
store.onChange((key) => {
  if (key === 'appearance' || key === '*') applyAppearance();
});

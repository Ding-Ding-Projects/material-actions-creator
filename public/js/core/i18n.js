// Language modes (English, Cantonese, bilingual), funny levels and personal vocabulary.
import { STRINGS } from './strings.js';
import * as store from './store.js';
import * as vocab from './vocab.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pick(value, level) {
  if (!Array.isArray(value)) return value;
  const i = Math.round(((Math.min(5, Math.max(1, level)) - 1) * (value.length - 1)) / 4);
  return value[i];
}

function fill(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
}

function funny(lang) {
  if (store.get('schoolMode')) return 1;
  return Number(store.get(lang === 'yue' ? 'funnyYue' : 'funnyEn')) || 5;
}

// One language's text for a key (English gets the personal vocabulary).
export function raw(key, vars, lang) {
  const entry = STRINGS[key];
  if (!entry) return key;
  const text = fill(pick(entry[lang] ?? entry.en, funny(lang)), vars);
  return lang === 'en' ? vocab.apply(text) : text;
}

// Plain text in the primary language (for attributes, narration, toasts).
export function t(key, vars) {
  const lang = store.get('lang') === 'yue' ? 'yue' : 'en';
  return raw(key, vars, lang);
}

// HTML: bilingual mode shows a compact secondary line.
export function h(key, vars) {
  const mode = store.get('lang');
  if (mode === 'bi') {
    const en = raw(key, vars, 'en');
    const yue = raw(key, vars, 'yue');
    if (en === yue) return esc(en);
    return `<span class="bi"><span class="bi-p">${esc(en)}</span><span class="bi-s" lang="yue">${esc(yue)}</span></span>`;
  }
  return esc(t(key, vars));
}

// Text that came from the server (stage labels, errors): vocabulary only.
export function v(text) {
  return vocab.apply(text);
}

export function lang() {
  return store.get('lang');
}

// Updates every [data-i18n] element under root.
export function translate(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.innerHTML = h(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  document.documentElement.lang = store.get('lang') === 'yue' ? 'yue-Hant-HK' : 'en';
}

export { esc };

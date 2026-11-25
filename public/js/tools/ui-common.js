// Small browser helpers shared by the Tools tab modules.
import { h, t, translate } from '../core/i18n.js';
import * as store from '../core/store.js';
import { notify, play } from '../core/feedback.js';

// A translated label that refreshes when the language changes.
export const L = (key) => `<span data-i18n="${key}">${h(key)}</span>`;

let counter = 0;
export const uid = (prefix = 'tl') => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

// Lets the browser paint between chunks of heavy work (works in background tabs too).
export const nextTick = () => new Promise((r) => setTimeout(r, 0));

export function debounce(fn, ms = 150) {
  let id = 0;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
}

const LANGUAGE_KEYS = new Set(['lang', 'funnyEn', 'funnyYue', 'schoolMode', '*']);
// Re-translates root (and calls rerender) whenever the language or funny level changes.
export function onLanguage(root, rerender) {
  return store.onChange((key) => {
    if (!LANGUAGE_KEYS.has(key)) return;
    translate(root);
    rerender?.();
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    area.remove();
  }
  notify(t('tools.copied'), { kind: 'success', speak: false });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function downloadText(text, name, mime = 'text/plain') {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), name);
}

// Wires a drop zone. The zone must contain an <input type="file">.
export function dropZone(zone, onFiles) {
  const input = zone.querySelector('input[type="file"]');
  input?.addEventListener('change', () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-over'); });
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('is-over');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    onFiles(files);
  });
}

// Markup for a drop zone with a real file input and label.
export function dropZoneHtml({ id, labelKey, hintKey, multiple = false, accept = '' }) {
  return `<div class="tl-drop" data-drop>
    <input type="file" id="${id}" class="tl-file" ${multiple ? 'multiple' : ''} ${accept ? `accept="${accept}"` : ''}>
    <label for="${id}" class="btn small">${L(labelKey)}</label>
    <span class="muted">${L(hintKey)}</span>
  </div>`;
}

export function fail(message, detail = '') {
  play('invalid');
  notify(message, { kind: 'error', detail });
}

// Selects a character range in a textarea and scrolls it into view.
export function selectInTextarea(area, start, end = start + 1) {
  area.focus();
  area.setSelectionRange(start, Math.max(start, end));
  const before = area.value.slice(0, start).split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
  area.scrollTop = Math.max(0, before * lineHeight - area.clientHeight / 2);
}

// Offset of (line, column), both 1-based, in text.
export function offsetOf(text, line, column) {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(text.length, offset + Math.max(0, column - 1));
}

export function formatNumber(n) {
  try { return new Intl.NumberFormat(store.get('lang') === 'yue' ? 'zh-HK' : 'en').format(n); } catch { return String(n); }
}

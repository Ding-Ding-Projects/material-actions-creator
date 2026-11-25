// Logo customisation: the default mark, four generated variants, or an image
// the user uploads. Uploads are validated, kept only in this browser
// (localStorage `mac.logo.v1`) and only ever rendered through <img>.
import { STRINGS } from '../core/strings.js';
import { h, t, esc } from '../core/i18n.js';
import * as store from '../core/store.js';
import { notify } from '../core/feedback.js';

Object.assign(STRINGS, {
  'logo.legend': { en: 'Logo', yue: '標誌' },
  'logo.help': { en: 'Shown in the top bar and as the browser tab icon. Uploads stay in this browser and are never sent anywhere.', yue: '會喺頂欄同瀏覽器分頁圖示度顯示。上載嘅圖只會留喺呢個瀏覽器，唔會傳去任何地方。' },
  'logo.default': { en: 'Default mark', yue: '原裝標誌' },
  'logo.hexagon': { en: 'Hexagon', yue: '六角形' },
  'logo.orbit': { en: 'Orbit', yue: '軌道' },
  'logo.diamond': { en: 'Diamond', yue: '菱形' },
  'logo.stack': { en: 'Stack', yue: '疊疊樂' },
  'logo.upload': { en: 'Your image', yue: '你自己嘅圖' },
  'logo.choose': { en: 'Upload an image', yue: '上載圖片' },
  'logo.rules': { en: 'PNG, JPEG, WebP or SVG, up to 512 KB.', yue: 'PNG、JPEG、WebP 或者 SVG，最大 512 KB。' },
  'logo.remove': { en: 'Remove uploaded image', yue: '刪除上載咗嘅圖' },
  'logo.none': { en: 'No image uploaded yet.', yue: '仲未上載圖片。' },
  'logo.saved': {
    en: ['Logo updated.', 'Logo updated.', 'Logo updated.', 'New logo, looking sharp.', 'New logo! Looking sharp.'],
    yue: ['標誌已更新。', '標誌已更新。', '標誌已更新。', '新標誌，好醒神。', '新標誌！型到爆！'],
  },
  'logo.removed': { en: 'Uploaded image removed.', yue: '已刪除上載嘅圖。' },
  'logo.tooBig': { en: 'That image is larger than 512 KB.', yue: '呢張圖大過 512 KB。' },
  'logo.badType': { en: 'Only PNG, JPEG, WebP and SVG images are accepted.', yue: '只接受 PNG、JPEG、WebP 同 SVG 圖片。' },
  'logo.unreadable': { en: 'That image could not be read.', yue: '讀唔到呢張圖。' },
  'logo.storageFull': { en: 'Browser storage is full, so the image could not be saved.', yue: '瀏覽器儲存空間滿咗，存唔到張圖。' },
});

const UPLOAD_KEY = 'mac.logo.v1';
const MAX_BYTES = 512 * 1024;
const DEFAULT_SRC = '/icon.svg';
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
export const CHOICES = ['default', 'hexagon', 'orbit', 'diamond', 'stack', 'upload'];

const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s*\n\s*/g, ' ').trim())}`;

export const VARIANTS = {
  hexagon: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="16" fill="#12141b"/>
    <path d="M32 8 53 20v24L32 56 11 44V20z" fill="#d4ff3a"/>
    <path d="M32 20 43 26.5v13L32 46 21 39.5v-13z" fill="#12141b"/>
    <circle cx="32" cy="33" r="4" fill="#b69cff"/></svg>`),
  orbit: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="o" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cf5c8"/><stop offset="1" stop-color="#b69cff"/></linearGradient></defs>
    <circle cx="32" cy="32" r="30" fill="#0b0c10"/>
    <circle cx="32" cy="32" r="14" fill="url(#o)"/>
    <ellipse cx="32" cy="32" rx="26" ry="10" fill="none" stroke="#7cf5c8" stroke-width="3" transform="rotate(-28 32 32)"/>
    <circle cx="53" cy="20" r="4" fill="#d4ff3a"/></svg>`),
  diamond: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="20" fill="#191c25"/>
    <path d="M32 6 58 32 32 58 6 32z" fill="#ff7a6b"/>
    <path d="M32 20 44 32 32 44 20 32z" fill="#ffc857"/></svg>`),
  stack: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#12141b"/>
    <rect x="12" y="14" width="40" height="9" rx="4.5" fill="#ffc857"/>
    <rect x="16" y="28" width="36" height="9" rx="4.5" fill="#7cf5c8"/>
    <rect x="12" y="42" width="28" height="9" rx="4.5" fill="#b69cff"/>
    <circle cx="48" cy="46.5" r="4.5" fill="#d4ff3a"/></svg>`),
};

const STORED = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

function readUpload() {
  try {
    const v = localStorage.getItem(UPLOAD_KEY);
    return v && v.length <= Math.ceil(MAX_BYTES / 3) * 4 + 40 && STORED.test(v) ? v : '';
  } catch { return ''; }
}

// Current logo source for the saved choice (falls back to the default mark).
export function logoSource(choice = store.get('logo')) {
  if (choice === 'upload') return readUpload() || DEFAULT_SRC;
  return VARIANTS[choice] || DEFAULT_SRC;
}

function mimeOf(src) {
  if (src === DEFAULT_SRC) return 'image/svg+xml';
  return src.match(/^data:([^;,]+)/)?.[1] || 'image/svg+xml';
}

// Updates every img[data-logo] and the favicon.
export function applyLogo() {
  const src = logoSource();
  for (const img of document.querySelectorAll('img[data-logo]')) {
    if (img.getAttribute('src') !== src) img.src = src;
  }
  let icon = document.querySelector('link[rel~="icon"]');
  if (!icon) {
    icon = document.createElement('link');
    icon.rel = 'icon';
    document.head.append(icon);
  }
  icon.type = mimeOf(src);
  icon.href = src;
}

// ---------- upload validation ----------
function sniff(bytes) {
  const b = (i) => bytes[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 1024)).replace(/^﻿/, '').trimStart();
  const body = head.replace(/^<\?xml[^>]*>\s*/i, '').replace(/^(<!--[\s\S]*?-->\s*)*/, '').replace(/^<!doctype svg[^>]*>\s*/i, '');
  if (/^<svg[\s>]/i.test(body)) return 'image/svg+xml';
  return '';
}

function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function decodes(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 || img.width > 0 || src.startsWith('data:image/svg'));
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

// Validates a File and returns { ok, dataUrl } or { ok: false, reason }.
export async function validateUpload(file) {
  if (!file) return { ok: false, reason: 'logo.unreadable' };
  if (file.size > MAX_BYTES) return { ok: false, reason: 'logo.tooBig' };
  if (file.type && !TYPES.includes(file.type)) return { ok: false, reason: 'logo.badType' };
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return { ok: false, reason: 'logo.unreadable' }; }
  if (!bytes.length) return { ok: false, reason: 'logo.unreadable' };
  if (bytes.length > MAX_BYTES) return { ok: false, reason: 'logo.tooBig' };
  const type = sniff(bytes);
  if (!type) return { ok: false, reason: 'logo.badType' };
  // The declared type must agree with the content (SVG may be declared as text).
  if (file.type && file.type !== type) return { ok: false, reason: 'logo.badType' };
  const dataUrl = `data:${type};base64,${toBase64(bytes)}`;
  if (!(await decodes(dataUrl))) return { ok: false, reason: 'logo.unreadable' };
  return { ok: true, dataUrl, type };
}

// ---------- settings element ----------
let seq = 0;

export function logoSettings() {
  const id = `logo${++seq}`;
  const root = document.createElement('fieldset');
  root.className = 'logo-settings';
  root.dataset.ui = 'logo-settings';

  const option = (choice, src) => `
    <label class="logo-option" data-choice="${choice}">
      <input type="radio" name="${id}" value="${choice}">
      <img src="${esc(src)}" alt="" width="48" height="48" data-preview="${choice}">
      <span>${h(`logo.${choice}`)}</span>
    </label>`;

  root.innerHTML = `
    <legend>${h('logo.legend')}</legend>
    <p class="logo-help" id="${id}-help">${h('logo.help')}</p>
    <div class="logo-options" aria-describedby="${id}-help">
      ${option('default', DEFAULT_SRC)}
      ${Object.entries(VARIANTS).map(([k, src]) => option(k, src)).join('')}
      ${option('upload', readUpload() || DEFAULT_SRC)}
    </div>
    <div class="logo-upload">
      <label class="ap-btn" for="${id}-file">${h('logo.choose')}</label>
      <input class="ap-sr" id="${id}-file" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg" aria-describedby="${id}-rules ${id}-status">
      <button type="button" class="ap-btn" data-action="remove">${h('logo.remove')}</button>
      <p class="logo-rules" id="${id}-rules">${h('logo.rules')}</p>
      <p class="logo-status" id="${id}-status" role="status" aria-live="polite"></p>
    </div>`;

  const file = root.querySelector('input[type="file"]');
  const status = root.querySelector('.logo-status');
  const removeBtn = root.querySelector('[data-action="remove"]');

  function sync() {
    const upload = readUpload();
    const choice = CHOICES.includes(store.get('logo')) && (store.get('logo') !== 'upload' || upload) ? store.get('logo') : 'default';
    for (const r of root.querySelectorAll('input[type="radio"]')) r.checked = r.value === choice;
    const uploadRadio = root.querySelector('input[value="upload"]');
    uploadRadio.disabled = !upload;
    root.querySelector('[data-preview="upload"]').src = upload || DEFAULT_SRC;
    root.querySelector('[data-choice="upload"]').classList.toggle('empty', !upload);
    removeBtn.disabled = !upload;
    if (!upload && !status.textContent) status.textContent = t('logo.none');
  }

  root.addEventListener('change', async (e) => {
    if (e.target.type === 'radio') {
      store.set('logo', e.target.value);
      applyLogo();
      return;
    }
    if (e.target !== file || !file.files?.[0]) return;
    const result = await validateUpload(file.files[0]);
    file.value = '';
    if (!result.ok) {
      status.textContent = t(result.reason);
      notify(t(result.reason), { kind: 'error' });
      return;
    }
    try {
      localStorage.setItem(UPLOAD_KEY, result.dataUrl);
    } catch {
      status.textContent = t('logo.storageFull');
      notify(t('logo.storageFull'), { kind: 'error' });
      return;
    }
    status.textContent = t('logo.saved');
    store.set('logo', 'upload');
    sync();
    applyLogo();
    notify(t('logo.saved'), { kind: 'success' });
  });

  removeBtn.addEventListener('click', () => {
    try { localStorage.removeItem(UPLOAD_KEY); } catch { /* storage blocked */ }
    if (store.get('logo') === 'upload') store.set('logo', 'default');
    status.textContent = t('logo.removed');
    sync();
    applyLogo();
    notify(t('logo.removed'), { kind: 'info' });
  });

  store.onChange((key) => { if (key === 'logo' || key === '*') sync(); });
  sync();
  return root;
}

store.onChange((key) => {
  if (key === 'logo' || key === '*') applyLogo();
});

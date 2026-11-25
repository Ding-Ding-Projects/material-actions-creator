// Colour picker: a 2-D saturation/brightness area, hue and opacity sliders,
// one editable field per notation with copy buttons, WCAG contrast against the
// app's dark and light backgrounds, an sRGB gamut warning and token swatches.
import { STRINGS } from '../core/strings.js';
import { h, t, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import {
  FORMATS, FORMAT_LABELS, parse, format, toHsv, fromHsv, gamut, contrast, wcag, toCss, inGamut,
} from './color-math.js';

Object.assign(STRINGS, {
  'cp.label': { en: 'Colour', yue: '顏色' },
  'cp.area': { en: 'Saturation and brightness', yue: '飽和度同光暗' },
  'cp.areaValue': { en: 'Saturation {s}%, brightness {v}%', yue: '飽和度 {s}%，光暗 {v}%' },
  'cp.areaHelp': { en: 'Arrow keys adjust saturation and brightness. Hold Shift for larger steps. Home and End jump to the edges.', yue: '用方向鍵調飽和度同光暗，㩒住 Shift 行大步啲，Home 同 End 跳去盡頭。' },
  'cp.hue': { en: 'Hue', yue: '色相' },
  'cp.alpha': { en: 'Opacity', yue: '不透明度' },
  'cp.any': { en: 'Paste any colour', yue: '貼任何顏色' },
  'cp.anyHint': { en: 'Name, HEX, RGB, HSL, HSV, HWB, Lab, LCH, OKLab, OKLCH or CMYK', yue: '名、HEX、RGB、HSL、HSV、HWB、Lab、LCH、OKLab、OKLCH 或者 CMYK 都得' },
  'cp.invalid': { en: 'Not a colour this picker understands yet.', yue: '呢個唔似顏色，睇唔明呀。' },
  'cp.formats': { en: 'Every format', yue: '全部格式' },
  'cp.noName': { en: 'No CSS name', yue: '冇 CSS 名' },
  'cp.copy': { en: 'Copy {format}', yue: '複製 {format}' },
  'cp.copied': {
    en: ['Copied.', 'Copied.', 'Copied to the clipboard.', 'Copied — ready to paste.', 'Copied! Paste away.'],
    yue: ['已複製。', '已複製。', '已複製去剪貼簿。', '複製咗，可以貼喇。', '複製咗！隨便貼！'],
  },
  'cp.copyFailed': { en: 'The clipboard is not available here.', yue: '呢度用唔到剪貼簿。' },
  'cp.preview': { en: 'Current colour {value}', yue: '而家嘅顏色 {value}' },
  'cp.contrast': { en: 'Contrast', yue: '對比度' },
  'cp.onDark': { en: 'On dark', yue: '深色底' },
  'cp.onLight': { en: 'On light', yue: '淺色底' },
  'cp.pass': { en: 'passes', yue: '合格' },
  'cp.fail': { en: 'fails', yue: '唔合格' },
  'cp.gamut': { en: 'Outside the sRGB gamut: most screens show the nearest colour ({clipped}).', yue: '超出 sRGB 色域：大部分螢幕會顯示最接近嘅顏色（{clipped}）。' },
  'cp.swatches': { en: 'App colours', yue: 'App 顏色' },
  'cp.useSwatch': { en: 'Use {name} ({value})', yue: '用 {name}（{value}）' },
});

const BACKGROUNDS = { dark: '#0b0c10', light: '#ffffff' };
const TOKENS = {
  '--lime': '#d4ff3a', '--mint': '#7cf5c8', '--violet': '#b69cff', '--coral': '#ff7a6b', '--amber': '#ffc857',
  '--text': '#eef0f6', '--muted': '#8d93a8', '--line': '#2c3140',
  '--ink-0': '#0b0c10', '--ink-1': '#12141b', '--ink-2': '#191c25', '--ink-3': '#232733',
};

let seq = 0;

function tokenValue(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return parse(v) ? v : fallback;
  } catch { return fallback; }
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try { input.select(); return document.execCommand('copy'); } catch { return false; }
  }
}

// value: any supported colour string. onChange(css, color) gets a renderable
// CSS string (HEX in gamut, OKLCH outside) and the colour object.
export function colorPicker({ value = '#d4ff3a', onChange = () => {}, labelKey = 'cp.label' } = {}) {
  const id = `cp${++seq}`;
  let color = parse(value) || parse('#d4ff3a');
  let hsv = toHsv(color);

  const root = document.createElement('div');
  root.className = 'cp';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-labelledby', `${id}-title`);

  const swatchButtons = Object.entries(TOKENS).map(([name, fallback]) => {
    const v = tokenValue(name, fallback);
    return `<button type="button" class="cp-swatch" data-value="${esc(v)}" style="--sw:${esc(v)}" aria-label="${esc(t('cp.useSwatch', { name, value: v }))}" title="${esc(name)}"></button>`;
  }).join('');

  const formatRows = FORMATS.map((f) => `
    <div class="cp-row">
      <label for="${id}-f-${f}">${esc(FORMAT_LABELS[f])}</label>
      <input id="${id}-f-${f}" data-format="${f}" type="text" spellcheck="false" autocomplete="off" aria-describedby="${id}-err">
      <button type="button" class="cp-copy" data-copy="${f}" aria-label="${esc(t('cp.copy', { format: FORMAT_LABELS[f] }))}">⧉</button>
    </div>`).join('');

  root.innerHTML = `
    <p class="cp-title" id="${id}-title">${h(labelKey)}</p>
    <div class="cp-top">
      <div class="cp-area" data-role="area">
        <button type="button" class="cp-thumb" data-role="thumb" aria-label="${esc(t('cp.area'))}" aria-describedby="${id}-area-v ${id}-area-help"></button>
      </div>
      <div class="cp-preview" data-role="preview" role="img"><span></span></div>
    </div>
    <span class="ap-sr" id="${id}-area-v" aria-live="polite" data-role="areaValue"></span>
    <span class="ap-sr" id="${id}-area-help">${esc(t('cp.areaHelp'))}</span>
    <label class="cp-slider cp-hue"><span>${h('cp.hue')}</span><input type="range" min="0" max="360" step="1" data-role="hue"><output data-role="hueOut"></output></label>
    <label class="cp-slider cp-alpha"><span>${h('cp.alpha')}</span><input type="range" min="0" max="100" step="1" data-role="alpha"><output data-role="alphaOut"></output></label>
    <div class="cp-row cp-any">
      <label for="${id}-any">${h('cp.any')}</label>
      <input id="${id}-any" type="text" data-role="any" spellcheck="false" autocomplete="off" placeholder="${esc(t('cp.anyHint'))}" aria-describedby="${id}-err">
    </div>
    <p class="cp-error" id="${id}-err" role="status" data-role="error"></p>
    <p class="cp-gamut" role="status" data-role="gamut" hidden></p>
    <div class="cp-contrast" data-role="contrast" aria-live="polite"></div>
    <details class="cp-formats">
      <summary>${h('cp.formats')}</summary>
      ${formatRows}
    </details>
    <div class="cp-swatches" role="group" aria-label="${esc(t('cp.swatches'))}">${swatchButtons}</div>`;

  const q = (r) => root.querySelector(`[data-role="${r}"]`);
  const area = q('area'), thumb = q('thumb'), hueIn = q('hue'), alphaIn = q('alpha');
  const anyIn = q('any'), errorEl = q('error'), gamutEl = q('gamut');
  const fields = [...root.querySelectorAll('input[data-format]')];

  function contrastRow(key, bg) {
    const ratio = contrast(color, bg);
    const w = wcag(ratio);
    const badge = (name, ok) => `<span class="cp-badge ${ok ? 'pass' : 'fail'}">${name}<span class="ap-sr"> ${esc(t(ok ? 'cp.pass' : 'cp.fail'))}</span><span aria-hidden="true">${ok ? ' ✓' : ' ✕'}</span></span>`;
    return `<div class="cp-crow"><span class="cp-cbg" style="--bg:${bg};--fg:${esc(toCss(color))}" aria-hidden="true">Aa</span>
      <span>${h(key)}</span><strong>${ratio.toFixed(2)}:1</strong>${badge('AA', w.aa)}${badge('AAA', w.aaa)}</div>`;
  }

  // Redraws every part except the field the user is typing in.
  function render(except) {
    const css = toCss(color);
    const opaque = format({ ...color, alpha: 1 }, 'hex');
    root.style.setProperty('--cp-hue', `hsl(${hsv.h} 100% 50%)`);
    root.style.setProperty('--cp-color', css);
    root.style.setProperty('--cp-opaque', opaque);
    thumb.style.left = `${hsv.s * 100}%`;
    thumb.style.top = `${(1 - hsv.v) * 100}%`;
    q('areaValue').textContent = t('cp.areaValue', { s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100) });
    if (except !== hueIn) hueIn.value = String(Math.round(hsv.h));
    if (except !== alphaIn) alphaIn.value = String(Math.round(color.alpha * 100));
    hueIn.setAttribute('aria-valuetext', `${Math.round(hsv.h)}°`);
    alphaIn.setAttribute('aria-valuetext', `${Math.round(color.alpha * 100)}%`);
    q('hueOut').textContent = `${Math.round(hsv.h)}°`;
    q('alphaOut').textContent = `${Math.round(color.alpha * 100)}%`;
    q('preview').setAttribute('aria-label', t('cp.preview', { value: css }));
    for (const input of fields) {
      if (input === except) continue;
      const text = format(color, input.dataset.format);
      input.value = text ?? '';
      input.placeholder = text ? '' : t('cp.noName');
      input.removeAttribute('aria-invalid');
    }
    if (except !== anyIn) { anyIn.value = ''; anyIn.removeAttribute('aria-invalid'); }
    const g = gamut(color);
    gamutEl.hidden = g.inGamut;
    gamutEl.textContent = g.inGamut ? '' : t('cp.gamut', { clipped: format(g.mapped, 'hex') });
    q('contrast').innerHTML = `<p class="cp-chead">${h('cp.contrast')}</p>${contrastRow('cp.onDark', BACKGROUNDS.dark)}${contrastRow('cp.onLight', BACKGROUNDS.light)}`;
  }

  function commit(except) {
    if (!except || except.dataset?.role !== 'any') errorEl.textContent = '';
    render(except);
    onChange(toCss(color), { ...color });
  }

  // From the area / sliders (always inside sRGB).
  function setHsv(next, except) {
    hsv = { h: next.h ?? hsv.h, s: Math.min(1, Math.max(0, next.s ?? hsv.s)), v: Math.min(1, Math.max(0, next.v ?? hsv.v)) };
    color = fromHsv({ ...hsv, alpha: color.alpha });
    commit(except);
  }

  // From text: keeps wide-gamut values exactly; keeps the hue for greys.
  function setColor(next, except) {
    color = { r: next.r, g: next.g, b: next.b, alpha: next.alpha };
    const n = toHsv(color);
    hsv = { h: n.s < 1e-6 || n.v < 1e-6 ? hsv.h : n.h, s: n.s, v: n.v };
    commit(except);
  }

  // ----- 2-D area: pointer -----
  function fromPointer(e) {
    const r = area.getBoundingClientRect();
    setHsv({ s: (e.clientX - r.left) / r.width, v: 1 - (e.clientY - r.top) / r.height });
  }
  area.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    area.setPointerCapture?.(e.pointerId);
    thumb.focus({ preventScroll: true });
    fromPointer(e);
    e.preventDefault();
  });
  area.addEventListener('pointermove', (e) => { if (area.hasPointerCapture?.(e.pointerId)) fromPointer(e); });

  // ----- 2-D area: keyboard -----
  thumb.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves = {
      ArrowLeft: { s: hsv.s - step }, ArrowRight: { s: hsv.s + step },
      ArrowUp: { v: hsv.v + step }, ArrowDown: { v: hsv.v - step },
      PageUp: { v: hsv.v + 0.1 }, PageDown: { v: hsv.v - 0.1 },
      Home: e.ctrlKey ? { v: 1 } : { s: 0 }, End: e.ctrlKey ? { v: 0 } : { s: 1 },
    };
    if (!moves[e.key]) return;
    e.preventDefault();
    setHsv(moves[e.key]);
  });

  // ----- sliders (native keys plus Shift+arrow for steps of 10) -----
  function bigSteps(input, max) {
    input.addEventListener('keydown', (e) => {
      if (!e.shiftKey) return;
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      input.value = String(Math.min(max, Math.max(0, Number(input.value) + dir * 10)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  bigSteps(hueIn, 360);
  bigSteps(alphaIn, 100);
  hueIn.addEventListener('input', () => setHsv({ h: Number(hueIn.value) % 360 }, hueIn));
  alphaIn.addEventListener('input', () => {
    color = { ...(inGamut(color) ? color : fromHsv({ ...hsv, alpha: color.alpha })), alpha: Number(alphaIn.value) / 100 };
    commit(alphaIn);
  });

  // ----- text fields -----
  function onText(input) {
    const raw = input.value.trim();
    if (!raw) return;
    const parsed = parse(raw);
    if (!parsed) {
      input.setAttribute('aria-invalid', 'true');
      errorEl.textContent = t('cp.invalid');
      return;
    }
    input.removeAttribute('aria-invalid');
    errorEl.textContent = '';
    setColor(parsed, input);
  }
  for (const input of [...fields, anyIn]) {
    input.addEventListener('input', () => onText(input));
    input.addEventListener('blur', () => { if (input !== anyIn || !input.getAttribute('aria-invalid')) render(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); render(); } });
  }

  // ----- copy buttons and swatches -----
  root.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const input = root.querySelector(`input[data-format="${copy.dataset.copy}"]`);
      if (!input.value) return;
      const ok = await copyText(input.value, input);
      notify(t(ok ? 'cp.copied' : 'cp.copyFailed'), { kind: ok ? 'success' : 'warn', detail: ok ? input.value : '' });
      return;
    }
    const swatch = e.target.closest('.cp-swatch');
    if (swatch) setColor(parse(swatch.dataset.value));
  });

  render();

  root.getValue = () => toCss(color);
  root.getColor = () => ({ ...color });
  root.setValue = (v) => {
    const parsed = typeof v === 'string' ? parse(v) : v;
    if (!parsed) return false;
    color = { r: parsed.r, g: parsed.g, b: parsed.b, alpha: parsed.alpha ?? 1 };
    const n = toHsv(color);
    hsv = { h: n.s < 1e-6 ? hsv.h : n.h, s: n.s, v: n.v };
    render();
    return true;
  };
  return root;
}

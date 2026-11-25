// Local file converter screen: data formats, images, text encodings and batch.
import { t, h, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import {
  DATA_FORMATS, EXTENSIONS, MIME, IMAGE_TYPES, ENCODINGS, parse, serialize, detectFormat, convertEncoding, decodeBytes, encodeString,
  encodeBmp, hasTransparency, replaceExtension, ConvertError,
} from './convert.js';
import { xmlToValue, valueToXml } from './convert-xml.js';
import { formatBytes } from './base64.js';
import { L, uid, nextTick, debounce, onLanguage, copyText, downloadBlob, downloadText, dropZone, dropZoneHtml, fail, selectInTextarea, offsetOf, formatNumber } from './ui-common.js';

const ALL_FORMATS = [...DATA_FORMATS, 'xml'];
const fmtLabel = (f) => h(`tools.cv.fmt.${f}`);
const fmtOptions = (withAuto) => (withAuto ? `<option value="auto" data-i18n="tools.cv.auto">${h('tools.cv.auto')}</option>` : '')
  + ALL_FORMATS.map((f) => `<option value="${f}" data-i18n="tools.cv.fmt.${f}">${fmtLabel(f)}</option>`).join('');
const encOptions = (withAuto) => (withAuto ? `<option value="auto" data-i18n="tools.cv.detect">${h('tools.cv.detect')}</option>` : '')
  + ENCODINGS.map((e) => `<option value="${e}" data-i18n="tools.cv.enc.${e}">${h(`tools.cv.enc.${e}`)}</option>`).join('');
const imgOptions = () => Object.keys(IMAGE_TYPES).map((k) => `<option value="${k}">${k.toUpperCase()}</option>`).join('');

// ---------- shared conversion pipeline ----------

export function convertData(text, from, to, { inferTypes = false, unflatten = false, filename = '' } = {}) {
  const source = from === 'auto' ? detectFormat(text, filename) : from;
  const parsed = source === 'xml' ? xmlToValue(text) : parse(text, source, { inferTypes, unflatten });
  const out = to === 'xml' ? valueToXml(parsed.value) : serialize(parsed.value, to);
  const notices = [...parsed.notices, ...out.notices];
  if (['csv', 'tsv', 'markdown', 'html'].includes(source) && !inferTypes && ['json', 'yaml', 'ndjson'].includes(to)) notices.push({ code: 'allText', lossy: false, vars: {} });
  return { source, output: out.text, notices, lossy: notices.some((n) => n.lossy) };
}

function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return 'utf-8'; } catch { return 'latin1'; }
}

function parseCssColor(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(value || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export async function convertImage(file, target, { quality = 0.9, background = '#ffffff' } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new ConvertError('imageDecode', 'The browser could not read this image'); }
  const { width, height } = bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const transparent = hasTransparency(pixels);
  const notices = [];
  let blob;
  if (target === 'bmp') {
    blob = new Blob([encodeBmp(width, height, pixels, parseCssColor(background))], { type: 'image/bmp' });
  } else {
    if (target === 'jpeg' && transparent) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    blob = await new Promise((resolve) => canvas.toBlob(resolve, IMAGE_TYPES[target], quality));
    if (!blob || blob.type !== IMAGE_TYPES[target]) throw new ConvertError('imageEncode', 'This browser cannot write this image format', { vars: { format: target.toUpperCase() } });
  }
  if ((target === 'jpeg' || target === 'bmp') && transparent) notices.push({ code: 'transparencyFlattened', lossy: true, vars: { color: background } });
  if (target === 'jpeg' || target === 'webp') notices.push({ code: 'lossyCompression', lossy: true, vars: { quality: Math.round(quality * 100) } });
  if (file.type === 'image/gif') notices.push({ code: 'firstFrameOnly', lossy: true, vars: {} });
  notices.push({ code: 'metadataDropped', lossy: true, vars: {} });
  return { blob, width, height, notices, transparent };
}

// ---------- rendering helpers ----------

function noticeList(notices) {
  if (!notices.length) return `<p class="tl-clean">${L('tools.cv.nothingLost')}</p>`;
  const lossy = notices.some((n) => n.lossy);
  return `<p class="tl-summary ${lossy ? 'lossy' : ''}">${h(lossy ? 'tools.cv.lossySummary' : 'tools.cv.changedSummary')}</p>
    <ul class="tl-notices">${notices.map((n) => `<li class="${n.lossy ? 'lossy' : 'info'}"><span class="tl-badge">${h(n.lossy ? 'tools.cv.lossy' : 'tools.cv.changed')}</span> <span>${h(`tools.cv.n.${n.code}`, n.vars)}</span></li>`).join('')}</ul>`;
}

function errorText(e) {
  if (e instanceof ConvertError) {
    const where = e.line ? ` ${t('tools.at', { line: e.line, column: e.column })}` : '';
    // Only parser messages that are not fully translated carry an extra technical detail.
    const detail = ['json', 'ndjson', 'xml'].includes(e.code) ? e.reason : '';
    return { message: `${t(`tools.cv.err.${e.code}`, e.vars)}${where}`, detail };
  }
  return { message: t('tools.cv.err.unexpected'), detail: String(e?.message || e) };
}

// ---------- screen ----------

export function mountConvert(root) {
  const id = uid('cv');
  root.innerHTML = `
  <section class="tl-section" aria-labelledby="${id}-dh">
    <h3 id="${id}-dh" class="tl-h">${L('tools.cv.dataHeading')}</h3>
    <p class="muted">${L('tools.cv.dataIntro')}</p>
    <div class="tl-options">
      <label class="tl-field"><span>${L('tools.cv.from')}</span><select data-from>${fmtOptions(true)}</select></label>
      <label class="tl-field"><span>${L('tools.cv.to')}</span><select data-to>${fmtOptions(false)}</select></label>
      <label class="tl-check"><input type="checkbox" data-infer> ${L('tools.cv.inferTypes')}</label>
      <label class="tl-check"><input type="checkbox" data-unflatten> ${L('tools.cv.unflatten')}</label>
      <label class="tl-check"><input type="checkbox" data-live checked> ${L('tools.cv.live')}</label>
    </div>
    ${dropZoneHtml({ id: `${id}-dfile`, labelKey: 'tools.chooseFile', hintKey: 'tools.dropHint' })}
    <div class="tl-split">
      <div class="tl-pane">
        <label class="tl-label" for="${id}-in">${L('tools.cv.input')}</label>
        <textarea id="${id}-in" class="tl-area tl-mono" spellcheck="false" data-in></textarea>
        <p class="tl-stats muted" data-in-stats></p>
      </div>
      <div class="tl-pane">
        <label class="tl-label" for="${id}-out">${L('tools.cv.output')}</label>
        <textarea id="${id}-out" class="tl-area tl-mono" spellcheck="false" readonly data-out></textarea>
        <p class="tl-stats muted" data-out-stats></p>
      </div>
    </div>
    <div class="tl-actions">
      <button type="button" class="btn primary small" data-act="convert">${L('tools.cv.convert')}</button>
      <button type="button" class="btn small" data-act="swap">${L('tools.cv.swap')}</button>
      <button type="button" class="btn small" data-act="copy">${L('tools.copy')}</button>
      <button type="button" class="btn small" data-act="download">${L('tools.download')}</button>
    </div>
    <div class="tl-report" role="status" aria-live="polite" data-report></div>
  </section>

  <section class="tl-section" aria-labelledby="${id}-ih">
    <h3 id="${id}-ih" class="tl-h">${L('tools.cv.imageHeading')}</h3>
    <p class="muted">${L('tools.cv.imageIntro')}</p>
    ${dropZoneHtml({ id: `${id}-ifile`, labelKey: 'tools.chooseImage', hintKey: 'tools.dropHint', accept: 'image/*' }).replace('data-drop', 'data-drop-image')}
    <div class="tl-options">
      <label class="tl-field"><span>${L('tools.cv.imageTarget')}</span><select data-img-target>${imgOptions()}</select></label>
      <label class="tl-field tl-range"><span>${L('tools.cv.quality')} <output data-quality-out>90</output>%</span>
        <input type="range" min="10" max="100" step="1" value="90" data-quality></label>
      <label class="tl-field"><span>${L('tools.cv.background')}</span><input type="color" value="#ffffff" data-bg></label>
      <button type="button" class="btn primary small" data-act="image" disabled>${L('tools.cv.convertImage')}</button>
    </div>
    <div class="tl-images">
      <figure class="tl-preview" data-img-before hidden><img alt=""><figcaption></figcaption></figure>
      <figure class="tl-preview" data-img-after hidden><img alt=""><figcaption></figcaption>
        <button type="button" class="btn small" data-act="image-download">${L('tools.download')}</button></figure>
    </div>
    <div class="tl-report" role="status" aria-live="polite" data-img-report></div>
  </section>

  <section class="tl-section" aria-labelledby="${id}-eh">
    <h3 id="${id}-eh" class="tl-h">${L('tools.cv.encHeading')}</h3>
    <p class="muted">${L('tools.cv.encIntro')}</p>
    ${dropZoneHtml({ id: `${id}-efile`, labelKey: 'tools.chooseFile', hintKey: 'tools.dropHint' }).replace('data-drop', 'data-drop-enc')}
    <div class="tl-options">
      <label class="tl-field"><span>${L('tools.cv.encFrom')}</span><select data-enc-from>${encOptions(true)}</select></label>
      <label class="tl-field"><span>${L('tools.cv.encTo')}</span><select data-enc-to>${encOptions(false)}</select></label>
      <label class="tl-check"><input type="checkbox" data-bom> ${L('tools.cv.bom')}</label>
      <button type="button" class="btn primary small" data-act="encode">${L('tools.cv.reencode')}</button>
    </div>
    <label class="tl-label" for="${id}-etext">${L('tools.cv.encText')}</label>
    <textarea id="${id}-etext" class="tl-area tl-short" spellcheck="false" data-enc-text></textarea>
    <p class="tl-stats muted" data-enc-source></p>
    <div class="tl-report" role="status" aria-live="polite" data-enc-report></div>
  </section>

  <section class="tl-section" aria-labelledby="${id}-bh">
    <h3 id="${id}-bh" class="tl-h">${L('tools.cv.batchHeading')}</h3>
    <p class="muted">${L('tools.cv.batchIntro')}</p>
    ${dropZoneHtml({ id: `${id}-bfile`, labelKey: 'tools.chooseFiles', hintKey: 'tools.dropHintMany', multiple: true }).replace('data-drop', 'data-drop-batch')}
    <div class="tl-options">
      <label class="tl-field"><span>${L('tools.cv.batchData')}</span><select data-b-data>${fmtOptions(false)}</select></label>
      <label class="tl-field"><span>${L('tools.cv.batchImage')}</span><select data-b-image>${imgOptions()}</select></label>
      <label class="tl-field"><span>${L('tools.cv.batchText')}</span><select data-b-text>${encOptions(false)}</select></label>
      <button type="button" class="btn primary small" data-act="batch" disabled>${L('tools.cv.convertAll')}</button>
      <button type="button" class="btn small" data-act="batch-download" disabled>${L('tools.cv.downloadAll')}</button>
      <button type="button" class="btn quiet small" data-act="batch-clear">${L('tools.clear')}</button>
    </div>
    <div class="tl-table-wrap"><table class="tl-table" data-batch-table hidden>
      <caption class="sr-only">${L('tools.cv.batchCaption')}</caption>
      <thead><tr><th scope="col">${L('tools.cv.colFile')}</th><th scope="col">${L('tools.cv.colKind')}</th><th scope="col">${L('tools.size')}</th><th scope="col">${L('tools.cv.colResult')}</th><th scope="col"><span class="sr-only">${L('tools.download')}</span></th></tr></thead>
      <tbody data-batch-rows></tbody>
    </table></div>
  </section>`;

  const $ = (sel) => root.querySelector(sel);

  // ----- data -----
  const input = $('[data-in]');
  const output = $('[data-out]');
  const report = $('[data-report]');
  let dataFile = '';
  let lastResult = null;
  let lastError = null;

  const stats = (text) => t('tools.cv.textStats', { chars: formatNumber(text.length), lines: formatNumber(text ? text.split('\n').length : 0) });

  const runData = ({ quiet = false } = {}) => {
    $('[data-in-stats]').textContent = stats(input.value);
    if (!input.value.trim()) { output.value = ''; report.innerHTML = ''; lastResult = null; $('[data-out-stats]').textContent = ''; return; }
    try {
      const r = convertData(input.value, $('[data-from]').value, $('[data-to]').value, { inferTypes: $('[data-infer]').checked, unflatten: $('[data-unflatten]').checked, filename: dataFile });
      lastResult = r;
      lastError = null;
      output.value = r.output;
      $('[data-out-stats]').textContent = stats(r.output);
      report.innerHTML = `<p class="muted">${h('tools.cv.readAs', { format: t(`tools.cv.fmt.${r.source}`) })}</p>${noticeList(r.notices)}`;
    } catch (e) {
      lastResult = null;
      lastError = e;
      const { message, detail } = errorText(e);
      output.value = '';
      report.innerHTML = `<div class="tl-status error"><strong>${esc(message)}</strong> <span class="muted">${esc(detail)}</span>
        ${e.line ? `<button type="button" class="btn small" data-act="goto">${L('tools.showProblem')}</button>` : ''}</div>`;
      if (!quiet) fail(message, detail);
    }
  };
  const live = debounce(() => { if ($('[data-live]').checked) runData({ quiet: true }); }, 200);
  input.addEventListener('input', live);
  for (const sel of ['[data-from]', '[data-to]', '[data-infer]', '[data-unflatten]']) $(sel).addEventListener('change', () => { if (input.value) runData({ quiet: true }); });

  dropZone($('[data-drop]'), async (files) => {
    const file = files[0];
    dataFile = file.name;
    input.value = await file.text();
    $('[data-from]').value = 'auto';
    runData();
  });

  // ----- images -----
  let imageFile = null;
  let imageResult = null;
  const quality = $('[data-quality]');
  const syncQuality = () => {
    $('[data-quality-out]').textContent = quality.value;
    const lossyTarget = ['jpeg', 'webp'].includes($('[data-img-target]').value);
    quality.disabled = !lossyTarget;
  };
  quality.addEventListener('input', syncQuality);
  $('[data-img-target]').addEventListener('change', syncQuality);
  syncQuality();

  const showFigure = (fig, src, caption, alt) => {
    const img = fig.querySelector('img');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = src;
    img.src = src;
    img.alt = alt;
    fig.querySelector('figcaption').textContent = caption;
    fig.hidden = false;
  };

  dropZone($('[data-drop-image]'), async (files) => {
    imageFile = files.find((f) => f.type.startsWith('image/')) || files[0];
    imageResult = null;
    $('[data-img-after]').hidden = true;
    $('[data-img-report]').innerHTML = '';
    let dims = '';
    try { const bmp = await createImageBitmap(imageFile); dims = `${bmp.width}×${bmp.height}`; bmp.close?.(); } catch { dims = t('tools.cv.unreadable'); }
    showFigure($('[data-img-before]'), URL.createObjectURL(imageFile), t('tools.cv.before', { name: imageFile.name, type: imageFile.type || '?', size: formatBytes(imageFile.size), dims }), t('tools.cv.beforeAlt'));
    $('[data-act="image"]').disabled = false;
  });

  const runImage = async () => {
    if (!imageFile) return;
    const target = $('[data-img-target]').value;
    try {
      const r = await convertImage(imageFile, target, { quality: Number(quality.value) / 100, background: $('[data-bg]').value });
      imageResult = { ...r, name: replaceExtension(imageFile.name, target === 'jpeg' ? 'jpg' : target) };
      const change = imageFile.size ? Math.round(((r.blob.size - imageFile.size) / imageFile.size) * 100) : 0;
      showFigure($('[data-img-after]'), URL.createObjectURL(r.blob), t('tools.cv.after', { name: imageResult.name, size: formatBytes(r.blob.size), change: `${change > 0 ? '+' : ''}${change}%`, dims: `${r.width}×${r.height}` }), t('tools.cv.afterAlt'));
      $('[data-img-report]').innerHTML = `<p>${h('tools.cv.sizeReadout', { before: formatBytes(imageFile.size), after: formatBytes(r.blob.size), change: `${change > 0 ? '+' : ''}${change}%` })}</p>${noticeList(r.notices)}`;
      notify(t('tools.cv.imageDone'), { kind: 'success', detail: imageResult.name, speak: false });
    } catch (e) {
      const { message, detail } = errorText(e);
      $('[data-img-report]').innerHTML = `<div class="tl-status error"><strong>${esc(message)}</strong></div>`;
      fail(message, detail);
    }
  };

  // ----- text encodings -----
  let encBytes = null;
  let encName = 'text.txt';
  const encText = $('[data-enc-text]');
  encText.addEventListener('input', () => { encBytes = null; encName = 'text.txt'; $('[data-enc-source]').textContent = t('tools.cv.encFromText'); });
  dropZone($('[data-drop-enc]'), async (files) => {
    const file = files[0];
    encBytes = new Uint8Array(await file.arrayBuffer());
    encName = file.name;
    const from = $('[data-enc-from]').value === 'auto' ? detectEncoding(encBytes) : $('[data-enc-from]').value;
    const d = decodeBytes(encBytes, from);
    encText.value = d.text.length > 200000 ? `${d.text.slice(0, 200000)}\n…` : d.text;
    $('[data-enc-source]').textContent = t('tools.cv.encFromFile', { name: file.name, size: formatBytes(file.size), encoding: t(`tools.cv.enc.${from}`) });
  });

  const runEncoding = () => {
    const to = $('[data-enc-to]').value;
    const bom = $('[data-bom]').checked;
    let result;
    if (encBytes) {
      const from = $('[data-enc-from]').value === 'auto' ? detectEncoding(encBytes) : $('[data-enc-from]').value;
      result = convertEncoding(encBytes, from, to, { bom });
      result.before = encBytes.length;
    } else {
      const e = encodeString(encText.value, to, { bom });
      const notices = [];
      if (e.replaced) notices.push({ code: 'unrepresentable', lossy: true, vars: { count: e.replaced, encoding: to, index: e.firstReplaced } });
      if (bom && to !== 'latin1') notices.push({ code: 'bomAdded', lossy: false, vars: {} });
      result = { bytes: e.bytes, notices, before: new TextEncoder().encode(encText.value).length };
      if (e.replaced && e.firstReplaced >= 0) selectInTextarea(encText, e.firstReplaced, e.firstReplaced + 1);
    }
    if (bom && to === 'latin1') result.notices.push({ code: 'noBomLatin1', lossy: false, vars: {} });
    const name = replaceExtension(encName, `${to}.txt`);
    $('[data-enc-report]').innerHTML = `<p>${h('tools.cv.encReadout', { before: formatBytes(result.before), after: formatBytes(result.bytes.length), encoding: t(`tools.cv.enc.${to}`) })}</p>${noticeList(result.notices)}
      <button type="button" class="btn small" data-act="enc-download">${L('tools.download')}</button>`;
    $('[data-enc-report]').querySelector('[data-act="enc-download"]').onclick = () => downloadBlob(new Blob([result.bytes], { type: 'text/plain' }), name);
  };

  // ----- batch -----
  let batch = []; // { file, kind, status, notices, blob, name, error }
  const kindOf = (file) => {
    const fmt = detectFormat('', file.name);
    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') return 'image';
    if (/\.(json|ya?ml|csv|tsv|tab|ndjson|jsonl|md|markdown|html?|xml|svg)$/i.test(file.name) && ALL_FORMATS.includes(fmt)) return 'data';
    if (file.type.startsWith('text/') || /\.(txt|log|ini|cfg|conf)$/i.test(file.name)) return 'text';
    return 'other';
  };
  const renderBatch = () => {
    const table = $('[data-batch-table]');
    table.hidden = !batch.length;
    $('[data-act="batch"]').disabled = !batch.length;
    $('[data-act="batch-download"]').disabled = !batch.some((b) => b.blob);
    $('[data-batch-rows]').innerHTML = batch.map((b, i) => `<tr>
      <td class="tl-name">${esc(b.file.name)}</td>
      <td>${h(`tools.cv.kind.${b.kind}`)}</td>
      <td>${formatBytes(b.file.size)}</td>
      <td>${b.status === 'error' ? `<span class="tl-err">${esc(b.error)}</span>` : b.status === 'done' ? `${esc(b.name)} · ${formatBytes(b.blob.size)}${noticeList(b.notices)}` : h(`tools.cv.status.${b.status}`)}</td>
      <td>${b.blob ? `<button type="button" class="btn small" data-act="batch-one" data-index="${i}" aria-label="${esc(t('tools.cv.downloadOne', { name: b.name }))}">${L('tools.download')}</button>` : ''}</td>
    </tr>`).join('');
  };
  dropZone($('[data-drop-batch]'), (files) => {
    batch = batch.concat(files.map((file) => ({ file, kind: kindOf(file), status: 'waiting', notices: [] })));
    renderBatch();
  });

  const runBatch = async () => {
    const dataTo = $('[data-b-data]').value;
    const imageTo = $('[data-b-image]').value;
    const textTo = $('[data-b-text]').value;
    let done = 0;
    for (const b of batch) {
      b.status = 'working';
      renderBatch();
      await nextTick();
      try {
        if (b.kind === 'data') {
          const r = convertData(await b.file.text(), 'auto', dataTo, { filename: b.file.name });
          b.blob = new Blob([r.output], { type: `${MIME[dataTo]};charset=utf-8` });
          b.name = replaceExtension(b.file.name, EXTENSIONS[dataTo]);
          b.notices = r.notices;
        } else if (b.kind === 'image') {
          const r = await convertImage(b.file, imageTo, { quality: Number(quality.value) / 100, background: $('[data-bg]').value });
          b.blob = r.blob;
          b.name = replaceExtension(b.file.name, imageTo === 'jpeg' ? 'jpg' : imageTo);
          b.notices = r.notices;
        } else if (b.kind === 'text') {
          const bytes = new Uint8Array(await b.file.arrayBuffer());
          const r = convertEncoding(bytes, detectEncoding(bytes), textTo);
          b.blob = new Blob([r.bytes], { type: 'text/plain' });
          b.name = replaceExtension(b.file.name, `${textTo}.txt`);
          b.notices = r.notices;
        } else {
          b.status = 'skipped';
          continue;
        }
        b.status = 'done';
        done++;
      } catch (e) {
        b.status = 'error';
        b.error = errorText(e).message;
        b.blob = null;
      }
    }
    renderBatch();
    notify(t('tools.cv.batchDone', { done, total: batch.length }), { kind: done === batch.length ? 'success' : 'warn', speak: false });
  };

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'convert': runData(); break;
      case 'swap': {
        if (!lastResult) { runData(); if (!lastResult) return; }
        const to = $('[data-to]').value;
        input.value = output.value;
        $('[data-from]').value = to;
        $('[data-to]').value = lastResult.source === 'xml' || DATA_FORMATS.includes(lastResult.source) ? lastResult.source : 'json';
        dataFile = '';
        runData();
        break;
      }
      case 'copy': copyText(output.value); break;
      case 'download': {
        if (!lastResult) { runData(); if (!lastResult) return; }
        const to = $('[data-to]').value;
        downloadText(lastResult.output, replaceExtension(dataFile || 'converted', EXTENSIONS[to]), MIME[to]);
        break;
      }
      case 'goto': if (lastError?.line) selectInTextarea(input, offsetOf(input.value, lastError.line, lastError.column)); break;
      case 'image': runImage(); break;
      case 'image-download': if (imageResult) downloadBlob(imageResult.blob, imageResult.name); break;
      case 'encode': runEncoding(); break;
      case 'batch': runBatch(); break;
      case 'batch-one': { const b = batch[Number(btn.dataset.index)]; if (b?.blob) downloadBlob(b.blob, b.name); break; }
      case 'batch-download': {
        for (const b of batch) if (b.blob) { downloadBlob(b.blob, b.name); await new Promise((r) => setTimeout(r, 250)); }
        break;
      }
      case 'batch-clear': batch = []; renderBatch(); break;
      default: break;
    }
  });

  onLanguage(root, () => { if (input.value) runData({ quiet: true }); renderBatch(); });
}

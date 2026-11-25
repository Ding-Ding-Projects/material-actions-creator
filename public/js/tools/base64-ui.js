// Base64 toolkit screen.
import { t, h } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import {
  encodeText, decodeText, validateBase64, createEncoder, decodeInChunks, concatBytes, parseDataUri, looksLikeDataUri,
  sniffMime, isImageMime, extensionFor, hexDump, textStats, decodedLength, formatBytes,
} from './base64.js';
import { L, uid, nextTick, debounce, onLanguage, copyText, downloadBlob, dropZone, dropZoneHtml, fail, selectInTextarea, formatNumber } from './ui-common.js';

const CHUNK = 3 * 256 * 1024; // multiple of 3 so chunk boundaries never need padding
const HEX_LIMIT = 4096;

export function mountBase64(root) {
  const id = uid('b64');
  root.innerHTML = `
  <section class="tl-section" aria-labelledby="${id}-h">
    <h3 id="${id}-h" class="tl-h">${L('tools.b64.textHeading')}</h3>
    <div class="tl-options" role="group" aria-label="${t('tools.b64.options')}" data-i18n-aria="tools.b64.options">
      <label class="tl-field"><span>${L('tools.b64.alphabet')}</span>
        <select data-opt="alphabet"><option value="standard" data-i18n="tools.b64.standard">${h('tools.b64.standard')}</option><option value="url" data-i18n="tools.b64.urlSafe">${h('tools.b64.urlSafe')}</option></select></label>
      <label class="tl-field"><span>${L('tools.b64.padding')}</span>
        <select data-opt="pad"><option value="yes" data-i18n="tools.b64.withPadding">${h('tools.b64.withPadding')}</option><option value="no" data-i18n="tools.b64.noPadding">${h('tools.b64.noPadding')}</option></select></label>
      <label class="tl-field"><span>${L('tools.b64.wrap')}</span>
        <select data-opt="wrap"><option value="0" data-i18n="tools.b64.wrapNone">${h('tools.b64.wrapNone')}</option><option value="64">64</option><option value="76">76</option></select></label>
      <label class="tl-check"><input type="checkbox" data-opt="live" checked> ${L('tools.b64.live')}</label>
    </div>
    <div class="tl-split">
      <div class="tl-pane">
        <label class="tl-label" for="${id}-text">${L('tools.b64.plain')}</label>
        <textarea id="${id}-text" class="tl-area" spellcheck="false" data-text></textarea>
        <p class="tl-stats muted" data-text-stats aria-live="polite"></p>
        <div class="tl-actions">
          <button type="button" class="btn primary small" data-act="encode">${L('tools.b64.encode')}</button>
          <button type="button" class="btn small" data-act="copy-text">${L('tools.copy')}</button>
          <button type="button" class="btn quiet small" data-act="clear">${L('tools.clear')}</button>
        </div>
      </div>
      <div class="tl-pane">
        <label class="tl-label" for="${id}-b64">${L('tools.b64.encoded')}</label>
        <textarea id="${id}-b64" class="tl-area tl-mono" spellcheck="false" data-b64 aria-describedby="${id}-status"></textarea>
        <p class="tl-stats muted" data-b64-stats aria-live="polite"></p>
        <div class="tl-actions">
          <button type="button" class="btn primary small" data-act="decode">${L('tools.b64.decode')}</button>
          <button type="button" class="btn small" data-act="copy-b64">${L('tools.copy')}</button>
          <button type="button" class="btn small" data-act="copy-uri">${L('tools.b64.copyDataUri')}</button>
        </div>
      </div>
    </div>
    <div class="tl-status" id="${id}-status" role="status" aria-live="polite" data-status></div>
  </section>

  <section class="tl-section" aria-labelledby="${id}-fh">
    <h3 id="${id}-fh" class="tl-h">${L('tools.b64.fileHeading')}</h3>
    <p class="muted">${L('tools.b64.fileIntro')}</p>
    ${dropZoneHtml({ id: `${id}-file`, labelKey: 'tools.chooseFile', hintKey: 'tools.dropHint' })}
    <div class="tl-progress" data-progress hidden>
      <progress max="100" value="0" aria-labelledby="${id}-plabel"></progress>
      <span id="${id}-plabel" data-progress-label></span>
      <button type="button" class="btn quiet small" data-act="cancel">${L('tools.cancel')}</button>
    </div>
    <dl class="tl-facts" data-file-facts hidden></dl>
    <label class="tl-label" for="${id}-uri">${L('tools.b64.dataUri')}</label>
    <textarea id="${id}-uri" class="tl-area tl-mono tl-short" spellcheck="false" readonly data-uri></textarea>
  </section>

  <section class="tl-section" aria-labelledby="${id}-ih">
    <h3 id="${id}-ih" class="tl-h">${L('tools.b64.inspectHeading')}</h3>
    <p class="muted">${L('tools.b64.inspectIntro')}</p>
    <div class="tl-options">
      <label class="tl-field grow"><span>${L('tools.b64.fileName')}</span><input type="text" data-name value="decoded.bin" spellcheck="false"></label>
      <label class="tl-field"><span>${L('tools.b64.mime')}</span><input type="text" data-mime value="" spellcheck="false" placeholder="application/octet-stream"></label>
      <button type="button" class="btn primary small" data-act="download">${L('tools.b64.download')}</button>
    </div>
    <dl class="tl-facts" data-decoded-facts></dl>
    <figure class="tl-preview" data-preview hidden><img alt="" data-preview-img><figcaption class="muted">${L('tools.b64.previewCaption')}</figcaption></figure>
    <h4 class="tl-sub">${L('tools.b64.hex')}</h4>
    <pre class="tl-hex" tabindex="0" data-hex aria-label="${t('tools.b64.hex')}" data-i18n-aria="tools.b64.hex"></pre>
  </section>`;

  const $ = (sel) => root.querySelector(sel);
  const text = $('[data-text]');
  const b64 = $('[data-b64]');
  const uri = $('[data-uri]');
  const status = $('[data-status]');
  const opt = (name) => $(`[data-opt="${name}"]`);
  const options = () => ({ urlSafe: opt('alphabet').value === 'url', pad: opt('pad').value === 'yes', wrap: Number(opt('wrap').value) });

  let lastError = null;
  let decoded = null; // { bytes, mime }
  let job = null; // running file job { cancelled }
  let previewUrl = '';

  const setStatus = (kind, html) => {
    status.className = `tl-status ${kind}`;
    status.innerHTML = html;
  };

  const showTextStats = () => {
    const s = textStats(text.value);
    $('[data-text-stats]').textContent = t('tools.b64.textStats', { chars: formatNumber(s.chars), bytes: formatNumber(s.bytes), lines: formatNumber(s.lines) });
  };
  const showB64Stats = (cleanLength) => {
    const chars = b64.value.length;
    $('[data-b64-stats]').textContent = cleanLength >= 0
      ? t('tools.b64.b64Stats', { chars: formatNumber(chars), bytes: formatNumber(decodedLength(cleanLength)) })
      : t('tools.b64.b64StatsInvalid', { chars: formatNumber(chars) });
  };

  const showError = (e) => {
    lastError = e;
    const where = e.line ? t('tools.b64.at', { line: e.line, column: e.column }) : '';
    setStatus('error', `<strong>${h(`tools.b64.err.${e.code}`, { char: e.char, index: e.index })}</strong> <span>${where}</span>
      ${e.index >= 0 && e.line ? `<button type="button" class="btn small" data-act="goto">${L('tools.showProblem')}</button>` : ''}`);
  };

  // ---- decoded bytes inspector ----
  const setDecoded = (bytes, mime) => {
    const sniffed = sniffMime(bytes.subarray(0, 512));
    const type = mime || sniffed || 'application/octet-stream';
    decoded = { bytes, mime: type };
    $('[data-mime]').value = type;
    const name = $('[data-name]');
    if (/^decoded\.[a-z0-9.]+$/.test(name.value)) name.value = `decoded.${extensionFor(type)}`;
    renderDecoded();
  };
  const renderDecoded = () => {
    const facts = $('[data-decoded-facts]');
    const hex = $('[data-hex]');
    const preview = $('[data-preview]');
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; }
    if (!decoded) { facts.innerHTML = ''; hex.textContent = ''; preview.hidden = true; return; }
    const { bytes, mime } = decoded;
    facts.innerHTML = `<div><dt>${L('tools.size')}</dt><dd>${formatBytes(bytes.length)} (${formatNumber(bytes.length)} B)</dd></div>
      <div><dt>${L('tools.b64.mime')}</dt><dd>${mime}</dd></div>
      <div><dt>${L('tools.b64.detected')}</dt><dd>${sniffMime(bytes.subarray(0, 512)) || h('tools.b64.unknown')}</dd></div>`;
    hex.textContent = bytes.length
      ? hexDump(bytes, { length: HEX_LIMIT }) + (bytes.length > HEX_LIMIT ? `\n${t('tools.b64.hexTruncated', { shown: formatNumber(HEX_LIMIT), total: formatNumber(bytes.length) })}` : '')
      : t('tools.b64.empty');
    if (isImageMime(mime) && bytes.length) {
      previewUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      $('[data-preview-img]').src = previewUrl;
      $('[data-preview-img]').alt = t('tools.b64.previewAlt', { mime });
      preview.hidden = false;
    } else preview.hidden = true;
  };

  // ---- text <-> Base64 ----
  const encodeNow = () => {
    try {
      b64.value = encodeText(text.value, options());
      const v = validateBase64(b64.value);
      showB64Stats(v.ok ? v.clean.length : -1);
      showTextStats();
      setDecoded(new TextEncoder().encode(text.value), 'text/plain;charset=utf-8');
      uri.value = text.value ? `data:text/plain;charset=utf-8;base64,${encodeText(text.value)}` : '';
      lastError = null;
      setStatus('ok', h('tools.b64.encodedOk'));
    } catch (e) {
      fail(t('tools.b64.encodeFailed'), e.message);
    }
  };

  const decodeNow = ({ quiet = false } = {}) => {
    const value = b64.value;
    if (!value.trim()) { showB64Stats(0); setStatus('', ''); decoded = null; renderDecoded(); return; }
    if (looksLikeDataUri(value)) {
      try {
        const parsed = parseDataUri(value);
        showB64Stats(-1);
        setDecoded(parsed.bytes, parsed.mime);
        uri.value = value.trim();
        lastError = null;
        if (/^text\//.test(parsed.mime) || parsed.mime === 'application/json') {
          try { text.value = new TextDecoder('utf-8', { fatal: true }).decode(parsed.bytes); showTextStats(); } catch { /* binary */ }
        }
        setStatus('ok', h('tools.b64.dataUriOk', { mime: parsed.mime, size: formatBytes(parsed.bytes.length) }));
      } catch (e) { showError(e); if (!quiet) fail(t(`tools.b64.err.${e.code}`, { char: e.char, index: e.index })); }
      return;
    }
    const v = validateBase64(value);
    if (!v.ok) {
      showB64Stats(-1);
      showError(v.error);
      if (!quiet) fail(t(`tools.b64.err.${v.error.code}`, { char: v.error.char, index: v.error.index }));
      return;
    }
    showB64Stats(v.clean.length);
    const bytes = concatBytes([...decodeInChunks(v.clean)]);
    setDecoded(bytes, '');
    uri.value = `data:${decoded.mime};base64,${toStandard(v.clean)}`;
    try {
      text.value = decodeText(value);
      showTextStats();
      lastError = null;
      setStatus('ok', h('tools.b64.decodedOk', { alphabet: t(`tools.b64.alpha.${v.alphabet}`) }));
    } catch (e) {
      lastError = null;
      setStatus('warn', h('tools.b64.binary', { size: formatBytes(bytes.length) }));
    }
  };

  const toStandard = (clean) => {
    const s = clean.replace(/-/g, '+').replace(/_/g, '/');
    return s + '='.repeat((4 - (s.length % 4)) % 4);
  };

  const liveText = debounce(() => { if (opt('live').checked) encodeNow(); else showTextStats(); }, 120);
  const liveB64 = debounce(() => { if (opt('live').checked) decodeNow({ quiet: true }); else showB64Stats(-1); }, 160);
  text.addEventListener('input', liveText);
  b64.addEventListener('input', liveB64);
  for (const name of ['alphabet', 'pad', 'wrap']) opt(name).addEventListener('change', () => { if (text.value) encodeNow(); });

  // ---- file -> Base64 (chunked) ----
  const progress = $('[data-progress]');
  const setProgress = (done, total, labelKey) => {
    progress.hidden = false;
    progress.querySelector('progress').value = total ? Math.round((done / total) * 100) : 0;
    $('[data-progress-label]').textContent = t(labelKey, { done: formatBytes(done), total: formatBytes(total) });
  };

  const encodeFile = async (file) => {
    if (job) job.cancelled = true;
    const mine = { cancelled: false };
    job = mine;
    const opts = options();
    const enc = createEncoder(opts);
    const plain = createEncoder({}); // the data URI always uses the standard alphabet, unwrapped
    const parts = [];
    const uriParts = [];
    let head = new Uint8Array(0);
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      if (mine.cancelled) { progress.hidden = true; notify(t('tools.cancelled'), { kind: 'info' }); return; }
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
      if (offset === 0) head = bytes.slice(0, HEX_LIMIT);
      parts.push(enc.push(bytes));
      uriParts.push(plain.push(bytes));
      setProgress(Math.min(file.size, offset + CHUNK), file.size, 'tools.b64.encoding');
      await nextTick();
    }
    parts.push(enc.end());
    uriParts.push(plain.end());
    if (mine.cancelled) return;
    job = null;
    const sniffed = sniffMime(head);
    const mime = file.type || sniffed || 'application/octet-stream';
    b64.value = parts.join('');
    uri.value = `data:${mime};base64,${uriParts.join('')}`;
    text.value = '';
    showTextStats();
    $('[data-b64-stats]').textContent = t('tools.b64.b64Stats', { chars: formatNumber(b64.value.length), bytes: formatNumber(file.size) });
    const facts = $('[data-file-facts]');
    facts.hidden = false;
    facts.innerHTML = `<div><dt>${L('tools.b64.fileName')}</dt><dd>${escapeText(file.name)}</dd></div>
      <div><dt>${L('tools.size')}</dt><dd>${formatBytes(file.size)} (${formatNumber(file.size)} B)</dd></div>
      <div><dt>${L('tools.b64.mime')}</dt><dd>${escapeText(mime)}</dd></div>
      <div><dt>${L('tools.b64.encodedSize')}</dt><dd>${formatBytes(b64.value.length)}</dd></div>`;
    // Inspector: keep the head for hex, the File itself for preview and download.
    decoded = { bytes: head, mime };
    $('[data-mime]').value = mime;
    $('[data-name]').value = file.name;
    renderDecoded();
    if (file.size > HEX_LIMIT) {
      $('[data-hex]').textContent = hexDump(head) + `\n${t('tools.b64.hexTruncated', { shown: formatNumber(head.length), total: formatNumber(file.size) })}`;
      $('[data-decoded-facts]').querySelector('dd').textContent = `${formatBytes(file.size)} (${formatNumber(file.size)} B)`;
    }
    if (isImageMime(mime)) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      $('[data-preview-img]').src = previewUrl;
      $('[data-preview-img]').alt = t('tools.b64.previewAlt', { mime });
      $('[data-preview]').hidden = false;
    }
    progress.hidden = true;
    setStatus('ok', h('tools.b64.fileOk', { name: file.name, size: formatBytes(file.size) }));
    notify(t('tools.b64.fileOkShort'), { kind: 'success', detail: file.name, speak: false });
  };

  // ---- Base64 -> file download (chunked) ----
  const download = async () => {
    const value = b64.value;
    let bytes;
    let mime = $('[data-mime]').value.trim() || 'application/octet-stream';
    if (looksLikeDataUri(value)) {
      try { const p = parseDataUri(value); bytes = p.bytes; if (!$('[data-mime]').value.trim()) mime = p.mime; } catch (e) { showError(e); fail(t(`tools.b64.err.${e.code}`, { char: e.char, index: e.index })); return; }
    } else {
      const v = validateBase64(value);
      if (!v.ok) { showError(v.error); fail(t(`tools.b64.err.${v.error.code}`, { char: v.error.char, index: v.error.index })); return; }
      const parts = [];
      const total = v.clean.length;
      let done = 0;
      const step = 4 * 256 * 1024;
      for (const part of decodeInChunks(v.clean, step)) {
        parts.push(part);
        done = Math.min(total, done + step);
        if (total > step) { setProgress(decodedLength(done), decodedLength(total), 'tools.b64.decoding'); await nextTick(); }
      }
      progress.hidden = true;
      bytes = concatBytes(parts);
    }
    const name = $('[data-name]').value.trim() || `decoded.${extensionFor(mime)}`;
    downloadBlob(new Blob([bytes], { type: mime }), name);
    notify(t('tools.downloaded'), { kind: 'success', detail: `${name} · ${formatBytes(bytes.length)}`, speak: false });
  };

  dropZone($('[data-drop]'), (files) => encodeFile(files[0]));

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'encode': encodeNow(); break;
      case 'decode': decodeNow(); break;
      case 'copy-text': copyText(text.value); break;
      case 'copy-b64': copyText(b64.value); break;
      case 'copy-uri': {
        if (!uri.value && text.value) encodeNow();
        copyText(uri.value);
        break;
      }
      case 'clear': text.value = ''; b64.value = ''; uri.value = ''; decoded = null; renderDecoded(); showTextStats(); showB64Stats(0); setStatus('', ''); break;
      case 'cancel': if (job) job.cancelled = true; break;
      case 'download': download(); break;
      case 'goto': if (lastError && lastError.index >= 0) selectInTextarea(b64, lastError.index); break;
      default: break;
    }
  });

  onLanguage(root, () => { showTextStats(); if (decoded) renderDecoded(); });
  showTextStats();
  showB64Stats(0);
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

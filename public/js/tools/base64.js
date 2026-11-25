// Base64 toolkit: pure logic with no DOM access, so it runs in Node tests too.
// Handles standard and URL-safe alphabets, optional padding, line wrapping,
// streaming (chunked) encoding, strict validation with exact error positions,
// data URIs, MIME sniffing and hex dumps.

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) table[STD.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

export const WRAP_WIDTHS = [0, 64, 76];

export class Base64Error extends Error {
  constructor(code, message, { index = -1, line = 0, column = 0, char = '' } = {}) {
    super(message);
    this.name = 'Base64Error';
    this.code = code;
    this.index = index;
    this.line = line;
    this.column = column;
    this.char = char;
  }
}

export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? ''));
}

// Inserts a line break every `width` characters (0 = no wrapping).
export function wrapLines(text, width = 0, eol = '\n') {
  if (!width || text.length <= width) return text;
  const out = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out.join(eol);
}

function encodeGroups(bytes, start, end, alphabet, out) {
  // Encodes complete 3-byte groups from start to end (end - start is a multiple of 3).
  for (let i = start; i < end; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63]);
  }
}

function encodeTail(tail, alphabet, pad) {
  if (tail.length === 1) {
    const n = tail[0] << 16;
    return alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + (pad ? '==' : '');
  }
  if (tail.length === 2) {
    const n = (tail[0] << 16) | (tail[1] << 8);
    return alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + (pad ? '=' : '');
  }
  return '';
}

// Streaming encoder. push() returns the text ready so far; end() returns the rest.
// Line wrapping is applied across chunk boundaries.
export function createEncoder({ urlSafe = false, pad = true, wrap = 0, eol = '\n' } = {}) {
  const alphabet = urlSafe ? URL : STD;
  let carry = new Uint8Array(0);
  let column = 0;
  const wrapText = (text) => {
    if (!wrap || !text) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (column === wrap) { out += eol; column = 0; }
      const piece = text.slice(i, i + (wrap - column));
      out += piece;
      column += piece.length;
      i += piece.length;
    }
    return out;
  };
  return {
    push(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      let data = bytes;
      if (carry.length) {
        data = new Uint8Array(carry.length + bytes.length);
        data.set(carry, 0);
        data.set(bytes, carry.length);
      }
      const whole = data.length - (data.length % 3);
      const parts = [];
      encodeGroups(data, 0, whole, alphabet, parts);
      carry = data.slice(whole);
      return wrapText(parts.join(''));
    },
    end() {
      const text = encodeTail(carry, alphabet, pad);
      carry = new Uint8Array(0);
      return wrapText(text);
    },
  };
}

export function bytesToBase64(bytes, options = {}) {
  const enc = createEncoder(options);
  return enc.push(bytes) + enc.end();
}

export function encodeText(text, options = {}) {
  return bytesToBase64(utf8Bytes(text), options);
}

function position(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, column: index - lineStart + 1 };
}

function fail(text, code, message, index) {
  const { line, column } = index >= 0 ? position(text, index) : { line: 0, column: 0 };
  return new Base64Error(code, message, { index, line, column, char: index >= 0 ? text[index] ?? '' : '' });
}

const WS = new Set([9, 10, 13, 32]);

// Checks Base64 text. alphabet: 'auto' | 'standard' | 'url'.
// Returns { ok: true, clean, alphabet, padded } or { ok: false, error }.
export function validateBase64(text, { alphabet = 'auto', requirePadding = false } = {}) {
  const src = String(text ?? '');
  let count = 0;
  let seenStd = -1;
  let seenUrl = -1;
  let padStart = -1;
  let padCount = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (WS.has(c)) continue;
    const ch = src[i];
    if (ch === '=') {
      if (padStart < 0) padStart = count;
      padCount++;
      if (padCount > 2) return { ok: false, error: fail(src, 'tooMuchPadding', 'More than two padding characters', i) };
      count++;
      continue;
    }
    if (padStart >= 0) return { ok: false, error: fail(src, 'dataAfterPadding', 'Data after padding', i) };
    if (c >= 128 || DECODE[c] < 0) return { ok: false, error: fail(src, 'badChar', `Character ${JSON.stringify(ch)} is not Base64`, i) };
    if (ch === '+' || ch === '/') {
      if (alphabet === 'url') return { ok: false, error: fail(src, 'wrongAlphabet', `Character ${JSON.stringify(ch)} belongs to the standard alphabet`, i) };
      if (seenUrl >= 0) return { ok: false, error: fail(src, 'mixedAlphabet', 'Standard and URL-safe characters are mixed', i) };
      if (seenStd < 0) seenStd = i;
    } else if (ch === '-' || ch === '_') {
      if (alphabet === 'standard') return { ok: false, error: fail(src, 'wrongAlphabet', `Character ${JSON.stringify(ch)} belongs to the URL-safe alphabet`, i) };
      if (seenStd >= 0) return { ok: false, error: fail(src, 'mixedAlphabet', 'Standard and URL-safe characters are mixed', i) };
      if (seenUrl < 0) seenUrl = i;
    }
    count++;
  }
  const dataLen = padStart >= 0 ? padStart : count;
  const lastIndex = (() => { for (let i = src.length - 1; i >= 0; i--) if (!WS.has(src.charCodeAt(i))) return i; return -1; })();
  if (padStart >= 0) {
    if (count % 4 !== 0) return { ok: false, error: fail(src, 'badPadding', 'Padding does not complete a 4-character group', lastIndex) };
  } else {
    if (dataLen % 4 === 1) return { ok: false, error: fail(src, 'badLength', 'Length leaves a single dangling character', lastIndex) };
    if (requirePadding && dataLen % 4 !== 0) return { ok: false, error: fail(src, 'missingPadding', 'Padding is missing', lastIndex) };
  }
  const clean = (count === src.length ? src : src.replace(/[\t\n\r ]/g, '')).slice(0, dataLen);
  return { ok: true, clean, alphabet: seenUrl >= 0 ? 'url' : seenStd >= 0 ? 'standard' : 'either', padded: padStart >= 0 };
}

// Decodes already-validated characters (no whitespace or padding).
function decodeClean(clean) {
  const full = clean.length - (clean.length % 4);
  const rem = clean.length % 4;
  const out = new Uint8Array((full / 4) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0));
  let o = 0;
  for (let i = 0; i < full; i += 4) {
    const n = (DECODE[clean.charCodeAt(i)] << 18) | (DECODE[clean.charCodeAt(i + 1)] << 12) | (DECODE[clean.charCodeAt(i + 2)] << 6) | DECODE[clean.charCodeAt(i + 3)];
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (rem >= 2) {
    const n = (DECODE[clean.charCodeAt(full)] << 18) | (DECODE[clean.charCodeAt(full + 1)] << 12) | (rem === 3 ? DECODE[clean.charCodeAt(full + 2)] << 6 : 0);
    out[o++] = (n >> 16) & 255;
    if (rem === 3) out[o++] = (n >> 8) & 255;
  }
  return out;
}

// Throws Base64Error with the exact position of the first problem.
export function base64ToBytes(text, options = {}) {
  const result = validateBase64(text, options);
  if (!result.ok) throw result.error;
  return decodeClean(result.clean);
}

// Decodes a validated string in slices so the caller can yield between them.
export function* decodeInChunks(clean, charsPerChunk = 1 << 20) {
  const step = Math.max(4, charsPerChunk - (charsPerChunk % 4));
  for (let i = 0; i < clean.length; i += step) yield decodeClean(clean.slice(i, i + step));
}

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Decodes Base64 into text. Invalid UTF-8 raises a Base64Error with the byte offset.
export function decodeText(text, options = {}) {
  const bytes = base64ToBytes(text, options);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const at = firstInvalidUtf8(bytes);
    throw new Base64Error('notUtf8', `Decoded bytes are not valid UTF-8 (byte ${at})`, { index: at });
  }
}

export function firstInvalidUtf8(bytes) {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let need = 0;
    let min = 0;
    if (b < 0x80) { i++; continue; }
    if (b >= 0xc2 && b <= 0xdf) { need = 1; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; min = 0x10000; }
    else return i;
    if (i + need >= bytes.length) return i;
    let cp = b & (0xff >> (need + 2));
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

// ---------- data URIs ----------

export function toDataUri(bytes, mime = 'application/octet-stream') {
  return `data:${mime || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

// Parses a data: URI. Returns { mime, params, base64, bytes }.
export function parseDataUri(uri) {
  const src = String(uri ?? '').trim();
  const m = /^data:([^,]*?),/i.exec(src);
  if (!m) throw new Base64Error('notDataUri', 'Text does not start with data:…,', { index: 0 });
  const meta = m[1].split(';').map((s) => s.trim()).filter(Boolean);
  let base64 = false;
  if (meta.length && meta[meta.length - 1].toLowerCase() === 'base64') { base64 = true; meta.pop(); }
  const mime = meta.length && meta[0].includes('/') ? meta.shift().toLowerCase() : 'text/plain';
  const params = Object.fromEntries(meta.map((p) => { const [k, ...v] = p.split('='); return [k.toLowerCase(), v.join('=')]; }));
  const body = src.slice(m[0].length);
  let bytes;
  if (base64) {
    const result = validateBase64(body);
    if (!result.ok) {
      const e = result.error;
      throw new Base64Error(e.code, e.message, { index: e.index + m[0].length, line: e.line, column: e.line === 1 ? e.column + m[0].length : e.column, char: e.char });
    }
    bytes = decodeClean(result.clean);
  } else {
    try { bytes = utf8Bytes(decodeURIComponent(body)); } catch { throw new Base64Error('badPercent', 'Percent-encoding in the data URI is invalid', { index: m[0].length }); }
  }
  return { mime, params, base64, bytes };
}

export function looksLikeDataUri(text) {
  return /^\s*data:[^,]*,/i.test(String(text ?? ''));
}

// ---------- inspection helpers ----------

const SIGNATURES = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/bmp', [0x42, 0x4d]],
  ['image/x-icon', [0x00, 0x00, 0x01, 0x00]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ['application/zip', [0x50, 0x4b, 0x03, 0x04]],
  ['application/gzip', [0x1f, 0x8b]],
  ['application/wasm', [0x00, 0x61, 0x73, 0x6d]],
];

// Guesses a MIME type from magic bytes. Returns '' when unknown.
export function sniffMime(bytes) {
  const b = bytes || new Uint8Array(0);
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  for (const [mime, sig] of SIGNATURES) {
    if (b.length >= sig.length && sig.every((v, i) => b[i] === v)) return mime;
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return '';
}

export function isImageMime(mime) {
  return /^image\/(png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml|avif)$/i.test(String(mime || ''));
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'application/pdf': 'pdf', 'application/zip': 'zip', 'application/gzip': 'gz', 'application/wasm': 'wasm', 'application/json': 'json', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv' };
export function extensionFor(mime) {
  return EXT[String(mime || '').toLowerCase()] || 'bin';
}

// Classic hex dump: offset, 16 bytes in hex, printable ASCII column.
export function hexDump(bytes, { offset = 0, length = 4096, width = 16 } = {}) {
  const end = Math.min(bytes.length, offset + length);
  const lines = [];
  for (let i = offset; i < end; i += width) {
    const row = bytes.subarray(i, Math.min(i + width, end));
    let hex = '';
    let ascii = '';
    for (let k = 0; k < width; k++) {
      if (k < row.length) {
        hex += row[k].toString(16).padStart(2, '0') + ' ';
        ascii += row[k] >= 0x20 && row[k] < 0x7f ? String.fromCharCode(row[k]) : '.';
      } else hex += '   ';
      if (k === 7) hex += ' ';
    }
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return lines.join('\n');
}

// Characters (code points), UTF-16 units, UTF-8 bytes and lines of a text.
export function textStats(text) {
  const s = String(text ?? '');
  let chars = 0;
  for (const _ of s) chars++;
  return { chars, units: s.length, bytes: utf8Bytes(s).length, lines: s ? s.split('\n').length : 0 };
}

// Size of decoded data for a clean (no whitespace, no padding) Base64 length.
export function decodedLength(cleanLength) {
  const rem = cleanLength % 4;
  return Math.floor(cleanLength / 4) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[u]}`;
}

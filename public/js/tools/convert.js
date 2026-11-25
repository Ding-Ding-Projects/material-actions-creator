// Local file converter: pure logic with no DOM access.
// Data formats: JSON, YAML (safe subset), CSV, TSV, NDJSON, Markdown table, HTML table.
// Also text encodings (UTF-8, UTF-16LE, Latin-1) and a BMP encoder for the image converter.
// Every conversion returns notices that say exactly what changed or was lost.
import { parseYaml, stringifyYaml, YamlError } from './yaml.js';
import { parseJson, toValue } from './jsonstudio.js';

export const DATA_FORMATS = ['json', 'yaml', 'csv', 'tsv', 'ndjson', 'markdown', 'html'];
export const TABULAR = new Set(['csv', 'tsv', 'markdown', 'html']);
export const EXTENSIONS = { json: 'json', yaml: 'yaml', csv: 'csv', tsv: 'tsv', ndjson: 'ndjson', markdown: 'md', html: 'html', xml: 'xml' };
export const MIME = { json: 'application/json', yaml: 'application/yaml', csv: 'text/csv', tsv: 'text/tab-separated-values', ndjson: 'application/x-ndjson', markdown: 'text/markdown', html: 'text/html', xml: 'application/xml' };

export class ConvertError extends Error {
  constructor(code, message, { line = 0, column = 0, vars = {} } = {}) {
    super(line ? `${message} (line ${line}, column ${column})` : message);
    this.name = 'ConvertError';
    this.code = code;
    this.reason = message;
    this.line = line;
    this.column = column;
    this.vars = vars;
  }
}

// A notice: { code, lossy, vars }. The UI turns code into translated text.
const notice = (code, lossy, vars = {}) => ({ code, lossy, vars });

function setKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- delimited text (CSV / TSV) ----------

// RFC 4180 style: quoted fields, doubled quotes, line breaks inside quotes, CRLF or LF.
export function parseDelimited(text, delimiter = ',') {
  const s = String(text ?? '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let line = 1;
  let col = 1;
  let quoted = false;
  let fieldStart = true;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; col += 2; continue; }
        quoted = false; i++; col++;
        const n = s[i];
        if (n !== undefined && n !== delimiter && n !== '\n' && n !== '\r') {
          throw new ConvertError('csvAfterQuote', 'Unexpected text after a closing quote', { line, column: col });
        }
        continue;
      }
      if (c === '\n') { line++; col = 1; } else col++;
      field += c; i++;
      continue;
    }
    if (c === '"' && fieldStart) { quoted = true; fieldStart = false; i++; col++; continue; }
    if (c === delimiter) { row.push(field); field = ''; fieldStart = true; i++; col++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = []; field = ''; fieldStart = true;
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      line++; col = 1;
      continue;
    }
    field += c; fieldStart = false; i++; col++;
  }
  if (quoted) throw new ConvertError('csvUnclosed', 'A quoted field is never closed', { line, column: col });
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop blank lines (a single empty field).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function quoteField(value, delimiter = ',') {
  const s = String(value);
  if (s === '') return '';
  if (s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function stringifyDelimited(rows, delimiter = ',') {
  return rows.map((r) => r.map((v) => quoteField(v, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

// ---------- tables <-> records ----------

const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

// Turns cell text back into numbers, true/false and null when that is exact.
export function inferCell(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (NUMBER.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s) return n;
  }
  return s;
}

// rows[0] is the header. Returns { records, notices }.
export function rowsToRecords(rows, { inferTypes = false } = {}) {
  const notices = [];
  if (!rows.length) return { records: [], notices };
  const header = rows[0].map((h, i) => (String(h).trim() === '' ? `column${i + 1}` : String(h)));
  const blanks = rows[0].filter((h) => String(h).trim() === '').length;
  if (blanks) notices.push(notice('blankHeader', false, { count: blanks }));
  const seen = new Map();
  const renamed = [];
  const names = header.map((h) => {
    if (!seen.has(h)) { seen.set(h, 1); return h; }
    let n = seen.get(h) + 1;
    while (seen.has(`${h}_${n}`)) n++;
    seen.set(h, n);
    seen.set(`${h}_${n}`, 1);
    renamed.push(`${h} → ${h}_${n}`);
    return `${h}_${n}`;
  });
  if (renamed.length) notices.push(notice('duplicateHeader', false, { list: renamed.join(', ') }));
  let ragged = 0;
  const width = names.length;
  const records = rows.slice(1).map((r) => {
    if (r.length !== width) ragged++;
    const rec = {};
    const n = Math.max(width, r.length);
    for (let i = 0; i < n; i++) {
      const name = i < width ? names[i] : `column${i + 1}`;
      if (i >= width && !names.includes(name)) names.push(name);
      const cell = r[i] ?? '';
      setKey(rec, name, inferTypes ? inferCell(cell) : cell);
    }
    return rec;
  });
  if (ragged) notices.push(notice('raggedRows', false, { count: ragged }));
  if (inferTypes) notices.push(notice('typesInferred', false));
  return { records, notices };
}

// Flattens nested objects/arrays into dotted paths. Returns the flat object and the paths flattened.
export function flattenRecord(value, prefix = '', out = {}, flattened = new Set()) {
  if (isPlainObject(value) || Array.isArray(value)) {
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
    if (!keys.length && prefix) {
      setKey(out, prefix, Array.isArray(value) ? '[]' : '{}');
      flattened.add(prefix);
      return { flat: out, flattened };
    }
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const child = value[k];
      if ((isPlainObject(child) || Array.isArray(child))) {
        flattened.add(path);
        flattenRecord(child, path, out, flattened);
      } else setKey(out, path, child);
    }
    return { flat: out, flattened };
  }
  setKey(out, prefix || 'value', value);
  return { flat: out, flattened };
}

// Rebuilds nesting from dotted keys ("a.b", "tags.0"). Objects with keys 0..n-1 become arrays.
export function unflattenRecord(flat) {
  const root = {};
  for (const key of Object.keys(flat)) {
    const parts = key.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!Object.prototype.hasOwnProperty.call(node, p) || !isPlainObject(node[p])) setKey(node, p, {});
      node = node[p];
    }
    setKey(node, parts[parts.length - 1], flat[key]);
  }
  const fix = (v) => {
    if (!isPlainObject(v)) return v;
    const keys = Object.keys(v);
    for (const k of keys) v[k] = fix(v[k]);
    if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => v[k]);
    return v;
  };
  return fix(root);
}

// Any value -> { columns, rows (strings), notices } for tabular output.
export function valueToTable(value) {
  const notices = [];
  let items;
  if (Array.isArray(value)) {
    if (value.length && value.every(Array.isArray)) {
      notices.push(notice('arrayRowsHeader', false));
      const [head, ...rest] = value;
      const columns = head.map((h) => cellText(h, null));
      const rows = rest.map((r) => columns.map((_, i) => cellText(r[i], null)));
      const extra = rest.filter((r) => r.length > columns.length).length;
      if (extra) notices.push(notice('extraCellsDropped', true, { count: extra }));
      return { columns, rows, notices };
    }
    items = value;
  } else if (isPlainObject(value)) {
    notices.push(notice('singleObject', false));
    items = [value];
  } else {
    items = [value];
  }
  const flattenedAll = new Set();
  let primitives = 0;
  const flats = items.map((item) => {
    if (!isPlainObject(item)) {
      primitives++;
      if (Array.isArray(item)) {
        const { flat, flattened } = flattenRecord({ value: item });
        flattened.forEach((p) => flattenedAll.add(p));
        return flat;
      }
      const flat = {};
      setKey(flat, 'value', item);
      return flat;
    }
    const { flat, flattened } = flattenRecord(item);
    flattened.forEach((p) => flattenedAll.add(p));
    return flat;
  });
  if (primitives) notices.push(notice('wrappedPrimitives', false, { count: primitives }));
  if (flattenedAll.size) {
    const list = [...flattenedAll];
    notices.push(notice('flattened', true, { count: list.length, list: list.slice(0, 12).join(', ') + (list.length > 12 ? ', …' : '') }));
  }
  const columns = [];
  const seen = new Set();
  for (const f of flats) for (const k of Object.keys(f)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  const stats = { missing: 0, nulls: 0, typed: 0 };
  const rows = flats.map((f) => columns.map((c) => {
    if (!Object.prototype.hasOwnProperty.call(f, c)) { stats.missing++; return ''; }
    return cellText(f[c], stats);
  }));
  if (stats.missing) notices.push(notice('missingCells', true, { count: stats.missing }));
  if (stats.nulls) notices.push(notice('nullToEmpty', true, { count: stats.nulls }));
  if (stats.typed) notices.push(notice('typesToText', true, { count: stats.typed }));
  return { columns, rows, notices };
}

function cellText(v, stats) {
  if (v === null || v === undefined) { if (stats) stats.nulls++; return ''; }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') { if (stats) stats.typed++; return String(v); }
  return JSON.stringify(v);
}

// ---------- Markdown tables ----------

function splitPipes(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BR = /<br\s*\/?>/gi;

export function parseMarkdownTable(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitPipes(lines[i]).map((c) => c.replace(BR, '\n'));
      const rows = [header];
      for (let k = i + 2; k < lines.length && lines[k].trim() && lines[k].includes('|'); k++) {
        rows.push(splitPipes(lines[k]).map((c) => c.replace(BR, '\n')));
      }
      return rows;
    }
  }
  throw new ConvertError('noMarkdownTable', 'No Markdown table found (a header row followed by a |---| separator row)');
}

export function stringifyMarkdownTable(columns, rows) {
  const notes = { breaks: 0, trimmed: 0 };
  const cell = (v) => {
    if (/^\s|\s$/.test(String(v))) notes.trimmed++;
    let s = String(v).trim().replace(/\|/g, '\\|');
    if (/\r?\n/.test(s)) { notes.breaks++; s = s.replace(/\r?\n/g, '<br>'); }
    return s;
  };
  const head = `| ${columns.map(cell).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
  return { text: [head, sep, ...body].join('\n') + '\n', breaks: notes.breaks, trimmed: notes.trimmed };
}

// ---------- HTML tables ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Reads the first <table>. Returns { rows, headerFromTh, spans }.
export function parseHtmlTable(text) {
  const src = String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const start = src.search(/<table\b/i);
  if (start < 0) throw new ConvertError('noHtmlTable', 'No <table> element found');
  const endMatch = /<\/table\s*>/i.exec(src.slice(start));
  const body = endMatch ? src.slice(start, start + endMatch.index) : src.slice(start);
  const tag = /<(\/?)(tr|th|td|br|thead|tbody|tfoot|table|script|style)\b([^>]*)>/gi;
  const rows = [];
  let row = null;
  let cell = null;
  let cellIsTh = false;
  let firstRowAllTh = null;
  let spans = 0;
  let last = 0;
  let m;
  const flushText = (upto) => {
    if (cell !== null) cell.text += body.slice(last, upto).replace(/<[^>]*>/g, '');
    last = upto;
  };
  const closeCell = () => {
    if (cell !== null && row) {
      row.push(decodeEntities(cell.text.replace(/[ \t]*\r?\n[ \t]*/g, ' ').trim().replace(/\u0001/g, '\n')));
      if (rows.length === 0 && !cellIsTh) firstRowAllTh = false;
    }
    cell = null;
  };
  const closeRow = () => {
    closeCell();
    if (row && row.length) {
      if (rows.length === 0 && firstRowAllTh === null) firstRowAllTh = true;
      rows.push(row);
    }
    row = null;
  };
  while ((m = tag.exec(body))) {
    flushText(m.index);
    last = tag.lastIndex;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if ((name === 'script' || name === 'style') && !closing) {
      const end = new RegExp(`</${name}\\s*>`, 'i').exec(body.slice(last));
      last = end ? last + end.index + end[0].length : body.length;
      tag.lastIndex = last;
      continue;
    }
    if (name === 'br') { if (cell) cell.text += '\u0001'; continue; }
    if (name === 'tr') { if (closing) closeRow(); else { closeRow(); row = []; } continue; }
    if (name === 'td' || name === 'th') {
      if (closing) { closeCell(); continue; }
      closeCell();
      if (!row) row = [];
      if (/\b(col|row)span\s*=\s*["']?\s*([2-9]|\d\d)/i.test(m[3])) spans++;
      cell = { text: '' };
      cellIsTh = name === 'th';
      continue;
    }
  }
  flushText(body.length);
  closeRow();
  if (!rows.length) throw new ConvertError('noHtmlTable', 'The table has no rows');
  return { rows, headerFromTh: firstRowAllTh === true, spans };
}

export function stringifyHtmlTable(columns, rows) {
  let breaks = 0;
  const cell = (v) => {
    const s = escapeHtml(v).replace(/^ +| +$/g, (m) => '&#32;'.repeat(m.length));
    if (/\r?\n/.test(s)) { breaks++; return s.replace(/\r?\n/g, '<br>'); }
    return s;
  };
  const lines = ['<table>', '  <thead>', `    <tr>${columns.map((c) => `<th>${cell(c)}</th>`).join('')}</tr>`, '  </thead>', '  <tbody>'];
  for (const r of rows) lines.push(`    <tr>${r.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`);
  lines.push('  </tbody>', '</table>');
  return { text: lines.join('\n') + '\n', breaks };
}

// ---------- JSON / NDJSON ----------

export function parseJsonText(text) {
  const r = parseJson(text);
  if (!r.ok) throw new ConvertError('json', r.error.message, { line: r.error.line, column: r.error.column });
  const notices = r.warnings.map((w) => notice('duplicateKey', true, { key: w.key, line: w.line }));
  return { value: toValue(r.tree), notices };
}

export function parseNdjson(text) {
  const lines = String(text ?? '').replace(/^\ufeff/, '').split(/\r?\n/);
  const values = [];
  const notices = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const r = parseJson(line);
    if (!r.ok) throw new ConvertError('ndjson', r.error.message, { line: i + 1, column: r.error.column });
    for (const w of r.warnings) notices.push(notice('duplicateKey', true, { key: w.key, line: i + 1 }));
    values.push(toValue(r.tree));
  });
  return { value: values, notices };
}

function nonFinite(value) {
  let count = 0;
  const walk = (v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) count++;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isPlainObject(v)) Object.values(v).forEach(walk);
  };
  walk(value);
  return count;
}

// ---------- format dispatch ----------

// Parses text in a format. Returns { value, notices }.
export function parse(text, format, { inferTypes = false, unflatten = false } = {}) {
  let rows;
  let notices = [];
  switch (format) {
    case 'json': return parseJsonText(text);
    case 'ndjson': return parseNdjson(text);
    case 'yaml':
      try { return { value: parseYaml(text), notices }; } catch (e) {
        if (e instanceof YamlError) throw new ConvertError(`yaml.${e.code}`, e.reason, { line: e.line, column: e.column });
        throw e;
      }
    case 'csv': rows = parseDelimited(text, ','); break;
    case 'tsv': rows = parseDelimited(text, '\t'); break;
    case 'markdown': rows = parseMarkdownTable(text); break;
    case 'html': {
      const t = parseHtmlTable(text);
      rows = t.rows;
      if (!t.headerFromTh) notices.push(notice('firstRowHeader', false));
      if (t.spans) notices.push(notice('spansIgnored', true, { count: t.spans }));
      break;
    }
    default: throw new ConvertError('unknownFormat', `Unknown format ${format}`);
  }
  if (!rows.length) return { value: [], notices: [...notices, notice('emptyInput', false)] };
  const r = rowsToRecords(rows, { inferTypes });
  notices = notices.concat(r.notices);
  let value = r.records;
  if (unflatten) {
    value = value.map(unflattenRecord);
    notices.push(notice('unflattened', false));
  }
  return { value, notices };
}

// Serializes a value to a format. Returns { text, notices }.
export function serialize(value, format) {
  const notices = [];
  switch (format) {
    case 'json': {
      const bad = nonFinite(value);
      if (bad) notices.push(notice('nonFiniteToNull', true, { count: bad }));
      return { text: JSON.stringify(value, null, 2) + '\n', notices };
    }
    case 'ndjson': {
      const bad = nonFinite(value);
      if (bad) notices.push(notice('nonFiniteToNull', true, { count: bad }));
      if (!Array.isArray(value)) {
        notices.push(notice('singleLine', false));
        return { text: JSON.stringify(value) + '\n', notices };
      }
      return { text: value.map((v) => JSON.stringify(v)).join('\n') + (value.length ? '\n' : ''), notices };
    }
    case 'yaml': return { text: stringifyYaml(value), notices };
    case 'csv':
    case 'tsv': {
      const t = valueToTable(value);
      return { text: stringifyDelimited([t.columns, ...t.rows], format === 'csv' ? ',' : '\t'), notices: t.notices };
    }
    case 'markdown': {
      const t = valueToTable(value);
      const md = stringifyMarkdownTable(t.columns, t.rows);
      if (md.breaks) t.notices.push(notice('lineBreaksAsBr', false, { count: md.breaks }));
      if (md.trimmed) t.notices.push(notice('edgeSpacesTrimmed', true, { count: md.trimmed }));
      return { text: md.text, notices: t.notices };
    }
    case 'html': {
      const t = valueToTable(value);
      const html = stringifyHtmlTable(t.columns, t.rows);
      if (html.breaks) t.notices.push(notice('lineBreaksAsBr', false, { count: html.breaks }));
      return { text: html.text, notices: t.notices };
    }
    default: throw new ConvertError('unknownFormat', `Unknown format ${format}`);
  }
}

// Text in one format -> text in another. Returns { output, notices, lossy, value }.
export function convert(text, from, to, options = {}) {
  const parsed = parse(text, from, options);
  const out = serialize(parsed.value, to);
  const notices = [...parsed.notices, ...out.notices];
  if (TABULAR.has(from) && !options.inferTypes && (to === 'json' || to === 'yaml' || to === 'ndjson')) notices.push(notice('allText', false));
  return { output: out.text, notices, lossy: notices.some((n) => n.lossy), value: parsed.value };
}

// Guesses a format from a file name and/or the content.
export function detectFormat(text, filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop();
  const byExt = { json: 'json', yaml: 'yaml', yml: 'yaml', csv: 'csv', tsv: 'tsv', tab: 'tsv', ndjson: 'ndjson', jsonl: 'ndjson', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xml: 'xml', svg: 'xml' };
  if (filename && byExt[ext]) return byExt[ext];
  const s = String(text ?? '').replace(/^\ufeff/, '').trimStart();
  if (!s) return 'json';
  if (s[0] === '{' || s[0] === '[') {
    if (parseJson(s).ok) return 'json';
    const lines = s.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines.every((l) => parseJson(l).ok)) return 'ndjson';
    return 'json';
  }
  if (s[0] === '<') return /<table\b/i.test(s) ? 'html' : 'xml';
  const lines = s.split(/\r?\n/);
  if (lines.length > 1 && lines[0].includes('|') && SEPARATOR.test(lines[1]) && lines[1].includes('-')) return 'markdown';
  if (lines[0].includes('\t')) return 'tsv';
  if (lines.length > 1 && lines[0].includes(',') && !/:\s/.test(lines[0])) return 'csv';
  return 'yaml';
}

// ---------- text encodings ----------

export const ENCODINGS = ['utf-8', 'utf-16le', 'latin1'];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Text -> bytes. Returns { bytes, replaced, firstReplaced }.
export function encodeString(text, encoding, { bom = false } = {}) {
  const s = String(text ?? '');
  if (encoding === 'utf-8') {
    const lone = s.match(LONE_SURROGATE) || [];
    const body = new TextEncoder().encode(s);
    const bytes = bom ? concat(new Uint8Array([0xef, 0xbb, 0xbf]), body) : body;
    return { bytes, replaced: lone.length, firstReplaced: lone.length ? s.search(LONE_SURROGATE) : -1 };
  }
  if (encoding === 'utf-16le') {
    const off = bom ? 2 : 0;
    const bytes = new Uint8Array(s.length * 2 + off);
    if (bom) { bytes[0] = 0xff; bytes[1] = 0xfe; }
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      bytes[off + i * 2] = c & 255;
      bytes[off + i * 2 + 1] = c >> 8;
    }
    return { bytes, replaced: 0, firstReplaced: -1 };
  }
  if (encoding === 'latin1') {
    const out = [];
    let replaced = 0;
    let firstReplaced = -1;
    let index = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp > 255) { out.push(0x3f); replaced++; if (firstReplaced < 0) firstReplaced = index; } else out.push(cp);
      index += ch.length;
    }
    return { bytes: Uint8Array.from(out), replaced, firstReplaced };
  }
  throw new ConvertError('unknownEncoding', `Unknown encoding ${encoding}`);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Bytes -> text. Returns { text, replaced, bom }.
export function decodeBytes(bytes, encoding) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (encoding === 'utf-8') {
    const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    const body = bom ? b.subarray(3) : b;
    const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(body);
    let legit = 0;
    for (let i = 0; i + 2 < body.length; i++) if (body[i] === 0xef && body[i + 1] === 0xbf && body[i + 2] === 0xbd) legit++;
    const produced = (text.match(/\ufffd/g) || []).length;
    return { text, replaced: Math.max(0, produced - legit), bom };
  }
  if (encoding === 'utf-16le') {
    const bom = b.length >= 2 && b[0] === 0xff && b[1] === 0xfe;
    const start = bom ? 2 : 0;
    const usable = b.length - start - ((b.length - start) % 2);
    let text = '';
    const parts = [];
    for (let i = start; i < start + usable; i += 2) {
      parts.push(b[i] | (b[i + 1] << 8));
      if (parts.length === 8192) { text += String.fromCharCode(...parts); parts.length = 0; }
    }
    text += String.fromCharCode(...parts);
    return { text, replaced: (b.length - start) % 2, bom };
  }
  if (encoding === 'latin1') {
    let text = '';
    for (let i = 0; i < b.length; i += 8192) text += String.fromCharCode(...b.subarray(i, i + 8192));
    return { text, replaced: 0, bom: false };
  }
  throw new ConvertError('unknownEncoding', `Unknown encoding ${encoding}`);
}

// Re-encodes bytes. Returns { bytes, text, notices }.
export function convertEncoding(bytes, from, to, { bom = false } = {}) {
  const notices = [];
  const d = decodeBytes(bytes, from);
  if (d.bom) notices.push(notice('bomRemoved', false));
  if (d.replaced) notices.push(notice('invalidInput', true, { count: d.replaced, encoding: from }));
  const e = encodeString(d.text, to, { bom });
  if (e.replaced) notices.push(notice('unrepresentable', true, { count: e.replaced, encoding: to, index: e.firstReplaced }));
  if (bom && to !== 'latin1') notices.push(notice('bomAdded', false));
  return { bytes: e.bytes, text: d.text, notices };
}

// ---------- images ----------

export const IMAGE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };

export function hasTransparency(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

// 24-bit uncompressed BMP. Pixels with transparency are composited over `background`.
export function encodeBmp(width, height, rgba, background = [255, 255, 255]) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const out = new Uint8Array(54 + dataSize);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, 54 + dataSize, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, dataSize, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const rowStart = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      const mix = (c, bg) => Math.round(c * a + bg * (1 - a));
      const o = rowStart + x * 3;
      out[o] = mix(rgba[i + 2], background[2]);
      out[o + 1] = mix(rgba[i + 1], background[1]);
      out[o + 2] = mix(rgba[i], background[0]);
    }
  }
  return out;
}

export function replaceExtension(name, ext) {
  const base = String(name || 'converted').replace(/\.[^./\\]+$/, '');
  return `${base}.${ext}`;
}

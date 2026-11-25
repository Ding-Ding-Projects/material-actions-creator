// A deliberately small, safe YAML subset: block mappings and sequences,
// single-line flow collections, plain/single/double-quoted scalars, literal (|)
// and folded (>) block scalars, and comments. Anchors, aliases, tags, complex
// keys and multiple documents are rejected with a clear message. Pure logic.

export class YamlError extends Error {
  constructor(code, message, line = 0, column = 0) {
    super(line ? `${message} (line ${line}, column ${column})` : message);
    this.name = 'YamlError';
    this.code = code;
    this.reason = message;
    this.line = line;
    this.column = column;
  }
}

function setKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- scalars ----------

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const TRUES = new Set(['true', 'True', 'TRUE']);
const FALSES = new Set(['false', 'False', 'FALSE']);

export function resolvePlain(s) {
  if (NULLS.has(s)) return null;
  if (TRUES.has(s)) return true;
  if (FALSES.has(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

const ESCAPES = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };

// Reads a quoted scalar starting at text[i] (the quote). Returns { value, end }.
function readQuoted(text, i, lineNo, colBase) {
  const q = text[i];
  let out = '';
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (q === "'") {
      if (c === "'") {
        if (text[j + 1] === "'") { out += "'"; j += 2; continue; }
        return { value: out, end: j + 1 };
      }
      out += c; j++;
      continue;
    }
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\\') {
      const n = text[j + 1];
      if (n === undefined) break;
      if (n in ESCAPES) { out += ESCAPES[n]; j += 2; continue; }
      const len = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
      const hex = text.slice(j + 2, j + 2 + len);
      if (!len || hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new YamlError('badEscape', `Unknown escape \\${n}`, lineNo, colBase + j + 1);
      out += String.fromCodePoint(parseInt(hex, 16));
      j += 2 + len;
      continue;
    }
    out += c; j++;
  }
  throw new YamlError('unterminated', 'Quoted string is not closed on the same line', lineNo, colBase + i + 1);
}

// Strips a trailing comment (" #...") outside quotes.
function stripComment(text) {
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (q === "'" && c === "'" && text[i + 1] === "'") { i++; continue; }
      if (c === q) q = '';
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(text[i - 1]))) { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function rejectSpecial(s, lineNo, col) {
  const c = s[0];
  if (c === '&') throw new YamlError('anchor', 'Anchors (&name) are not supported; write the value out in full', lineNo, col);
  if (c === '*') throw new YamlError('alias', 'Aliases (*name) are not supported; write the value out in full', lineNo, col);
  if (c === '!') throw new YamlError('tag', 'Tags (!tag) are not supported', lineNo, col);
  if (c === '@' || c === '`') throw new YamlError('reserved', `"${c}" cannot start a plain value; quote it`, lineNo, col);
  if (c === '%' ) throw new YamlError('reserved', '"%" cannot start a plain value; quote it', lineNo, col);
}

// Inline value (after "key: " or "- "): quoted, flow collection or plain scalar.
function parseInline(raw, lineNo, col) {
  const s = stripComment(raw).trim();
  if (s === '') return null;
  rejectSpecial(s, lineNo, col);
  if (s[0] === '"' || s[0] === "'") {
    const { value, end } = readQuoted(s, 0, lineNo, col - 1);
    if (s.slice(end).trim()) throw new YamlError('afterQuote', 'Unexpected text after a quoted string', lineNo, col + end);
    return value;
  }
  if (s[0] === '[' || s[0] === '{') {
    const p = new FlowParser(s, lineNo, col - 1);
    const value = p.value();
    p.ws();
    if (p.i < s.length) throw new YamlError('flow', 'Unexpected text after a flow collection', lineNo, col + p.i);
    return value;
  }
  if (s.startsWith('? ')) throw new YamlError('complexKey', 'Complex keys ("? ") are not supported', lineNo, col);
  return resolvePlain(s);
}

class FlowParser {
  constructor(s, lineNo, colBase) { this.s = s; this.i = 0; this.line = lineNo; this.colBase = colBase; }
  err(code, msg) { return new YamlError(code, msg, this.line, this.colBase + this.i + 1); }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    if (c === '"' || c === "'") {
      const { value, end } = readQuoted(this.s, this.i, this.line, this.colBase);
      this.i = end;
      return value;
    }
    if (c === '&' || c === '*' || c === '!') rejectSpecial(c, this.line, this.colBase + this.i + 1);
    const start = this.i;
    while (this.i < this.s.length && !/[,\]}]/.test(this.s[this.i]) && !(this.s[this.i] === ':' && /[\s,\]}]|$/.test(this.s[this.i + 1] ?? ''))) this.i++;
    return resolvePlain(this.s.slice(start, this.i).trim());
  }
  seq() {
    this.i++;
    const out = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); if (this.s[this.i] === ']') { this.i++; return out; } continue; }
      if (c === ']') { this.i++; return out; }
      throw this.err('flow', c === undefined ? 'Flow sequence is not closed with ]' : `Expected , or ] but found ${JSON.stringify(c)}`);
    }
  }
  map() {
    this.i++;
    const out = {};
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return out; }
    for (;;) {
      const key = this.value();
      this.ws();
      let value = null;
      if (this.s[this.i] === ':') { this.i++; value = this.value(); this.ws(); }
      const k = key === null ? 'null' : String(key);
      if (hasOwn(out, k)) throw this.err('duplicateKey', `Duplicate key ${JSON.stringify(k)}`);
      setKey(out, k, value);
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); if (this.s[this.i] === '}') { this.i++; return out; } continue; }
      if (c === '}') { this.i++; return out; }
      throw this.err('flow', c === undefined ? 'Flow mapping is not closed with }' : `Expected , or } but found ${JSON.stringify(c)}`);
    }
  }
}

// Finds "key:" at the start of content. Returns { key, rest, restCol } or null.
function splitKey(content, lineNo, indent) {
  let keyText;
  let after;
  if (content[0] === '"' || content[0] === "'") {
    let q;
    try { q = readQuoted(content, 0, lineNo, indent); } catch { return null; }
    const tail = content.slice(q.end);
    const m = /^\s*:(\s|$)/.exec(tail);
    if (!m) return null;
    keyText = q.value;
    after = q.end + tail.indexOf(':') + 1;
    return { key: keyText, rest: content.slice(after), restCol: indent + after + 1 };
  }
  if (content.startsWith('? ') || content === '?') throw new YamlError('complexKey', 'Complex keys ("? ") are not supported', lineNo, indent + 1);
  if (/^[[{]/.test(content)) return null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '#' && i > 0 && /\s/.test(content[i - 1])) return null;
    if (c === ':' && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      keyText = content.slice(0, i).trim();
      if (!keyText) return null;
      rejectSpecial(keyText, lineNo, indent + 1);
      const resolved = resolvePlain(keyText);
      return { key: resolved === null ? 'null' : String(keyText), rest: content.slice(i + 1), restCol: indent + i + 2 };
    }
  }
  return null;
}

// ---------- block parser ----------

class Parser {
  constructor(text) {
    const src = String(text ?? '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
    this.lines = src.split('\n').map((raw, n) => ({ raw, num: n + 1, indent: -1, text: null }));
    this.i = 0;
    this.prepare();
  }

  // Handles directives and document markers, rejects tabs used for indentation.
  prepare() {
    let started = false;
    for (const l of this.lines) {
      if (l.raw.trim() === '' || l.raw.trimStart().startsWith('#')) continue;
      if (/^%/.test(l.raw)) {
        if (started) throw new YamlError('reserved', 'Directives are only allowed before the document', l.num, 1);
        if (/^%TAG/.test(l.raw)) throw new YamlError('tag', 'Tags (!tag) are not supported', l.num, 1);
        l.skip = true;
        continue;
      }
      if (/^---(\s|$)/.test(l.raw)) {
        if (started) throw new YamlError('multiDoc', 'Only one YAML document is supported; found a second "---"', l.num, 1);
        started = true;
        const rest = l.raw.slice(3).trim();
        if (rest && !rest.startsWith('#')) { l.raw = ' '.repeat(4) + rest; l.docInline = true; } else l.skip = true;
        continue;
      }
      if (/^\.\.\.(\s|$)/.test(l.raw)) {
        for (const later of this.lines.slice(this.lines.indexOf(l) + 1)) {
          if (later.raw.trim() && !later.raw.trimStart().startsWith('#')) throw new YamlError('multiDoc', 'Only one YAML document is supported; found content after "..."', later.num, 1);
        }
        l.skip = true;
        break;
      }
      started = true;
    }
  }

  blank(l) { return l.skip || l.raw.trim() === '' || l.raw.trimStart().startsWith('#'); }

  // Index of the next meaningful line, without consuming it.
  peek() {
    while (this.i < this.lines.length && this.blank(this.lines[this.i])) this.i++;
    const l = this.lines[this.i];
    if (!l) return null;
    if (l.indent < 0) {
      const m = /^( *)(\t*)/.exec(l.raw);
      if (m[2]) throw new YamlError('tab', 'Tabs cannot be used for indentation; use spaces', l.num, m[1].length + 1);
      l.indent = m[1].length;
      l.text = l.raw.slice(l.indent).trimEnd();
    }
    return l;
  }

  parseDocument() {
    const l = this.peek();
    if (!l) return null;
    const value = this.parseNode(l.indent);
    const extra = this.peek();
    if (extra) throw new YamlError('indent', 'Unexpected content; check the indentation', extra.num, extra.indent + 1);
    return value;
  }

  isSeqLine(l) { return l.text === '-' || l.text.startsWith('- '); }

  parseNode(indent) {
    const l = this.peek();
    if (!l || l.indent < indent) return null;
    if (this.isSeqLine(l)) return this.parseSeq(l.indent);
    const kv = splitKey(l.text, l.num, l.indent);
    if (kv) return this.parseMap(l.indent);
    return this.parseScalarLines(l.indent - 1);
  }

  // A plain or quoted scalar on its own line, possibly continued on more-indented lines.
  parseScalarLines(parentIndent) {
    const l = this.peek();
    this.i++;
    const t = l.text;
    if (t.startsWith('|') || t.startsWith('>')) return this.blockScalar(t, l, parentIndent);
    const first = stripComment(t);
    if (/^["'[{&*!]/.test(first)) return parseInline(t, l.num, l.indent + 1);
    const parts = [first.trim()];
    for (;;) {
      const n = this.peek();
      if (!n || n.indent <= parentIndent) break;
      if (splitKey(n.text, n.num, n.indent) || this.isSeqLine(n)) throw new YamlError('indent', 'Unexpected mapping or sequence inside a plain value; check the indentation', n.num, n.indent + 1);
      parts.push(stripComment(n.text).trim());
      this.i++;
    }
    return parts.length === 1 ? parseInline(parts[0], l.num, l.indent + 1) : parts.join(' ');
  }

  parseMap(indent) {
    const out = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('indent', 'Unexpected indentation', l.num, l.indent + 1);
      if (this.isSeqLine(l)) throw new YamlError('indent', 'A sequence item cannot appear here; check the indentation', l.num, l.indent + 1);
      const kv = splitKey(l.text, l.num, l.indent);
      if (!kv) throw new YamlError('expectedKey', 'Expected "key: value"', l.num, l.indent + 1);
      if (kv.key === '<<') throw new YamlError('alias', 'Merge keys (<<) are not supported; write the values out in full', l.num, l.indent + 1);
      if (hasOwn(out, kv.key)) throw new YamlError('duplicateKey', `Duplicate key ${JSON.stringify(kv.key)}`, l.num, l.indent + 1);
      this.i++;
      setKey(out, kv.key, this.valueAfter(kv.rest, kv.restCol, l, indent, true));
    }
    return out;
  }

  parseSeq(indent, endsAtKey = false) {
    const out = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('indent', 'Unexpected indentation', l.num, l.indent + 1);
      if (!this.isSeqLine(l)) {
        if (endsAtKey) break;
        if (splitKey(l.text, l.num, l.indent)) throw new YamlError('indent', 'A mapping key cannot follow sequence items at the same indentation', l.num, l.indent + 1);
        throw new YamlError('expectedItem', 'Expected "- item"', l.num, l.indent + 1);
      }
      const after = l.text.slice(1);
      const pad = after.length - after.trimStart().length;
      const rest = after.trimStart();
      const col = l.indent + 1 + pad;
      if (rest && !rest.startsWith('#') && (rest === '-' || rest.startsWith('- ') || (!/^[|>]/.test(rest) && splitKey(rest, l.num, col)))) {
        // Compact nested collection: reuse this line as if it started at the item's column.
        l.indent = col;
        l.text = rest.trimEnd();
        out.push(this.parseNode(col));
        continue;
      }
      this.i++;
      out.push(this.valueAfter(rest, col + 1, l, indent, false));
    }
    return out;
  }

  // Value following "key:" or "- ". inMap allows "key:\n- item" at the same indentation.
  valueAfter(rest, col, l, indent, inMap) {
    const r = stripComment(rest).trim();
    if (r.startsWith('|') || r.startsWith('>')) return this.blockScalar(r, l, indent);
    if (r !== '') {
      const value = parseInline(rest, l.num, col);
      if (typeof value === 'string' && !/^["']/.test(r)) {
        // Plain scalar continued on more-indented lines (folded with spaces).
        const parts = [value];
        for (;;) {
          const n = this.peek();
          if (!n || n.indent <= indent) break;
          if (splitKey(n.text, n.num, n.indent) || this.isSeqLine(n)) throw new YamlError('indent', 'Unexpected indentation', n.num, n.indent + 1);
          parts.push(stripComment(n.text).trim());
          this.i++;
        }
        return parts.join(' ');
      }
      const n = this.peek();
      if (n && n.indent > indent) throw new YamlError('indent', 'Unexpected indentation', n.num, n.indent + 1);
      return value;
    }
    const n = this.peek();
    if (!n) return null;
    if (n.indent > indent) return this.parseNode(n.indent);
    if (inMap && n.indent === indent && this.isSeqLine(n)) return this.parseSeq(indent, true);
    return null;
  }

  blockScalar(header, l, parentIndent) {
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(header);
    if (!m) throw new YamlError('blockHeader', 'Invalid block scalar header', l.num, l.indent + 1);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4] || '';
    const explicit = m[3] ? Number(m[3]) : 0;
    const base = Math.max(parentIndent, 0);
    // Collect raw lines (comments are content here).
    const raw = [];
    let contentIndent = explicit ? (parentIndent < 0 ? 0 : parentIndent) + explicit : 0;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.skip && !line.docInline) break;
      const text = line.raw;
      const lead = /^ */.exec(text)[0].length;
      if (text.trim() === '') { raw.push(text); this.i++; continue; }
      if (!contentIndent) {
        if (lead <= base && parentIndent >= 0) break;
        contentIndent = lead;
        if (parentIndent < 0 && lead === 0) contentIndent = 0;
      }
      if (lead < contentIndent || (lead <= base && parentIndent >= 0)) break;
      raw.push(text);
      this.i++;
    }
    // Trailing whitespace-only lines are part of the scalar only for "keep" chomping;
    // either way they cannot belong to anything else.
    const lines = raw.map((t) => (t.trim() === '' ? (t.length > contentIndent ? t.slice(contentIndent) : '') : t.slice(contentIndent)));
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    const body = lines.slice(0, end);
    const trailing = lines.length - end;
    let text;
    if (!folded) text = body.join('\n');
    else {
      text = '';
      let started = false;
      let pending = 0;
      let prev = '';
      for (const cur of body) {
        if (cur === '') { if (started) pending++; else text += '\n'; continue; }
        if (!started) { text += cur; started = true; prev = cur; continue; }
        const keepBreak = /^\s/.test(cur) || /^\s/.test(prev);
        if (pending) text += (keepBreak ? '\n' : '') + '\n'.repeat(pending);
        else text += keepBreak ? '\n' : ' ';
        text += cur;
        pending = 0;
        prev = cur;
      }
    }
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n' + '\n'.repeat(trailing);
    return text + '\n';
  }
}

export function parseYaml(text) {
  return new Parser(text).parseDocument();
}

// ---------- serializer ----------

const INDICATORS = /^[-?:,[\]{}#&*!|>'"%@`]/;

function plainSafe(s) {
  if (s === '' || s !== s.trim()) return false;
  if (INDICATORS.test(s) && !/^[-?:][^\s]/.test(s)) return false;
  if (/^[-?:]$/.test(s)) return false;
  if (/^(---|\.\.\.)/.test(s)) return false;
  if (/: |:$| #|[\n\r\t\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0085\u2028\u2029\ufeff]/.test(s)) return false;
  if (/[,[\]{}]/.test(s)) return false;
  return typeof resolvePlain(s) === 'string';
}

function doubleQuote(s) {
  return JSON.stringify(s).replace(/\u2028/g, '\\L').replace(/\u2029/g, '\\P').replace(/\u0085/g, '\\N').replace(/\ufeff/g, '\\ufeff').replace(/\x7f/g, '\\x7f');
}

function literalSafe(s) {
  if (!s.includes('\n')) return false;
  if (/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0085\u2028\u2029\ufeff]/.test(s)) return false;
  const lines = s.replace(/\n+$/, '').split('\n');
  if (!lines[0] || /^[ \t]/.test(lines[0])) return false;
  return lines.every((line) => !/[ \t]$/.test(line));
}

function scalar(value, pad) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    if (!Number.isFinite(value)) return value > 0 ? '.inf' : '-.inf';
    return String(value);
  }
  if (typeof value === 'bigint') return String(value);
  const s = String(value);
  if (plainSafe(s)) return s;
  if (literalSafe(s)) {
    const trail = /\n*$/.exec(s)[0].length;
    const chomp = trail === 0 ? '-' : trail === 1 ? '' : '+';
    const body = s.slice(0, s.length - trail).split('\n').map((line) => (line ? pad + line : '')).join('\n');
    return `|${chomp}\n${body}${trail > 1 ? '\n'.repeat(trail - 1) : ''}`;
  }
  return doubleQuote(s);
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCollection = (v) => (Array.isArray(v) && v.length > 0) || (isMap(v) && Object.keys(v).length > 0);

function keyText(k) {
  return plainSafe(k) ? k : doubleQuote(k);
}

function emit(value, indent, out) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isCollection(item)) {
        const lines = [];
        emit(item, indent + 2, lines);
        lines[0] = `${pad}- ${lines[0].slice(indent + 2)}`;
        out.push(...lines);
      } else out.push(`${pad}- ${inlineValue(item, indent + 2)}`);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isCollection(v)) {
      out.push(`${pad}${keyText(k)}:`);
      emit(v, indent + 2, out);
    } else out.push(`${pad}${keyText(k)}: ${inlineValue(v, indent + 2)}`);
  }
}

function inlineValue(v, childIndent) {
  if (Array.isArray(v)) return '[]';
  if (isMap(v)) return '{}';
  return scalar(v, ' '.repeat(childIndent));
}

export function stringifyYaml(value) {
  if (!isCollection(value)) return `${inlineValue(value, 2)}\n`;
  const out = [];
  emit(value, 0, out);
  return `${out.join('\n')}\n`;
}

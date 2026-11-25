// XML <-> plain values. Browser only: parsing uses the built-in DOMParser.
// Mapping: attributes become "@name", text becomes "#text", repeated child
// elements become arrays. Every simplification is reported as a notice.
import { ConvertError } from './convert.js';

const notice = (code, lossy, vars = {}) => ({ code, lossy, vars });

function setKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function xmlToValue(text) {
  const doc = new DOMParser().parseFromString(String(text ?? ''), 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    const msg = error.textContent || '';
    const m = /line\s*(?:number)?\s*(\d+)[^0-9]+column\s*(\d+)/i.exec(msg);
    throw new ConvertError('xml', msg.replace(/\s+/g, ' ').trim().slice(0, 240) || 'The XML is not well-formed', { line: m ? Number(m[1]) : 0, column: m ? Number(m[2]) : 0 });
  }
  const stats = { comments: 0, instructions: 0, mixed: 0, cdata: 0 };
  for (const node of doc.childNodes) {
    if (node.nodeType === 8) stats.comments++;
    if (node.nodeType === 7) stats.instructions++;
  }
  const root = doc.documentElement;
  const value = {};
  setKey(value, root.nodeName, element(root, stats));
  const notices = [notice('xmlAllText', false)];
  if (stats.comments) notices.push(notice('xmlCommentsDropped', true, { count: stats.comments }));
  if (stats.instructions) notices.push(notice('xmlInstructionsDropped', true, { count: stats.instructions }));
  if (stats.mixed) notices.push(notice('xmlMixedContent', true, { count: stats.mixed }));
  if (stats.cdata) notices.push(notice('xmlCdata', false, { count: stats.cdata }));
  return { value, notices };
}

function element(el, stats) {
  const out = {};
  for (const attr of el.attributes) setKey(out, `@${attr.name}`, attr.value);
  let text = '';
  let hasElements = false;
  let textParts = 0;
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      hasElements = true;
      const name = child.nodeName;
      const value = element(child, stats);
      if (Object.prototype.hasOwnProperty.call(out, name)) {
        const existing = out[name];
        if (Array.isArray(existing)) existing.push(value);
        else out[name] = [existing, value];
      } else setKey(out, name, value);
    } else if (child.nodeType === 3 || child.nodeType === 4) {
      if (child.nodeType === 4) stats.cdata++;
      if (child.nodeValue.trim()) { text += child.nodeValue; textParts++; }
    } else if (child.nodeType === 8) stats.comments++;
    else if (child.nodeType === 7) stats.instructions++;
  }
  if (hasElements && text.trim()) stats.mixed++;
  if (!hasElements && !el.attributes.length) return text.trim() ? text.trim() : '';
  if (text.trim()) setKey(out, '#text', textParts > 1 ? text.replace(/\s+/g, ' ').trim() : text.trim());
  return out;
}

const NAME_START = /^[A-Za-z_:À-\uffff]/;
const NAME_REST = /[^A-Za-z0-9_.:\-·À-\uffff]/g;

export function xmlName(name, renamed) {
  let n = String(name).replace(NAME_REST, '_');
  if (!NAME_START.test(n)) n = `_${n}`;
  if (/^xml/i.test(n) && !/^xml(ns)?(:|$)/i.test(n)) n = `_${n}`;
  if (n !== name && renamed) renamed.add(`${name} → ${n}`);
  return n;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Value -> XML text. Returns { text, notices }.
export function valueToXml(value, rootName = 'root') {
  const renamed = new Set();
  const stats = { nulls: 0, typed: 0, invalidChars: 0 };
  const clean = (s) => {
    const str = String(s);
    const out = str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '');
    if (out !== str) stats.invalidChars++;
    return out;
  };
  const scalar = (v) => {
    if (v === null || v === undefined) { stats.nulls++; return ''; }
    if (typeof v !== 'string') stats.typed++;
    return esc(clean(v));
  };
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const emit = (name, v, depth) => {
    const pad = '  '.repeat(depth);
    const tag = xmlName(name, renamed);
    if (Array.isArray(v)) { for (const item of v) emit(name, item, depth); return; }
    if (v === null || typeof v !== 'object') { lines.push(`${pad}<${tag}>${scalar(v)}</${tag}>`); return; }
    const attrs = [];
    const children = [];
    let text = null;
    for (const [k, child] of Object.entries(v)) {
      if (k.startsWith('@') && (child === null || typeof child !== 'object')) attrs.push(` ${xmlName(k.slice(1), renamed)}="${scalar(child)}"`);
      else if (k === '#text' && (child === null || typeof child !== 'object')) text = scalar(child);
      else children.push([k, child]);
    }
    if (!children.length) {
      lines.push(text === null || text === '' ? `${pad}<${tag}${attrs.join('')}/>` : `${pad}<${tag}${attrs.join('')}>${text}</${tag}>`);
      return;
    }
    lines.push(`${pad}<${tag}${attrs.join('')}>`);
    if (text) lines.push(`${pad}  ${text}`);
    for (const [k, child] of children) emit(k, child, depth + 1);
    lines.push(`${pad}</${tag}>`);
  };
  const notices = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(value) && Object.keys(value).length === 1 && !Object.keys(value)[0].startsWith('@') && !Array.isArray(Object.values(value)[0])) {
    const [k] = Object.keys(value);
    emit(k, value[k], 0);
  } else if (Array.isArray(value)) {
    notices.push(notice('xmlWrapped', false, { root: rootName }));
    lines.push(`<${xmlName(rootName, renamed)}>`);
    for (const item of value) emit('item', item, 1);
    lines.push(`</${xmlName(rootName, renamed)}>`);
  } else {
    notices.push(notice('xmlWrapped', false, { root: rootName }));
    emit(rootName, value, 0);
  }
  if (renamed.size) notices.push(notice('xmlRenamed', true, { list: [...renamed].slice(0, 12).join(', ') }));
  if (stats.nulls) notices.push(notice('nullToEmpty', true, { count: stats.nulls }));
  if (stats.typed) notices.push(notice('typesToText', true, { count: stats.typed }));
  if (stats.invalidChars) notices.push(notice('xmlInvalidChars', true, { count: stats.invalidChars }));
  return { text: lines.join('\n') + '\n', notices };
}

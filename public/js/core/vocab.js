// Personal vocabulary: a private JSON the user uploads or drops on the window.
// It never leaves this browser: not sent to the server, not logged, not exported,
// not written to settings history. Clearing it restores the shipped wording.
//
// Schema (version 1):
//   { "schemaVersion": 1, "name"?: string, "entries": { "ordinary phrase": "replacement", ... } }
// Bounds: 256 KiB UTF-8, nesting depth 8, keys <= 160 code points, values <= 1000.
const CACHE_KEY = 'mac.vocab.v1';
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_KEY = 160;
const MAX_VALUE = 1000;

let active = null; // { name, entries: [[from, to]], matcher }
const listeners = new Set();

export class VocabError extends Error {}

function depth(value, d = 0) {
  if (d > MAX_DEPTH) return d;
  if (value && typeof value === 'object') {
    let max = d;
    for (const v of Object.values(value)) max = Math.max(max, depth(v, d + 1));
    return max;
  }
  return d;
}

// Rejects duplicate keys, which JSON.parse would silently collapse.
function assertNoDuplicateKeys(text) {
  const stack = [];
  let i = 0;
  const len = text.length;
  const readString = () => {
    let out = '';
    i++;
    while (i < len) {
      const c = text[i];
      if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
      if (c === '"') { i++; return out; }
      out += c; i++;
    }
    throw new VocabError('Unterminated string.');
  };
  while (i < len) {
    const c = text[i];
    if (c === '{') { stack.push({ keys: new Set(), expectKey: true }); i++; continue; }
    if (c === '[') { stack.push(null); i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    if (c === ',') { const top = stack.at(-1); if (top) top.expectKey = true; i++; continue; }
    if (c === ':') { const top = stack.at(-1); if (top) top.expectKey = false; i++; continue; }
    if (c === '"') {
      const top = stack.at(-1);
      const s = readString();
      if (top && top.expectKey) {
        if (top.keys.has(s)) throw new VocabError('The file repeats a key.');
        top.keys.add(s);
      }
      continue;
    }
    i++;
  }
}

export function validate(text) {
  if (typeof text !== 'string') throw new VocabError('Not a text file.');
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new VocabError('The file is larger than 256 KiB.');
  let data;
  try { data = JSON.parse(text); } catch { throw new VocabError('The file is not valid JSON.'); }
  assertNoDuplicateKeys(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new VocabError('The file must be a JSON object.');
  if (data.schemaVersion !== 1) throw new VocabError('Unsupported schemaVersion (expected 1).');
  if (depth(data) > MAX_DEPTH) throw new VocabError('The file is nested too deeply.');
  if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new VocabError('The file needs an "entries" object.');
  const entries = [];
  for (const [from, to] of Object.entries(data.entries)) {
    if (typeof to !== 'string') throw new VocabError('Every entry value must be text.');
    if ([...from].length > MAX_KEY) throw new VocabError('An entry key is too long.');
    if ([...to].length > MAX_VALUE) throw new VocabError('An entry value is too long.');
    if (!from.trim()) throw new VocabError('An entry key is empty.');
    entries.push([from, to]);
  }
  if (!entries.length) throw new VocabError('The file has no entries.');
  const name = typeof data.name === 'string' ? data.name.slice(0, 80) : '';
  return { name, entries };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function compile(entries) {
  // Longest phrases first so "the workflow run failed" wins over "workflow run".
  const sorted = [...entries].sort((a, b) => b[0].length - a[0].length);
  const map = new Map(sorted.map(([f, t]) => [f.toLowerCase(), t]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${sorted.map(([f]) => escapeRe(f)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return { map, re };
}

function matchCase(source, replacement) {
  if (source[0] && source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function apply(text) {
  if (!active || text == null) return text;
  const s = String(text);
  return s.replace(active.matcher.re, (m) => matchCase(m, active.matcher.map.get(m.toLowerCase()) ?? m));
}

function use(parsed) {
  active = parsed ? { ...parsed, matcher: compile(parsed.entries) } : null;
  for (const fn of listeners) fn(status());
}

export function load(text) {
  const parsed = validate(text); // throws before anything changes
  try { localStorage.setItem(CACHE_KEY, text); } catch { /* memory only */ }
  use(parsed);
  return status();
}

export function clear() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  use(null);
}

export function status() {
  return active ? { loaded: true, name: active.name, count: active.entries.length } : { loaded: false };
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function init() {
  let cached = null;
  try { cached = localStorage.getItem(CACHE_KEY); } catch { /* ignore */ }
  if (!cached) return status();
  try {
    use(validate(cached));
  } catch {
    // Corrupt cache: drop it and fall back to shipped wording.
    clear();
    return { loaded: false, corrupted: true };
  }
  return status();
}

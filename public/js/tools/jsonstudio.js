// JSON studio: pure logic with no DOM access.
// - A strict JSON parser with line/column errors that keeps key order exactly.
// - An ordered tree model with immutable edit operations and undo/redo history.
// - A type generator, in the style of quicktype (not the quicktype library), that
//   infers a shape from samples and emits TypeScript, JSON Schema 2020-12, Go,
//   Python dataclasses, C# records, Rust serde structs and Kotlin data classes.

// ---------- strict parser ----------

export class JsonError extends Error {
  constructor(message, offset, text) {
    const { line, column } = lineCol(text, offset);
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'JsonError';
    this.reason = message;
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export function lineCol(text, offset) {
  let line = 1;
  let start = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) { line++; start = i + 1; }
  return { line, column: end - start + 1 };
}

const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Reader {
  constructor(text) { this.s = text; this.i = 0; this.warnings = []; }
  fail(msg, at = this.i) { throw new JsonError(msg, at, this.s); }
  ws() {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i++;
      else break;
    }
  }
  describe(at = this.i) {
    return at >= this.s.length ? 'end of input' : JSON.stringify(this.s[at]);
  }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return { type: 'string', value: this.string() };
    if (c === '-' || (c >= '0' && c <= '9')) return { type: 'number', value: this.number() };
    for (const [word, node] of [['true', { type: 'boolean', value: true }], ['false', { type: 'boolean', value: false }], ['null', { type: 'null', value: null }]]) {
      if (this.s.startsWith(word, this.i)) { this.i += word.length; return node; }
    }
    return this.fail(`Unexpected ${this.describe()}; expected a value`);
  }
  object() {
    this.i++;
    const entries = [];
    const seen = new Map();
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return { type: 'object', entries }; }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail(`Unexpected ${this.describe()}; expected a quoted key`);
      const keyAt = this.i;
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail(`Unexpected ${this.describe()}; expected ":"`);
      this.i++;
      const node = this.value();
      if (seen.has(key)) {
        const { line, column } = lineCol(this.s, keyAt);
        this.warnings.push({ code: 'duplicateKey', key, line, column });
        entries[seen.get(key)].node = node;
      } else {
        seen.set(key, entries.length);
        entries.push({ key, node });
      }
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); if (this.s[this.i] === '}') this.fail('Trailing comma before "}"'); continue; }
      if (c === '}') { this.i++; return { type: 'object', entries }; }
      this.fail(`Unexpected ${this.describe()}; expected "," or "}"`);
    }
  }
  array() {
    this.i++;
    const items = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return { type: 'array', items }; }
    for (;;) {
      items.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') { this.i++; this.ws(); if (this.s[this.i] === ']') this.fail('Trailing comma before "]"'); continue; }
      if (c === ']') { this.i++; return { type: 'array', items }; }
      this.fail(`Unexpected ${this.describe()}; expected "," or "]"`);
    }
  }
  string() {
    const s = this.s;
    const start = this.i;
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= s.length) this.fail('String is not closed', start);
      const c = s[this.i];
      if (c === '"') { this.i++; return out; }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n in ESC) { out += ESC[n]; this.i += 2; continue; }
        if (n === 'u') {
          const hex = s.slice(this.i + 2, this.i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 6;
          continue;
        }
        this.fail(`Invalid escape \\${n ?? ''}`);
      }
      if (s.charCodeAt(this.i) < 0x20) this.fail('Control character inside a string; escape it');
      out += c;
      this.i++;
    }
  }
  number() {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.s.slice(this.i, this.i + 400));
    if (!m || m[0] === '-') this.fail('Invalid number');
    this.i += m[0].length;
    const next = this.s[this.i];
    if (next && /[0-9.eE]/.test(next)) this.fail('Invalid number');
    return Number(m[0]);
  }
}

// Parses one JSON document into an ordered tree.
// Returns { ok: true, tree, warnings } or { ok: false, error: { message, line, column, offset } }.
export function parseJson(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const r = new Reader(src);
  try {
    const tree = r.value();
    r.ws();
    if (r.i < src.length) r.fail(`Unexpected ${r.describe()} after the end of the document`);
    return { ok: true, tree, warnings: r.warnings };
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
    return { ok: false, error: { message: e.reason, line: e.line, column: e.column, offset: e.offset } };
  }
}

// Parses several JSON documents in a row (concatenated or one per line).
export function parseMany(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const r = new Reader(src);
  const trees = [];
  try {
    r.ws();
    while (r.i < src.length) {
      trees.push(r.value());
      r.ws();
      if (src[r.i] === ',') { r.i++; r.ws(); }
    }
    return { ok: true, trees, warnings: r.warnings };
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
    return { ok: false, error: { message: e.reason, line: e.line, column: e.column, offset: e.offset } };
  }
}

// ---------- tree <-> values ----------

export function toValue(node) {
  switch (node.type) {
    case 'object': {
      const out = {};
      for (const { key, node: child } of node.entries) Object.defineProperty(out, key, { value: toValue(child), enumerable: true, writable: true, configurable: true });
      return out;
    }
    case 'array': return node.items.map(toValue);
    default: return node.value;
  }
}

export function fromValue(value) {
  if (value === null || value === undefined) return { type: 'null', value: null };
  if (Array.isArray(value)) return { type: 'array', items: value.map(fromValue) };
  if (typeof value === 'object') return { type: 'object', entries: Object.keys(value).map((key) => ({ key, node: fromValue(value[key]) })) };
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : { type: 'null', value: null };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  return { type: 'string', value: String(value) };
}

// Serializes a tree with its key order preserved (integer-like keys included).
export function stringify(node, indent = 2) {
  const pad = typeof indent === 'number' ? ' '.repeat(indent) : String(indent);
  const walk = (n, depth) => {
    const inner = pad ? `\n${pad.repeat(depth + 1)}` : '';
    const close = pad ? `\n${pad.repeat(depth)}` : '';
    const sep = pad ? ': ' : ':';
    if (n.type === 'object') {
      if (!n.entries.length) return '{}';
      return `{${n.entries.map((e) => `${inner}${JSON.stringify(e.key)}${sep}${walk(e.node, depth + 1)}`).join(',')}${close}}`;
    }
    if (n.type === 'array') {
      if (!n.items.length) return '[]';
      return `[${n.items.map((c) => `${inner}${walk(c, depth + 1)}`).join(',')}${close}]`;
    }
    return JSON.stringify(n.value);
  };
  return walk(node, 0);
}

// ---------- immutable edits (paths are arrays of object keys / array indices) ----------

export class EditError extends Error {
  constructor(code, message) { super(message); this.name = 'EditError'; this.code = code; }
}

export function getAt(root, path) {
  let n = root;
  for (const seg of path) {
    if (n.type === 'object') n = n.entries.find((e) => e.key === seg)?.node;
    else if (n.type === 'array') n = n.items[seg];
    else n = undefined;
    if (!n) throw new EditError('noPath', `Path ${JSON.stringify(path)} does not exist`);
  }
  return n;
}

// Returns a new root where the node at path is replaced by fn(node).
export function updateAt(root, path, fn) {
  if (!path.length) return fn(root);
  const [seg, ...rest] = path;
  if (root.type === 'object') {
    const idx = root.entries.findIndex((e) => e.key === seg);
    if (idx < 0) throw new EditError('noPath', `Key ${JSON.stringify(seg)} does not exist`);
    const entries = root.entries.slice();
    entries[idx] = { key: entries[idx].key, node: updateAt(entries[idx].node, rest, fn) };
    return { ...root, entries };
  }
  if (root.type === 'array') {
    if (!(seg in root.items)) throw new EditError('noPath', `Index ${seg} does not exist`);
    const items = root.items.slice();
    items[seg] = updateAt(items[seg], rest, fn);
    return { ...root, items };
  }
  throw new EditError('noPath', 'Path goes through a value that is not a container');
}

export function setAt(root, path, node) {
  return updateAt(root, path, () => node);
}

export function setValue(root, path, value) {
  return updateAt(root, path, (n) => {
    if (n.type === 'number') {
      const num = typeof value === 'number' ? value : Number(String(value).trim());
      if (String(value).trim() === '' || !Number.isFinite(num)) throw new EditError('notNumber', `${JSON.stringify(String(value))} is not a finite number`);
      return { type: 'number', value: num };
    }
    if (n.type === 'boolean') return { type: 'boolean', value: value === true || value === 'true' };
    if (n.type === 'string') return { type: 'string', value: String(value) };
    throw new EditError('notScalar', 'Only strings, numbers and true/false have an editable value');
  });
}

// Adds a child to the container at path. For objects a unique key is required.
export function addChild(root, path, { key, node = { type: 'null', value: null }, index } = {}) {
  return updateAt(root, path, (n) => {
    if (n.type === 'object') {
      const k = key ?? uniqueKey(n, 'key');
      if (n.entries.some((e) => e.key === k)) throw new EditError('duplicateKey', `Key ${JSON.stringify(k)} already exists`);
      const entries = n.entries.slice();
      entries.splice(index ?? entries.length, 0, { key: k, node });
      return { ...n, entries };
    }
    if (n.type === 'array') {
      const items = n.items.slice();
      items.splice(index ?? items.length, 0, node);
      return { ...n, items };
    }
    throw new EditError('notContainer', 'Only objects and arrays can have children');
  });
}

export function uniqueKey(objectNode, base = 'key') {
  const used = new Set(objectNode.entries.map((e) => e.key));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export function renameKey(root, parentPath, oldKey, newKey) {
  return updateAt(root, parentPath, (n) => {
    if (n.type !== 'object') throw new EditError('notObject', 'Only object members have keys');
    if (oldKey === newKey) return n;
    if (n.entries.some((e) => e.key === newKey)) throw new EditError('duplicateKey', `Key ${JSON.stringify(newKey)} already exists`);
    return { ...n, entries: n.entries.map((e) => (e.key === oldKey ? { key: newKey, node: e.node } : e)) };
  });
}

export function removeAt(root, path) {
  if (!path.length) throw new EditError('root', 'The root cannot be deleted');
  const parent = path.slice(0, -1);
  const seg = path[path.length - 1];
  return updateAt(root, parent, (n) => {
    if (n.type === 'object') return { ...n, entries: n.entries.filter((e) => e.key !== seg) };
    if (n.type === 'array') return { ...n, items: n.items.filter((_, i) => i !== seg) };
    throw new EditError('notContainer', 'Parent is not a container');
  });
}

// Moves a child of the container at parentPath from one position to another.
export function moveChild(root, parentPath, from, to) {
  return updateAt(root, parentPath, (n) => {
    const list = n.type === 'object' ? n.entries.slice() : n.type === 'array' ? n.items.slice() : null;
    if (!list) throw new EditError('notContainer', 'Only objects and arrays can be reordered');
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return n;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    return n.type === 'object' ? { ...n, entries: list } : { ...n, items: list };
  });
}

export const NODE_TYPES = ['object', 'array', 'string', 'number', 'boolean', 'null'];

// Converts a node to another type, keeping as much of the content as is sensible.
export function changeType(node, type) {
  if (node.type === type) return node;
  const scalarText = node.type === 'string' ? node.value : node.type === 'number' || node.type === 'boolean' ? String(node.value) : '';
  switch (type) {
    case 'string':
      return { type, value: node.type === 'object' || node.type === 'array' ? stringify(node, 0) : scalarText };
    case 'number': {
      const n = Number(scalarText);
      return { type, value: node.type === 'boolean' ? (node.value ? 1 : 0) : scalarText.trim() !== '' && Number.isFinite(n) ? n : 0 };
    }
    case 'boolean':
      return { type, value: node.type === 'string' ? scalarText.trim().toLowerCase() === 'true' : node.type === 'number' ? node.value !== 0 : false };
    case 'null':
      return { type, value: null };
    case 'array':
      if (node.type === 'object') return { type, items: node.entries.map((e) => e.node) };
      return { type, items: node.type === 'null' ? [] : [node] };
    case 'object':
      if (node.type === 'array') return { type, entries: node.items.map((c, i) => ({ key: String(i), node: c })) };
      return { type, entries: node.type === 'null' ? [] : [{ key: 'value', node }] };
    default:
      throw new EditError('badType', `Unknown type ${type}`);
  }
}

// Undo/redo history of immutable states.
export function createHistory(initial, limit = 200) {
  let past = [];
  let future = [];
  let present = initial;
  return {
    get state() { return present; },
    push(next) {
      if (next === present) return present;
      past.push(present);
      if (past.length > limit) past = past.slice(-limit);
      future = [];
      present = next;
      return present;
    },
    undo() { if (past.length) { future.push(present); present = past.pop(); } return present; },
    redo() { if (future.length) { past.push(present); present = future.pop(); } return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    reset(state) { past = []; future = []; present = state; return present; },
  };
}

// ---------- type inference ----------

function emptyShape() {
  return { seen: 0, nul: false, bool: false, int: false, float: false, str: false, array: null, object: null };
}

// Adds one plain JSON value (from JSON.parse or toValue) into a shape.
export function addSample(shape, value) {
  shape.seen++;
  if (value === null || value === undefined) shape.nul = true;
  else if (typeof value === 'boolean') shape.bool = true;
  else if (typeof value === 'number') { if (Number.isInteger(value)) shape.int = true; else shape.float = true; }
  else if (typeof value === 'string') shape.str = true;
  else if (Array.isArray(value)) {
    shape.array = shape.array || emptyShape();
    for (const item of value) addSample(shape.array, item);
  } else {
    shape.object = shape.object || { count: 0, fields: new Map() };
    shape.object.count++;
    for (const key of Object.keys(value)) {
      if (!shape.object.fields.has(key)) shape.object.fields.set(key, emptyShape());
      addSample(shape.object.fields.get(key), value[key]);
    }
  }
  return shape;
}

export function inferShape(samples) {
  const shape = emptyShape();
  for (const s of samples) addSample(shape, s);
  return shape;
}

// ---------- naming ----------

export function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
export function pascal(name) {
  const w = words(name);
  const s = w.map(cap).join('') || 'Field';
  return /^[0-9]/.test(s) ? `N${s}` : s;
}
export function camel(name) {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
}
export function snake(name) {
  const s = words(name).join('_') || 'field';
  return /^[0-9]/.test(s) ? `n_${s}` : s;
}

export function singular(name) {
  const n = String(name);
  if (/ies$/i.test(n) && n.length > 3) return n.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(n)) return n;
  if (/(x|ch|sh|ses)es$/i.test(n)) return n.slice(0, -2);
  if (/s$/i.test(n) && n.length > 1) return n.slice(0, -1);
  return `${n}Item`;
}

// ---------- model: named classes and type references ----------

// TypeRef: { kind: 'any'|'null'|'bool'|'int'|'float'|'string'|'array'|'class'|'union', nullable, items?, name?, members? }
export function buildModel(shape, rootName = 'Root') {
  const classes = [];
  const bySignature = new Map();
  const usedNames = new Set();

  const uniqueName = (base) => {
    let name = pascal(base);
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
    let i = 2;
    while (usedNames.has(`${name}${i}`)) i++;
    usedNames.add(`${name}${i}`);
    return `${name}${i}`;
  };

  const ref = (s, nameHint) => {
    const members = [];
    if (s.bool) members.push({ kind: 'bool' });
    if (s.int && !s.float) members.push({ kind: 'int' });
    if (s.float) members.push({ kind: 'float' });
    if (s.str) members.push({ kind: 'string' });
    if (s.array) members.push({ kind: 'array', items: s.array.seen ? ref(s.array, singular(nameHint)) : { kind: 'any', nullable: false } });
    if (s.object) members.push(classRef(s.object, nameHint));
    if (!members.length) return { kind: s.nul ? 'null' : 'any', nullable: false };
    if (members.length === 1) return { ...members[0], nullable: s.nul };
    return { kind: 'union', members: members.map((m) => ({ ...m, nullable: false })), nullable: s.nul };
  };

  const classRef = (obj, nameHint, reserved = '') => {
    const fields = [];
    for (const [jsonName, fieldShape] of obj.fields) {
      fields.push({ jsonName, type: ref(fieldShape, jsonName), optional: fieldShape.seen < obj.count });
    }
    const signature = JSON.stringify(fields.map((f) => [f.jsonName, sig(f.type), f.optional]));
    if (!reserved && bySignature.has(signature)) return { kind: 'class', name: bySignature.get(signature) };
    const name = reserved || uniqueName(nameHint);
    bySignature.set(signature, name);
    classes.push({ name, fields });
    return { kind: 'class', name };
  };

  const reservedRoot = pascal(rootName);
  usedNames.add(reservedRoot);
  let root;
  if (shape.object && !shape.array && !shape.bool && !shape.int && !shape.float && !shape.str) {
    root = { ...classRef(shape.object, rootName, reservedRoot), nullable: shape.nul };
  } else {
    root = ref(shape, rootName);
  }
  // Classes were created depth-first, so dependencies come before their users.
  return { root, classes, rootName: pascal(rootName) };
}

function sig(t) {
  if (t.kind === 'array') return `[${sig(t.items)}]${t.nullable ? '?' : ''}`;
  if (t.kind === 'class') return `#${t.name}${t.nullable ? '?' : ''}`;
  if (t.kind === 'union') return `(${t.members.map(sig).join('|')})${t.nullable ? '?' : ''}`;
  return `${t.kind}${t.nullable ? '?' : ''}`;
}

// ---------- emitters ----------

const TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function tsType(t) {
  let s;
  switch (t.kind) {
    case 'any': s = 'unknown'; break;
    case 'null': return 'null';
    case 'bool': s = 'boolean'; break;
    case 'int': case 'float': s = 'number'; break;
    case 'string': s = 'string'; break;
    case 'class': s = t.name; break;
    case 'array': { const inner = tsType(t.items); s = /[|]/.test(inner) ? `Array<${inner}>` : `${inner}[]`; break; }
    case 'union': s = t.members.map(tsType).join(' | '); break;
    default: s = 'unknown';
  }
  return t.nullable ? `${s} | null` : s;
}

export function emitTypeScript(model) {
  const out = [];
  for (const c of model.classes) {
    out.push(`export interface ${c.name} {`);
    for (const f of c.fields) out.push(`  ${TS_IDENT.test(f.jsonName) ? f.jsonName : JSON.stringify(f.jsonName)}${f.optional ? '?' : ''}: ${tsType(f.type)};`);
    out.push('}', '');
  }
  if (model.root.kind !== 'class' || model.root.name !== model.rootName) out.push(`export type ${model.rootName} = ${tsType(model.root)};`, '');
  return out.join('\n').trimEnd() + '\n';
}

function schemaType(t) {
  let s;
  switch (t.kind) {
    case 'any': return {};
    case 'null': return { type: 'null' };
    case 'bool': s = { type: 'boolean' }; break;
    case 'int': s = { type: 'integer' }; break;
    case 'float': s = { type: 'number' }; break;
    case 'string': s = { type: 'string' }; break;
    case 'class': s = { $ref: `#/$defs/${t.name}` }; break;
    case 'array': s = { type: 'array', items: schemaType(t.items) }; break;
    case 'union': s = { anyOf: t.members.map(schemaType) }; break;
    default: return {};
  }
  if (!t.nullable) return s;
  if (s.type && typeof s.type === 'string') return { ...s, type: [s.type, 'null'] };
  if (s.anyOf) return { anyOf: [...s.anyOf, { type: 'null' }] };
  return { anyOf: [s, { type: 'null' }] };
}

export function emitJsonSchema(model) {
  const defs = {};
  for (const c of model.classes) {
    const properties = {};
    for (const f of c.fields) properties[f.jsonName] = schemaType(f.type);
    const required = c.fields.filter((f) => !f.optional).map((f) => f.jsonName);
    defs[c.name] = { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true };
  }
  const doc = { $schema: 'https://json-schema.org/draft/2020-12/schema', title: model.rootName, ...schemaType(model.root) };
  if (Object.keys(defs).length) doc.$defs = defs;
  return JSON.stringify(doc, null, 2) + '\n';
}

const GO_INITIALISMS = new Set(['id', 'url', 'uri', 'api', 'http', 'https', 'json', 'xml', 'html', 'uuid', 'ip', 'sql', 'css', 'cpu', 'ui', 'utc', 'tcp', 'udp', 'dns', 'ttl']);
function goName(name) {
  const w = words(name);
  const s = w.map((x) => (GO_INITIALISMS.has(x) ? x.toUpperCase() : cap(x))).join('') || 'Field';
  return /^[0-9]/.test(s) ? `N${s}` : s;
}
function goType(t, pointerIfNullable = true) {
  let s;
  switch (t.kind) {
    case 'any': case 'null': case 'union': return 'interface{}';
    case 'bool': s = 'bool'; break;
    case 'int': s = 'int64'; break;
    case 'float': s = 'float64'; break;
    case 'string': s = 'string'; break;
    case 'class': s = t.name; break;
    case 'array': return `[]${goType(t.items)}`;
    default: return 'interface{}';
  }
  return t.nullable && pointerIfNullable ? `*${s}` : s;
}

export function emitGo(model, { packageName = 'main' } = {}) {
  const out = [`package ${packageName}`, ''];
  for (const c of model.classes) {
    out.push(`type ${c.name} struct {`);
    const used = new Set();
    const rows = c.fields.map((f) => {
      let n = goName(f.jsonName);
      while (used.has(n)) n += '_';
      used.add(n);
      const base = goType(f.type);
      const type = f.optional && !/^(\*|\[\]|interface)/.test(base) ? `*${base}` : base;
      return [n, type, `\`json:"${f.jsonName.replace(/["\\`]/g, '')}${f.optional ? ',omitempty' : ''}"\``];
    });
    const w1 = Math.max(0, ...rows.map((r) => r[0].length));
    const w2 = Math.max(0, ...rows.map((r) => r[1].length));
    for (const [n, type, tag] of rows) out.push(`\t${n.padEnd(w1)} ${type.padEnd(w2)} ${tag}`);
    out.push('}', '');
  }
  if (model.root.kind !== 'class' || model.root.name !== model.rootName) out.push(`type ${model.rootName} ${goType(model.root)}`, '');
  return out.join('\n').trimEnd() + '\n';
}

const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'type']);
function pyType(t) {
  let s;
  switch (t.kind) {
    case 'any': return 'Any';
    case 'null': return 'None';
    case 'bool': s = 'bool'; break;
    case 'int': s = 'int'; break;
    case 'float': s = 'float'; break;
    case 'string': s = 'str'; break;
    case 'class': s = t.name; break;
    case 'array': s = `List[${pyType(t.items)}]`; break;
    case 'union': s = `Union[${t.members.map(pyType).join(', ')}]`; break;
    default: return 'Any';
  }
  return t.nullable ? `Optional[${s}]` : s;
}

export function emitPython(model) {
  const body = [];
  for (const c of model.classes) {
    body.push('@dataclass', `class ${c.name}:`);
    if (!c.fields.length) body.push('    pass');
    const used = new Set();
    const rows = c.fields.map((f) => {
      let n = snake(f.jsonName);
      if (PY_KEYWORDS.has(n)) n += '_';
      while (used.has(n)) n += '_';
      used.add(n);
      let type = pyType(f.type);
      if (f.optional && !type.startsWith('Optional[') && type !== 'Any' && type !== 'None') type = `Optional[${type}]`;
      const note = n !== f.jsonName ? `  # JSON key: ${JSON.stringify(f.jsonName)}` : '';
      return { line: `    ${n}: ${type}${f.optional ? ' = None' : ''}${note}`, optional: f.optional };
    });
    // Fields with defaults must follow fields without them.
    for (const r of rows.filter((x) => !x.optional)) body.push(r.line);
    for (const r of rows.filter((x) => x.optional)) body.push(r.line);
    body.push('', '');
  }
  if (model.root.kind !== 'class' || model.root.name !== model.rootName) body.push(`${model.rootName} = ${pyType(model.root)}`, '');
  const text = body.join('\n');
  const typing = ['Any', 'List', 'Optional', 'Union'].filter((n) => new RegExp(`\\b${n}\\b`).test(text));
  const head = ['from __future__ import annotations', '', 'from dataclasses import dataclass'];
  if (typing.length) head.push(`from typing import ${typing.join(', ')}`);
  return `${head.join('\n')}\n\n\n${text.trimEnd()}\n`;
}

const CS_KEYWORDS = new Set(['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while']);
function csType(t) {
  let s;
  switch (t.kind) {
    case 'any': case 'null': case 'union': return 'object?';
    case 'bool': s = 'bool'; break;
    case 'int': s = 'long'; break;
    case 'float': s = 'double'; break;
    case 'string': s = 'string'; break;
    case 'class': s = t.name; break;
    case 'array': s = `List<${csType(t.items)}>`; break;
    default: return 'object?';
  }
  return t.nullable ? `${s}?` : s;
}

export function emitCSharp(model, { namespace = 'Generated' } = {}) {
  const out = ['using System.Collections.Generic;', 'using System.Text.Json.Serialization;', '', `namespace ${namespace};`, ''];
  for (const c of model.classes) {
    const used = new Set([c.name]);
    const params = c.fields.map((f) => {
      let n = pascal(f.jsonName);
      if (CS_KEYWORDS.has(n.toLowerCase()) && n === n.toLowerCase()) n = `@${n}`;
      while (used.has(n)) n += '_';
      used.add(n);
      let type = csType(f.type);
      if (f.optional && !type.endsWith('?')) type += '?';
      return `    [property: JsonPropertyName(${JSON.stringify(f.jsonName)})] ${type} ${n}`;
    });
    out.push(params.length ? `public record ${c.name}(\n${params.join(',\n')}\n);` : `public record ${c.name}();`, '');
  }
  if (model.root.kind !== 'class' || model.root.name !== model.rootName) out.push(`// ${model.rootName}: ${csType(model.root)}`, '');
  return out.join('\n').trimEnd() + '\n';
}

const RUST_KEYWORDS = new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try']);
function rustType(t) {
  let s;
  switch (t.kind) {
    case 'any': case 'null': case 'union': return 'serde_json::Value';
    case 'bool': s = 'bool'; break;
    case 'int': s = 'i64'; break;
    case 'float': s = 'f64'; break;
    case 'string': s = 'String'; break;
    case 'class': s = t.name; break;
    case 'array': s = `Vec<${rustType(t.items)}>`; break;
    default: return 'serde_json::Value';
  }
  return t.nullable ? `Option<${s}>` : s;
}

export function emitRust(model) {
  const out = ['use serde::{Deserialize, Serialize};', ''];
  for (const c of model.classes) {
    out.push('#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]', `pub struct ${c.name} {`);
    const used = new Set();
    for (const f of c.fields) {
      let n = snake(f.jsonName);
      while (used.has(n)) n += '_';
      used.add(n);
      let type = rustType(f.type);
      if (f.optional && !type.startsWith('Option<') && type !== 'serde_json::Value') type = `Option<${type}>`;
      const attrs = [];
      if (n !== f.jsonName) attrs.push(`rename = ${JSON.stringify(f.jsonName)}`);
      if (f.optional) attrs.push('default', 'skip_serializing_if = "Option::is_none"');
      if (f.optional && type === 'serde_json::Value') attrs.splice(attrs.indexOf('skip_serializing_if = "Option::is_none"'), 1);
      if (attrs.length) out.push(`    #[serde(${attrs.join(', ')})]`);
      out.push(`    pub ${RUST_KEYWORDS.has(n) ? `r#${n}` : n}: ${type},`);
    }
    out.push('}', '');
  }
  if (model.root.kind !== 'class' || model.root.name !== model.rootName) out.push(`pub type ${model.rootName} = ${rustType(model.root)};`, '');
  return out.join('\n').trimEnd() + '\n';
}

const KT_KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);
function ktType(t) {
  let s;
  switch (t.kind) {
    case 'any': case 'null': case 'union': return 'JsonElement?';
    case 'bool': s = 'Boolean'; break;
    case 'int': s = 'Long'; break;
    case 'float': s = 'Double'; break;
    case 'string': s = 'String'; break;
    case 'class': s = t.name; break;
    case 'array': s = `List<${ktType(t.items)}>`; break;
    default: return 'JsonElement?';
  }
  return t.nullable ? `${s}?` : s;
}

export function emitKotlin(model) {
  const out = ['import kotlinx.serialization.SerialName', 'import kotlinx.serialization.Serializable', 'import kotlinx.serialization.json.JsonElement', ''];
  for (const c of model.classes) {
    const used = new Set();
    const params = c.fields.map((f) => {
      let n = camel(f.jsonName);
      while (used.has(n)) n += '_';
      used.add(n);
      const name = KT_KEYWORDS.has(n) ? `\`${n}\`` : n;
      let type = ktType(f.type);
      if (f.optional && !type.endsWith('?')) type += '?';
      return `    @SerialName(${JSON.stringify(f.jsonName)}) val ${name}: ${type}${f.optional ? ' = null' : ''}`;
    });
    out.push('@Serializable', params.length ? `data class ${c.name}(\n${params.join(',\n')}\n)` : `class ${c.name}`, '');
  }
  if (model.root.kind !== 'class' || model.root.name !== model.rootName) out.push(`typealias ${model.rootName} = ${ktType(model.root)}`, '');
  return out.join('\n').trimEnd() + '\n';
}

export const LANGUAGES = [
  { id: 'typescript', label: 'TypeScript interfaces', ext: 'ts', emit: emitTypeScript },
  { id: 'jsonschema', label: 'JSON Schema (2020-12)', ext: 'schema.json', emit: emitJsonSchema },
  { id: 'go', label: 'Go structs', ext: 'go', emit: emitGo },
  { id: 'python', label: 'Python dataclasses', ext: 'py', emit: emitPython },
  { id: 'csharp', label: 'C# records', ext: 'cs', emit: emitCSharp },
  { id: 'rust', label: 'Rust serde structs', ext: 'rs', emit: emitRust },
  { id: 'kotlin', label: 'Kotlin data classes', ext: 'kt', emit: emitKotlin },
];

// Samples (plain values) -> source code in the chosen language.
export function generateTypes(samples, language = 'typescript', { rootName = 'Root' } = {}) {
  const lang = LANGUAGES.find((l) => l.id === language);
  if (!lang) throw new Error(`Unknown language ${language}`);
  if (!samples.length) throw new Error('At least one sample is needed');
  return lang.emit(buildModel(inferShape(samples), rootName));
}

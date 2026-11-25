import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJson, parseMany, toValue, fromValue, stringify, getAt, setValue, addChild, renameKey, removeAt, moveChild, changeType, createHistory,
  inferShape, buildModel, generateTypes, emitTypeScript, emitJsonSchema, emitGo, emitPython, emitCSharp, emitRust, emitKotlin, LANGUAGES,
  pascal, camel, snake, singular,
} from '../public/js/tools/jsonstudio.js';

test('parser keeps key order, including integer-like keys', () => {
  const r = parseJson('{"b":1,"2":2,"a":[true,null,"x"]}');
  assert.ok(r.ok);
  assert.equal(stringify(r.tree, 0), '{"b":1,"2":2,"a":[true,null,"x"]}');
  assert.deepEqual(toValue(r.tree), { b: 1, 2: 2, a: [true, null, 'x'] });
});

test('parser errors carry line and column', () => {
  const cases = [
    ['{\n  "a": 1,\n}', 3, 1, /Trailing comma/],
    ['[1, 2', 1, 6, /expected "," or "]"/],
    ['{"a" 1}', 1, 6, /expected ":"/],
    ['"abc', 1, 1, /not closed/],
    ['01', 1, 2, /Invalid number|after the end/],
    ['{} x', 1, 4, /after the end/],
    ["{'a':1}", 1, 2, /quoted key/],
  ];
  for (const [text, line, column, re] of cases) {
    const r = parseJson(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.error.line, line, text);
    assert.equal(r.error.column, column, text);
    assert.match(r.error.message, re, text);
  }
  const dup = parseJson('{"a":1,\n"a":2}');
  assert.deepEqual(dup.warnings, [{ code: 'duplicateKey', key: 'a', line: 2, column: 1 }]);
});

test('parseMany reads concatenated and line-separated documents', () => {
  const r = parseMany('{"a":1}\n{"a":2} [3]');
  assert.ok(r.ok);
  assert.deepEqual(r.trees.map(toValue), [{ a: 1 }, { a: 2 }, [3]]);
});

test('tree edits are immutable and validated', () => {
  const root = fromValue({ a: 1, list: ['x'] });
  const added = addChild(root, [], { key: 'b', node: fromValue('new') });
  assert.deepEqual(toValue(root), { a: 1, list: ['x'] });
  assert.deepEqual(Object.keys(toValue(added)), ['a', 'list', 'b']);
  assert.throws(() => addChild(added, [], { key: 'a' }), (e) => e.code === 'duplicateKey');
  const renamed = renameKey(added, [], 'a', 'alpha');
  assert.deepEqual(Object.keys(toValue(renamed)), ['alpha', 'list', 'b']);
  assert.throws(() => renameKey(renamed, [], 'alpha', 'b'), (e) => e.code === 'duplicateKey');
  const moved = moveChild(renamed, [], 2, 0);
  assert.deepEqual(Object.keys(toValue(moved)), ['b', 'alpha', 'list']);
  const pushed = addChild(moved, ['list'], { node: fromValue('y'), index: 0 });
  assert.deepEqual(toValue(pushed).list, ['y', 'x']);
  const removed = removeAt(pushed, ['list', 1]);
  assert.deepEqual(toValue(removed).list, ['y']);
  const edited = setValue(removed, ['alpha'], '42.5');
  assert.equal(getAt(edited, ['alpha']).value, 42.5);
  assert.throws(() => setValue(edited, ['alpha'], 'abc'), (e) => e.code === 'notNumber');
  assert.throws(() => removeAt(edited, []), (e) => e.code === 'root');
});

test('type switching keeps sensible content', () => {
  assert.deepEqual(changeType({ type: 'string', value: '12' }, 'number'), { type: 'number', value: 12 });
  assert.deepEqual(changeType({ type: 'string', value: 'true' }, 'boolean'), { type: 'boolean', value: true });
  assert.deepEqual(changeType({ type: 'number', value: 3 }, 'string'), { type: 'string', value: '3' });
  assert.deepEqual(toValue(changeType(fromValue(['a', 'b']), 'object')), { 0: 'a', 1: 'b' });
  assert.deepEqual(toValue(changeType(fromValue({ k: 1 }), 'array')), [1]);
  assert.deepEqual(toValue(changeType(fromValue('x'), 'array')), ['x']);
  assert.deepEqual(changeType(fromValue({ k: 1 }), 'string'), { type: 'string', value: '{"k":1}' });
});

test('undo and redo walk the history', () => {
  const h = createHistory(1);
  h.push(2); h.push(3);
  assert.equal(h.undo(), 2);
  assert.equal(h.undo(), 1);
  assert.equal(h.canUndo, false);
  assert.equal(h.redo(), 2);
  h.push(9);
  assert.equal(h.canRedo, false);
  assert.equal(h.state, 9);
});

test('naming helpers', () => {
  assert.equal(pascal('first-name'), 'FirstName');
  assert.equal(camel('HTTPServer url'), 'httpServerUrl');
  assert.equal(snake('userID'), 'user_id');
  assert.equal(pascal('2fa'), 'N2fa');
  assert.equal(singular('categories'), 'category');
  assert.equal(singular('boxes'), 'box');
  assert.equal(singular('items'), 'item');
  assert.equal(singular('data'), 'dataItem');
});

const samples = [
  { id: 1, name: 'A', price: 1, tags: ['x'], owner: { login: 'a' }, items: [{ sku: 's', qty: 1 }, { sku: 't', qty: 2, note: null }], mixed: 1, 'first-name': 'z', type: 'k' },
  { id: 2, name: 'B', price: 2.5, tags: [], owner: null, items: [], mixed: 'one', type: 'j' },
];

test('inference merges samples: optional fields, unions, nullables, arrays of objects', () => {
  const model = buildModel(inferShape(samples), 'Root');
  const root = model.classes.find((c) => c.name === 'Root');
  const field = (n) => root.fields.find((f) => f.jsonName === n);
  assert.equal(field('id').type.kind, 'int');
  assert.equal(field('price').type.kind, 'float');
  assert.equal(field('first-name').optional, true);
  assert.equal(field('name').optional, false);
  assert.equal(field('owner').type.kind, 'class');
  assert.equal(field('owner').type.nullable, true);
  assert.equal(field('mixed').type.kind, 'union');
  assert.deepEqual(field('mixed').type.members.map((m) => m.kind), ['int', 'string']);
  assert.equal(field('items').type.kind, 'array');
  assert.equal(field('items').type.items.name, 'Item');
  const item = model.classes.find((c) => c.name === 'Item');
  assert.equal(item.fields.find((f) => f.jsonName === 'note').optional, true);
  assert.equal(item.fields.find((f) => f.jsonName === 'note').type.kind, 'null');
  // Dependencies come before the classes that use them.
  assert.ok(model.classes.findIndex((c) => c.name === 'Item') < model.classes.findIndex((c) => c.name === 'Root'));
});

test('identical nested shapes share one class; a nested field named like the root gets its own name', () => {
  const m = buildModel(inferShape([{ a: { x: 1 }, b: { x: 2 }, root: { y: 's' } }]), 'Root');
  assert.deepEqual(m.classes.map((c) => c.name).sort(), ['A', 'Root', 'Root2']);
  const root = m.classes.find((c) => c.name === 'Root');
  assert.equal(root.fields.find((f) => f.jsonName === 'b').type.name, 'A');
});

const model = () => buildModel(inferShape(samples), 'Root');

test('TypeScript emitter', () => {
  const ts = emitTypeScript(model());
  assert.match(ts, /export interface Root \{/);
  assert.match(ts, /  "first-name"\?: string;/);
  assert.match(ts, /  owner: Owner \| null;/);
  assert.match(ts, /  mixed: number \| string;/);
  assert.match(ts, /  items: Item\[\];/);
  assert.match(emitTypeScript(buildModel(inferShape([[1, 'a']]), 'Root')), /export type Root = Array<number \| string>;/);
});

test('JSON Schema 2020-12 emitter', () => {
  const schema = JSON.parse(emitJsonSchema(model()));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$ref, '#/$defs/Root');
  const root = schema.$defs.Root;
  assert.deepEqual(root.properties.id, { type: 'integer' });
  assert.deepEqual(root.properties.owner, { anyOf: [{ $ref: '#/$defs/Owner' }, { type: 'null' }] });
  assert.deepEqual(root.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.ok(!root.required.includes('first-name'));
  assert.ok(root.required.includes('id'));
});

test('Go emitter', () => {
  const go = emitGo(model());
  assert.match(go, /^package main/);
  assert.match(go, /type Root struct \{/);
  assert.match(go, /\tID\s+int64\s+`json:"id"`/);
  assert.match(go, /\tFirstName\s+\*string\s+`json:"first-name,omitempty"`/);
  assert.match(go, /\tOwner\s+\*Owner\s+`json:"owner"`/);
  assert.match(go, /\tMixed\s+interface\{\}/);
});

test('Python dataclass emitter', () => {
  const py = emitPython(model());
  assert.match(py, /from dataclasses import dataclass/);
  assert.match(py, /@dataclass\nclass Root:/);
  assert.match(py, /    first_name: Optional\[str\] = None  # JSON key: "first-name"/);
  assert.match(py, /    mixed: Union\[int, str\]/);
  assert.match(py, /    type_: str/);
  // Required fields come before defaulted ones.
  const body = py.slice(py.indexOf('class Root:'));
  assert.ok(body.indexOf('first_name') > body.indexOf('type_'));
});

test('C# record emitter', () => {
  const cs = emitCSharp(model());
  assert.match(cs, /using System\.Text\.Json\.Serialization;/);
  assert.match(cs, /public record Root\(/);
  assert.match(cs, /\[property: JsonPropertyName\("first-name"\)\] string\? FirstName/);
  assert.match(cs, /\[property: JsonPropertyName\("items"\)\] List<Item> Items/);
  assert.match(cs, /long Id/);
});

test('Rust serde emitter', () => {
  const rs = emitRust(model());
  assert.match(rs, /#\[derive\(Debug, Clone, PartialEq, Serialize, Deserialize\)\]\npub struct Root \{/);
  assert.match(rs, /#\[serde\(rename = "first-name", default, skip_serializing_if = "Option::is_none"\)\]\n    pub first_name: Option<String>,/);
  assert.match(rs, /    pub r#type: String,/);
  assert.match(rs, /    pub items: Vec<Item>,/);
  assert.match(rs, /    pub owner: Option<Owner>,/);
});

test('Kotlin data class emitter', () => {
  const kt = emitKotlin(model());
  assert.match(kt, /@Serializable\ndata class Root\(/);
  assert.match(kt, /@SerialName\("first-name"\) val firstName: String\? = null/);
  assert.match(kt, /@SerialName\("price"\) val price: Double/);
  assert.match(kt, /@SerialName\("mixed"\) val mixed: JsonElement\?/);
});

test('generateTypes covers every language', () => {
  for (const lang of LANGUAGES) {
    const out = generateTypes(samples, lang.id, { rootName: 'Order' });
    assert.ok(out.length > 20, lang.id);
    assert.match(out, /Order/, lang.id);
  }
  assert.throws(() => generateTypes([], 'typescript'));
});

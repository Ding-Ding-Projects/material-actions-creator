import { test } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  convert, parse, serialize, parseDelimited, stringifyDelimited, quoteField, valueToTable, flattenRecord, unflattenRecord,
  parseMarkdownTable, parseHtmlTable, detectFormat, encodeString, decodeBytes, convertEncoding, encodeBmp, hasTransparency, inferCell, ConvertError,
} from '../public/js/tools/convert.js';
import { parseYaml, stringifyYaml } from '../public/js/tools/yaml.js';

const records = [
  { name: 'Ada', role: 'engineer, lead', note: 'said "hi"' },
  { name: 'Grace', role: 'admiral', note: 'line one\nline two' },
  { name: ' padded ', role: '', note: 'tab\there' },
];

const tricky = {
  a: 1, b: 'two', c: [1, { d: 'x', e: [] }, [3, 4]], 'f g': { h: null, i: true, '': 'empty' },
  s: 'line1\nline2\n', t: 'a\nb', u: ' lead', w: 'a: b', x: '#c', y: '- z', z: '123', q: 'x\n\n\n',
  m: [{ a: 'm\nn', b: { c: 1 } }], nul: {}, emp: '', nested: [[[]]], uni: '粵語 ✓', key2: "it's", dq: 'say "hi"',
  ind: 'a\n  b\n\nc', boolish: 'yes', nullish: 'null', num: -0.5, big: 1e21, colon: 'http://x.y/z', dash: '-1x', star: '*x', amp: '&x',
  trailing: 'x ', cr: 'a\r\nb', ctrl: 'bell\u0007', '1': 'numeric key', 'key: colon': 1, '- dash key': 2,
};

test('JSON → YAML → JSON round-trips tricky values', () => {
  const yaml = convert(JSON.stringify(tricky), 'json', 'yaml').output;
  const back = JSON.parse(convert(yaml, 'yaml', 'json').output);
  assert.deepEqual(back, tricky);
});

test('our YAML output is read identically by a full YAML parser', () => {
  const yaml = stringifyYaml(tricky);
  assert.deepEqual(YAML.parse(yaml), tricky);
});

test('YAML parser reads block scalars, folded text, flow collections and comments', () => {
  const doc = [
    '# leading comment',
    '---',
    'key:',
    '- a',
    '- b  # trailing comment',
    'next: >',
    '  folded',
    '  text',
    '',
    '  para',
    'lit: |',
    '  x',
    '   y',
    'strip: |-',
    '  no newline',
    'keep: |+',
    '  kept',
    '',
    'flow: [1, "a", {b: c}, []]',
    "single: 'it''s # not a comment'",
    'double: "tab\\tnew\\nline \\u00e9"',
    'plain multi: first',
    '  second',
    'nums: [0x1f, 0o17, 1.5e3, -2, .inf]',
    'empty:',
    'tilde: ~',
    '...',
  ].join('\n');
  const v = parseYaml(doc);
  assert.deepEqual(v.key, ['a', 'b']);
  assert.equal(v.next, 'folded text\npara\n');
  assert.equal(v.lit, 'x\n y\n');
  assert.equal(v.strip, 'no newline');
  assert.equal(v.keep, 'kept\n\n');
  assert.deepEqual(v.flow, [1, 'a', { b: 'c' }, []]);
  assert.equal(v.single, "it's # not a comment");
  assert.equal(v.double, 'tab\tnew\nline é');
  assert.equal(v['plain multi'], 'first second');
  assert.deepEqual(v.nums, [31, 15, 1500, -2, Infinity]);
  assert.equal(v.empty, null);
  assert.equal(v.tilde, null);
  // Cross-check against a full YAML implementation for the parts in our subset.
  const full = YAML.parse(doc);
  for (const k of ['key', 'next', 'lit', 'strip', 'keep', 'flow', 'single', 'double', 'plain multi', 'empty', 'tilde']) assert.deepEqual(v[k], full[k], k);
});

test('YAML errors are clear and carry positions', () => {
  const cases = [
    ['a: &x 1', 'yaml.anchor', 1],
    ['a: 1\nb: *x', 'yaml.alias', 2],
    ['<<: {a: 1}', 'yaml.alias', 1],
    ['a: !!str 1', 'yaml.tag', 1],
    ['a: 1\na: 2', 'yaml.duplicateKey', 2],
    ['a: 1\n---\nb: 2', 'yaml.multiDoc', 2],
    ['a:\n\tb: 1', 'yaml.tab', 2],
    ['a: "open', 'yaml.unterminated', 1],
    ['a: 1\n  b: 2', 'yaml.indent', 2],
    ['? complex\n: value', 'yaml.complexKey', 1],
    ['a: [1, 2', 'yaml.flow', 1],
    ['a: 1\njust text', 'yaml.expectedKey', 2],
  ];
  for (const [doc, code, line] of cases) {
    assert.throws(() => parse(doc, 'yaml'), (e) => e instanceof ConvertError && e.code === code && e.line === line, `${code}: ${doc}`);
  }
  assert.throws(() => parse('a: &anchor 1', 'yaml'), /Anchors .* not supported/);
});

test('CSV quoting edge cases round-trip exactly', () => {
  const rows = [['name', 'role', 'note'], ...records.map((r) => [r.name, r.role, r.note])];
  const csv = stringifyDelimited(rows, ',');
  assert.match(csv, /"engineer, lead"/);
  assert.match(csv, /"said ""hi"""/);
  assert.match(csv, /"line one\nline two"/);
  assert.match(csv, /" padded "/);
  assert.deepEqual(parseDelimited(csv, ','), rows);
  assert.equal(quoteField('plain'), 'plain');
  assert.equal(quoteField('a,b'), '"a,b"');
  assert.equal(quoteField('a\tb', '\t'), '"a\tb"');
});

test('CSV parser handles CRLF, BOM, empty fields, blank lines and reports errors', () => {
  assert.deepEqual(parseDelimited('\uFEFFa,b\r\n1,\r\n\r\n,2\r\n'), [['a', 'b'], ['1', ''], ['', '2']]);
  assert.deepEqual(parseDelimited('a\n"x\r\ny"'), [['a'], ['x\r\ny']]);
  assert.throws(() => parseDelimited('a,b\n"open,1'), (e) => e.code === 'csvUnclosed');
  assert.throws(() => parseDelimited('a\n"x"y'), (e) => e.code === 'csvAfterQuote' && e.line === 2 && e.column === 4);
});

test('JSON ↔ CSV / TSV / Markdown / HTML / NDJSON round-trips flat records', () => {
  const json = JSON.stringify(records);
  for (const fmt of ['csv', 'tsv', 'html', 'ndjson', 'yaml']) {
    const out = convert(json, 'json', fmt);
    assert.equal(out.lossy, false, fmt);
    const back = JSON.parse(convert(out.output, fmt, 'json').output);
    assert.deepEqual(back, records, fmt);
  }
  // Markdown cannot keep spaces at the edges of a cell, and says so.
  const md = convert(json, 'json', 'markdown');
  assert.ok(md.notices.some((n) => n.code === 'edgeSpacesTrimmed' && n.lossy && n.vars.count === 1));
  const back = JSON.parse(convert(md.output, 'markdown', 'json').output);
  assert.deepEqual(back, records.map((r) => ({ ...r, name: r.name.trim() })));
});

test('tabular output escapes pipes and line breaks', () => {
  const md = convert(JSON.stringify([{ a: 'x|y', b: 'one\ntwo' }]), 'json', 'markdown');
  assert.match(md.output, /x\\\|y/);
  assert.match(md.output, /one<br>two/);
  assert.ok(md.notices.some((n) => n.code === 'lineBreaksAsBr'));
  assert.deepEqual(parseMarkdownTable(md.output), [['a', 'b'], ['x|y', 'one\ntwo']]);
  const html = convert(JSON.stringify([{ a: '<b>&</b>' }]), 'json', 'html');
  assert.match(html.output, /&lt;b&gt;&amp;&lt;\/b&gt;/);
  assert.deepEqual(parseHtmlTable(html.output).rows, [['a'], ['<b>&</b>']]);
});

test('nesting flattened into columns is flagged as lossy, with the paths', () => {
  const value = [{ id: 1, user: { name: 'a', tags: ['x', 'y'] } }, { id: 2, user: { name: 'b' }, extra: null }];
  const out = convert(JSON.stringify(value), 'json', 'csv');
  assert.equal(out.lossy, true);
  const flat = out.notices.find((n) => n.code === 'flattened');
  assert.ok(flat && flat.lossy);
  assert.match(flat.vars.list, /user/);
  assert.match(flat.vars.list, /user\.tags/);
  assert.ok(out.notices.some((n) => n.code === 'missingCells' && n.lossy));
  assert.ok(out.notices.some((n) => n.code === 'nullToEmpty' && n.lossy));
  assert.ok(out.notices.some((n) => n.code === 'typesToText'));
  assert.equal(out.output.split('\r\n')[0], 'id,user.name,user.tags.0,user.tags.1,extra');
  // Unflatten with type inference restores the structure.
  const back = parse(out.output, 'csv', { inferTypes: true, unflatten: true }).value;
  assert.deepEqual(back[0], { id: 1, user: { name: 'a', tags: ['x', 'y'] }, extra: '' });
});

test('flat data has no lossy notice; JSON → YAML is never lossy', () => {
  const out = convert(JSON.stringify([{ a: 'x', b: 'y' }]), 'json', 'csv');
  assert.equal(out.lossy, false);
  assert.equal(convert(JSON.stringify(tricky), 'json', 'yaml').lossy, false);
});

test('table helpers: header problems, primitives, arrays of arrays', () => {
  const r = parse('a,a,\n1,2,3,4', 'csv');
  assert.deepEqual(Object.keys(r.value[0]), ['a', 'a_2', 'column3', 'column4']);
  assert.ok(r.notices.some((n) => n.code === 'duplicateHeader'));
  assert.ok(r.notices.some((n) => n.code === 'raggedRows'));
  assert.ok(r.notices.some((n) => n.code === 'blankHeader'));
  assert.deepEqual(valueToTable([1, 'two']).columns, ['value']);
  assert.deepEqual(valueToTable([['h1', 'h2'], [1, 2]]), { columns: ['h1', 'h2'], rows: [['1', '2']], notices: [{ code: 'arrayRowsHeader', lossy: false, vars: {} }] });
  assert.deepEqual(flattenRecord({ a: { b: 1 } }).flat, { 'a.b': 1 });
  assert.deepEqual(unflattenRecord({ 'a.0': 1, 'a.1': 2, 'b.c': 3 }), { a: [1, 2], b: { c: 3 } });
  assert.equal(inferCell('007'), '007');
  assert.equal(inferCell('7'), 7);
  assert.equal(inferCell('1.50'), '1.50');
});

test('NDJSON parse errors give the line', () => {
  assert.deepEqual(parse('{"a":1}\n\n{"a":2}\n', 'ndjson').value, [{ a: 1 }, { a: 2 }]);
  assert.throws(() => parse('{"a":1}\n{"a":}\n', 'ndjson'), (e) => e.code === 'ndjson' && e.line === 2);
  const single = serialize({ a: 1 }, 'ndjson');
  assert.equal(single.text, '{"a":1}\n');
  assert.ok(single.notices.some((n) => n.code === 'singleLine'));
});

test('JSON errors carry line and column; duplicate keys are flagged', () => {
  assert.throws(() => parse('{\n  "a": 1,\n  "b": }', 'json'), (e) => e.code === 'json' && e.line === 3 && e.column === 8);
  const dup = parse('{"a":1,"a":2}', 'json');
  assert.deepEqual(dup.value, { a: 2 });
  assert.ok(dup.notices.some((n) => n.code === 'duplicateKey' && n.lossy));
});

test('prototype keys are kept as plain data', () => {
  const v = parse('__proto__: 1\nconstructor: 2', 'yaml').value;
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.deepEqual(Object.keys(v), ['__proto__', 'constructor']);
  const c = parse('__proto__\nx', 'csv').value;
  assert.equal(Object.keys(c[0])[0], '__proto__');
  assert.equal(Object.getPrototypeOf(c[0]), Object.prototype);
});

test('HTML table parsing with th header, entities, br and spans', () => {
  const t = parseHtmlTable('<p>x</p><table><tr><th>A</th><th>B &amp; C</th></tr><tr><td>1<br>2</td><td colspan="2"><b>bold</b></td></tr></table>');
  assert.deepEqual(t.rows, [['A', 'B & C'], ['1\n2', 'bold']]);
  assert.equal(t.headerFromTh, true);
  assert.equal(t.spans, 1);
  const p = parse('<table><tr><td>h</td></tr><tr><td>v</td></tr></table>', 'html');
  assert.ok(p.notices.some((n) => n.code === 'firstRowHeader'));
});

test('format detection', () => {
  assert.equal(detectFormat('', 'data.yml'), 'yaml');
  assert.equal(detectFormat('{"a":1}'), 'json');
  assert.equal(detectFormat('{"a":1}\n{"a":2}'), 'ndjson');
  assert.equal(detectFormat('a,b\n1,2'), 'csv');
  assert.equal(detectFormat('a\tb\n1\t2'), 'tsv');
  assert.equal(detectFormat('| a |\n|---|\n| 1 |'), 'markdown');
  assert.equal(detectFormat('<table></table>'), 'html');
  assert.equal(detectFormat('<root/>'), 'xml');
  assert.equal(detectFormat('a: 1'), 'yaml');
});

test('text encodings: UTF-8, UTF-16LE and Latin-1 with loss reporting', () => {
  const text = 'Café 粵 😀';
  const u16 = encodeString(text, 'utf-16le', { bom: true });
  assert.deepEqual([...u16.bytes.slice(0, 4)], [0xff, 0xfe, 0x43, 0x00]);
  assert.equal(decodeBytes(u16.bytes, 'utf-16le').text, text);
  const latin = convertEncoding(new TextEncoder().encode(text), 'utf-8', 'latin1');
  assert.equal(decodeBytes(latin.bytes, 'latin1').text, 'Café ? ?');
  const loss = latin.notices.find((n) => n.code === 'unrepresentable');
  assert.ok(loss && loss.lossy);
  assert.equal(loss.vars.count, 2);
  assert.equal(loss.vars.index, 5);
  const bad = decodeBytes(new Uint8Array([0x61, 0xff, 0x62]), 'utf-8');
  assert.equal(bad.replaced, 1);
  const back = convertEncoding(latin.bytes, 'latin1', 'utf-8', { bom: true });
  assert.deepEqual([...back.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(decodeBytes(back.bytes, 'utf-8').text, 'Café ? ?');
  assert.equal(decodeBytes(new Uint8Array([0xe9]), 'latin1').text, 'é');
});

test('BMP encoder writes a valid 24-bit header and composites alpha', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0]);
  assert.equal(hasTransparency(rgba), true);
  const bmp = encodeBmp(2, 1, rgba);
  const dv = new DataView(bmp.buffer);
  assert.equal(String.fromCharCode(bmp[0], bmp[1]), 'BM');
  assert.equal(dv.getUint32(2, true), bmp.length);
  assert.equal(dv.getInt32(18, true), 2);
  assert.equal(dv.getUint16(28, true), 24);
  assert.equal(bmp.length, 54 + 8);
  assert.deepEqual([...bmp.slice(54, 60)], [0, 0, 255, 255, 255, 255]);
});

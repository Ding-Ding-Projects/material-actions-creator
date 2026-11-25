import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeText, decodeText, bytesToBase64, base64ToBytes, validateBase64, createEncoder, decodeInChunks, concatBytes,
  toDataUri, parseDataUri, sniffMime, hexDump, textStats, wrapLines, decodedLength, formatBytes, firstInvalidUtf8, Base64Error,
} from '../public/js/tools/base64.js';

test('text round-trips through UTF-8 safe Base64', () => {
  for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', 'héllo wörld', '粵語 廣東話', 'emoji 😀🎉', '\u0000\n\t']) {
    assert.equal(decodeText(encodeText(s)), s);
  }
  assert.equal(encodeText('foobar'), 'Zm9vYmFy');
  assert.equal(encodeText('fooba'), 'Zm9vYmE=');
  assert.equal(encodeText('粵'), Buffer.from('粵').toString('base64'));
});

test('URL-safe alphabet and padding options', () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0xfe]);
  assert.equal(bytesToBase64(bytes), '+/+//g==');
  assert.equal(bytesToBase64(bytes, { urlSafe: true }), '-_-__g==');
  assert.equal(bytesToBase64(bytes, { urlSafe: true, pad: false }), '-_-__g');
  assert.deepEqual([...base64ToBytes('-_-__g')], [...bytes]);
  assert.deepEqual([...base64ToBytes('+/+//g==', { alphabet: 'standard' })], [...bytes]);
});

test('line wrapping at 64 and 76 characters', () => {
  const bytes = new Uint8Array(200).map((_, i) => i);
  const plain = bytesToBase64(bytes);
  for (const width of [64, 76]) {
    const wrapped = bytesToBase64(bytes, { wrap: width });
    const lines = wrapped.split('\n');
    assert.ok(lines.slice(0, -1).every((l) => l.length === width));
    assert.equal(lines.join(''), plain);
    assert.equal(wrapped, wrapLines(plain, width));
    assert.deepEqual([...base64ToBytes(wrapped)], [...bytes]);
  }
});

test('streaming encoder matches one-shot output across odd chunk sizes and wrapping', () => {
  const bytes = new Uint8Array(1000).map((_, i) => (i * 37) & 255);
  for (const wrap of [0, 64, 76]) {
    const enc = createEncoder({ wrap });
    let out = '';
    for (let i = 0; i < bytes.length; i += 7) out += enc.push(bytes.subarray(i, i + 7));
    out += enc.end();
    assert.equal(out, bytesToBase64(bytes, { wrap }));
  }
});

test('chunked decoding matches one-shot decoding', () => {
  const bytes = new Uint8Array(5000).map((_, i) => (i * 13) & 255);
  const v = validateBase64(bytesToBase64(bytes));
  assert.ok(v.ok);
  const parts = [...decodeInChunks(v.clean, 100)];
  assert.ok(parts.length > 1);
  assert.deepEqual(concatBytes(parts), bytes);
  assert.equal(decodedLength(v.clean.length), bytes.length);
});

test('validation reports the exact position of a bad character', () => {
  const r = validateBase64('Zm9v\nYm$y');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'badChar');
  assert.equal(r.error.index, 7);
  assert.equal(r.error.line, 2);
  assert.equal(r.error.column, 3);
  assert.equal(r.error.char, '$');
});

test('validation catches padding, length and alphabet problems', () => {
  assert.equal(validateBase64('Zm9v=YmFy').error.code, 'dataAfterPadding');
  assert.equal(validateBase64('Zm9vY===').error.code, 'tooMuchPadding');
  assert.equal(validateBase64('Zm9vY').error.code, 'badLength');
  assert.equal(validateBase64('Zm9=').ok, true);
  assert.equal(validateBase64('Zm=').error.code, 'badPadding');
  assert.equal(validateBase64('ab+c-d').error.code, 'mixedAlphabet');
  assert.equal(validateBase64('ab-d', { alphabet: 'standard' }).error.code, 'wrongAlphabet');
  assert.equal(validateBase64('ab+d', { alphabet: 'url' }).error.code, 'wrongAlphabet');
  assert.equal(validateBase64('Zm9vYg', { requirePadding: true }).error.code, 'missingPadding');
  assert.throws(() => base64ToBytes('a$'), Base64Error);
});

test('invalid UTF-8 after decoding is reported with a byte offset', () => {
  assert.throws(() => decodeText(bytesToBase64(new Uint8Array([0x41, 0xc3, 0x28]))), (e) => e.code === 'notUtf8' && e.index === 1);
  assert.equal(firstInvalidUtf8(new Uint8Array([0xe2, 0x82])), 0);
  assert.equal(firstInvalidUtf8(new TextEncoder().encode('ok ✓')), -1);
});

test('data URIs encode and decode, base64 and percent forms', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const uri = toDataUri(bytes, 'image/png');
  assert.ok(uri.startsWith('data:image/png;base64,'));
  const parsed = parseDataUri(uri);
  assert.equal(parsed.mime, 'image/png');
  assert.equal(parsed.base64, true);
  assert.deepEqual([...parsed.bytes], [...bytes]);
  const text = parseDataUri('data:text/plain;charset=utf-8,hello%20world');
  assert.equal(new TextDecoder().decode(text.bytes), 'hello world');
  assert.equal(text.params.charset, 'utf-8');
  assert.equal(parseDataUri('data:,x').mime, 'text/plain');
  assert.throws(() => parseDataUri('nope'), (e) => e.code === 'notDataUri');
  assert.throws(() => parseDataUri('data:image/png;base64,ab$c'), (e) => e.code === 'badChar' && e.index === 24);
});

test('MIME sniffing from magic bytes', () => {
  assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(new TextEncoder().encode('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
  assert.equal(sniffMime(new Uint8Array([1, 2, 3])), '');
});

test('hex dump, stats and size formatting', () => {
  const dump = hexDump(new TextEncoder().encode('Hello, world!\n\u0001'));
  assert.match(dump, /^00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 01 /);
  assert.match(dump, /\|Hello, world!\.\.\|$/);
  assert.deepEqual(textStats('a😀\nb'), { chars: 4, units: 5, bytes: 7, lines: 2 });
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.00 KiB');
});

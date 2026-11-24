import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { listEntries, extractEntry } from '../src/zip.js';
import { makeZip } from './helpers.js';

for (const method of [0, 8]) {
  test(`extracts ${method === 0 ? 'stored' : 'deflated'} entries byte-for-byte`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const payload = randomBytes(300_000);
    const zip = makeZip([{ name: 'notes.txt', data: Buffer.from('x') }, { name: 'image.tar.gz', data: payload }], { method });
    await writeFile(join(dir, 'a.zip'), zip);
    const entries = await listEntries(join(dir, 'a.zip'));
    assert.deepEqual(entries.map((e) => e.name), ['notes.txt', 'image.tar.gz']);
    await extractEntry(join(dir, 'a.zip'), 'image.tar.gz', join(dir, 'out'));
    assert.ok(payload.equals(await readFile(join(dir, 'out'))));
  });
}

test('handles empty entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-'));
  await writeFile(join(dir, 'e.zip'), makeZip([{ name: 'image.tar.gz', data: Buffer.alloc(0) }], { method: 0 }));
  await extractEntry(join(dir, 'e.zip'), 'image.tar.gz', join(dir, 'out'));
  assert.equal((await readFile(join(dir, 'out'))).length, 0);
});

test('rejects non-zip input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zip-'));
  await writeFile(join(dir, 'bad.zip'), 'definitely not a zip');
  await assert.rejects(listEntries(join(dir, 'bad.zip')), /Not a zip/);
});

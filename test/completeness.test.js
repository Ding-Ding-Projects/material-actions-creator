import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const inv = JSON.parse(readFileSync(join(ROOT, 'public/completeness.json'), 'utf8'));
const STATUSES = new Set(['done', 'partial', 'missing', 'na']);

test('inventory lists all 125 features once, with a valid status', () => {
  assert.equal(inv.features.length, 125);
  const ids = new Set(inv.features.map((f) => f.id));
  assert.equal(ids.size, 125, 'duplicate feature ids');
  for (const f of inv.features) {
    assert.ok(STATUSES.has(f.status), `${f.id}: bad status ${f.status}`);
    assert.ok(f.title && f.area && f.note, `${f.id}: title, area and note are required`);
  }
});

test('every done feature points at proof that exists', () => {
  for (const f of inv.features.filter((x) => x.status === 'done')) {
    assert.ok(f.proof, `${f.id} is done but has no proof`);
    assert.ok(existsSync(join(ROOT, f.proof)), `${f.id}: proof ${f.proof} is missing`);
  }
});

test('summary counts are reported honestly (not everything is done)', () => {
  const count = (s) => inv.features.filter((f) => f.status === s).length;
  const total = count('done') + count('partial') + count('missing') + count('na');
  assert.equal(total, 125);
  // Red/green signal: this inventory is not complete, and the page must say so.
  assert.ok(count('missing') + count('partial') > 0);
});

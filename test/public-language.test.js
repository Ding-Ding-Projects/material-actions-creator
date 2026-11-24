// Fails if private team shorthand appears anywhere in this public repository.
// Only salted hash prefixes of the terms are stored (test/fixtures/private-terms.json),
// so the list itself reveals nothing readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const { salt, hashes } = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/private-terms.json'), 'utf8'));
const banned = new Set(hashes);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data']);
const SKIP_FILES = new Set(['package-lock.json', 'test/fixtures/private-terms.json']);
const TEXT = /\.(js|mjs|cjs|json|md|html|css|yml|yaml|svg|txt|sh|bat|ps1)$|^(Dockerfile|\.dockerignore|\.gitignore)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* files(full);
    } else if (TEXT.test(name)) {
      yield full;
    }
  }
}

const h = (s) => createHash('sha256').update(salt + s).digest('hex').slice(0, 20);

export function findPrivateTerms(text) {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const found = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (banned.has(h(phrase))) found.push({ index: i, words: n });
    }
  }
  return found;
}

test('the hash list is loaded', () => {
  assert.ok(banned.size > 50);
});

test('no private shorthand in any public file', () => {
  const leaks = [];
  for (const file of files(ROOT)) {
    const rel = relative(ROOT, file);
    if (SKIP_FILES.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, n) => {
      // Report location only; never print the matched words.
      if (findPrivateTerms(line).length) leaks.push(`${rel}:${n + 1}`);
    });
  }
  assert.deepEqual(leaks, [], `Private shorthand found at:\n${leaks.join('\n')}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import nacl from 'tweetnacl';
import {
  keygen, encryptFile, decryptFile, seal, open, globToRegExp, findFiles, pack, safeRelPath, parseKey,
} from '../src/mac-crypt.mjs';
import { sealedBox, sealedBoxOpen } from '../src/sealedbox.js';
import { appJwt } from '../src/githubapp.js';
import { generateKeyPairSync, createVerify } from 'node:crypto';

const run = promisify(execFile);
const CLI = new URL('../src/mac-crypt.mjs', import.meta.url).pathname;
const tmp = () => mkdtemp(join(tmpdir(), 'crypt-'));

test('keys must be 32 bytes', () => {
  assert.equal(parseKey(keygen()).length, 32);
  assert.throws(() => parseKey('short'), /32 bytes/);
  assert.throws(() => parseKey(''), /32 bytes/);
});

for (const size of [0, 1, 1024 * 1024 - 1, 1024 * 1024, 3 * 1024 * 1024 + 17]) {
  test(`raw encrypt/decrypt round-trips ${size} bytes`, async () => {
    const d = await tmp();
    const data = randomBytes(size);
    await writeFile(join(d, 'in'), data);
    const key = keygen();
    await encryptFile(join(d, 'in'), join(d, 'enc'), key);
    const enc = await readFile(join(d, 'enc'));
    assert.ok(!enc.includes(data.subarray(0, 64)) || size === 0);
    await decryptFile(join(d, 'enc'), join(d, 'out'), key);
    assert.ok(data.equals(await readFile(join(d, 'out'))));
  });
}

test('tampering, truncation, appended data and wrong keys are rejected', async () => {
  const d = await tmp();
  await writeFile(join(d, 'in'), randomBytes(2 * 1024 * 1024 + 5));
  const key = keygen();
  await encryptFile(join(d, 'in'), join(d, 'enc'), key);
  const enc = await readFile(join(d, 'enc'));

  const flipped = Buffer.from(enc); flipped[100] ^= 1;
  await writeFile(join(d, 'flip'), flipped);
  await assert.rejects(decryptFile(join(d, 'flip'), join(d, 'o1'), key), /Decryption failed/);

  // Cutting at a chunk boundary must still be caught by the final-chunk flag.
  const firstChunkEnd = 16 + 4 + 1024 * 1024 + 16;
  await writeFile(join(d, 'cut'), enc.subarray(0, firstChunkEnd));
  await assert.rejects(decryptFile(join(d, 'cut'), join(d, 'o2'), key), /Truncated|Decryption failed/);
  await assert.rejects(stat(join(d, 'o2')), 'partial output is removed');

  await writeFile(join(d, 'extra'), Buffer.concat([enc, Buffer.from('junk')]));
  await assert.rejects(decryptFile(join(d, 'extra'), join(d, 'o3'), key));

  await assert.rejects(decryptFile(join(d, 'enc'), join(d, 'o4'), keygen()), /wrong key/);
});

test('globs follow the usual ** / * / ? rules', () => {
  assert.ok(globToRegExp('dist/**/*.exe').test('dist/a.exe'));
  assert.ok(globToRegExp('dist/**/*.exe').test('dist/x/y/a.exe'));
  assert.ok(!globToRegExp('dist/**/*.exe').test('dist/a.msi'));
  assert.ok(!globToRegExp('dist/*.exe').test('dist/x/a.exe'));
  assert.ok(globToRegExp('dist\\*.exe').test('dist/a.exe'));
  assert.ok(globToRegExp('**/*').test('a/b/c'));
  assert.ok(globToRegExp('v?.txt').test('v1.txt'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('seal and open round-trip a tree of build outputs', async () => {
  const d = await tmp();
  const src = join(d, 'src');
  await mkdir(join(src, 'dist', 'sub'), { recursive: true });
  const big = randomBytes(2_500_000);
  await writeFile(join(src, 'dist', 'Setup.exe'), big);
  await writeFile(join(src, 'dist', 'sub', 'App.msi'), 'msi');
  await writeFile(join(src, 'dist', 'empty.exe'), '');
  await writeFile(join(src, 'dist', 'notes.txt'), 'not an output');
  const key = keygen();
  const files = await seal(join(d, 'out.mac'), src, ['dist/**/*.exe', 'dist/**/*.msi'], key);
  assert.deepEqual(files, ['dist/Setup.exe', 'dist/empty.exe', 'dist/sub/App.msi']);
  const opened = await open(join(d, 'out.mac'), join(d, 'back'), key);
  assert.deepEqual(opened.map((f) => f.path).sort(), files);
  assert.ok(big.equals(await readFile(join(d, 'back', 'dist', 'Setup.exe'))));
  assert.equal(await readFile(join(d, 'back', 'dist', 'sub', 'App.msi'), 'utf8'), 'msi');
  await assert.rejects(seal(join(d, 'none.mac'), src, ['*.dmg'], key), /No files matched/);
});

test('bundles cannot write outside the destination', async () => {
  assert.throws(() => safeRelPath('../x'), /Unsafe/);
  assert.throws(() => safeRelPath('/etc/x'), /Unsafe/);
  assert.throws(() => safeRelPath('C:/x'), /Unsafe/);
  assert.throws(() => safeRelPath('a\\..\\..\\x'), /Unsafe/);
  // Hand-craft a bundle with a traversal path and make sure open refuses it.
  const d = await tmp();
  const name = Buffer.from('../escape.txt');
  const head = Buffer.alloc(2 + name.length + 8);
  head.writeUInt16BE(name.length, 0); name.copy(head, 2); head.writeBigUInt64BE(1n, 2 + name.length);
  await writeFile(join(d, 'evil.pkg'), Buffer.concat([Buffer.from('MACPKG1\n'), head, Buffer.from('x'), Buffer.alloc(2)]));
  const key = keygen();
  await encryptFile(join(d, 'evil.pkg'), join(d, 'evil.mac'), key);
  await assert.rejects(open(join(d, 'evil.mac'), join(d, 'dest'), key), /Unsafe/);
  await assert.rejects(stat(join(d, 'escape.txt')));
});

test('pack writes a readable bundle', async () => {
  const d = await tmp();
  await writeFile(join(d, 'a.txt'), 'A');
  await pack(join(d, 'p.pkg'), d, ['a.txt']);
  const buf = await readFile(join(d, 'p.pkg'));
  assert.equal(buf.subarray(0, 8).toString(), 'MACPKG1\n');
});

test('CLI seal/open/keygen work end to end', async () => {
  const d = await tmp();
  await mkdir(join(d, 'src', 'dist'), { recursive: true });
  await writeFile(join(d, 'src', 'dist', 'a.exe'), 'A');
  await writeFile(join(d, 'src', 'dist', 'b.msi'), 'B');
  const { stdout: key } = await run(process.execPath, [CLI, 'keygen']);
  const env = { ...process.env, MAC_KEY: key.trim() };
  const sealed = await run(process.execPath, [CLI, 'seal', join(d, 'out.mac'), join(d, 'src'), 'dist/**/*.exe, dist/**/*.msi'], { env });
  assert.match(sealed.stdout, /Sealed 2 file/);
  await run(process.execPath, [CLI, 'open', join(d, 'out.mac'), join(d, 'back')], { env });
  assert.deepEqual((await readdir(join(d, 'back', 'dist'))).sort(), ['a.exe', 'b.msi']);
  await assert.rejects(run(process.execPath, [CLI, 'open', join(d, 'out.mac'), join(d, 'x')], { env: { ...process.env, MAC_KEY: keygen() } }));
  await assert.rejects(run(process.execPath, [CLI, 'bogus']), /usage/);
});

test('sealed boxes match libsodium crypto_box_seal', () => {
  const kp = nacl.box.keyPair();
  const sealed = sealedBox('hello-secret', Buffer.from(kp.publicKey).toString('base64'));
  assert.equal(Buffer.from(sealed, 'base64').length, 32 + 'hello-secret'.length + 16);
  assert.equal(sealedBoxOpen(sealed, kp.publicKey, kp.secretKey).toString(), 'hello-secret');
  assert.equal(sealedBoxOpen(sealed, kp.publicKey, nacl.box.keyPair().secretKey), null);
});

test('GitHub App JWTs are RS256-signed with the app id', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = appJwt(12345, pem, 1_700_000_000);
  const [h, p, s] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(payload, { iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '12345' });
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
});

test('findFiles skips .git', async () => {
  const d = await tmp();
  await mkdir(join(d, '.git'), { recursive: true });
  await writeFile(join(d, '.git', 'x.exe'), '');
  await writeFile(join(d, 'y.exe'), '');
  assert.deepEqual(await findFiles(d, ['**/*.exe']), ['y.exe']);
});

#!/usr/bin/env node
// mac-crypt: the encryption skill shared by the server and every build workflow.
// Self-contained (Node built-ins only) so it can be copied into a temporary
// repository or used through the composite action on Linux and Windows runners.
//
//   node mac-crypt.mjs seal <out.mac> <baseDir> <glob> [glob...]   pack files + encrypt
//   node mac-crypt.mjs open <in.mac> <destDir>                     decrypt + unpack
//   node mac-crypt.mjs encrypt <in> <out> | decrypt <in> <out>     raw single file
//   node mac-crypt.mjs keygen                                      print a fresh base64 key
//
// The key comes from the MAC_KEY environment variable (32 bytes, base64).
//
// Container format: "MACENC1\n" | 8-byte nonce prefix | chunks.
// Chunk: u32 plaintext length | AES-256-GCM ciphertext | 16-byte tag.
// Nonce = prefix | u32 counter. AAD = header | counter | final flag, so chunks
// cannot be reordered, dropped or truncated without failing authentication.
//
// Bundle format (plaintext inside a container): "MACPKG1\n", then entries of
// u16 path length | utf-8 path (forward slashes) | u64 size | bytes,
// terminated by a zero path length.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';

const ENC_MAGIC = Buffer.from('MACENC1\n');
const PKG_MAGIC = Buffer.from('MACPKG1\n');
const CHUNK = 1024 * 1024;

export function keygen() {
  return randomBytes(32).toString('base64');
}

export function parseKey(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key || '').trim(), 'base64');
  if (buf.length !== 32) throw new Error('MAC_KEY must be 32 bytes, base64 encoded.');
  return buf;
}

// Reads a stream into exactly-sized chunks (the last one may be short).
async function* fixedChunks(stream, size) {
  let pending = [];
  let have = 0;
  for await (const piece of stream) {
    let buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    while (buf.length) {
      const take = Math.min(size - have, buf.length);
      pending.push(buf.subarray(0, take));
      have += take;
      buf = buf.subarray(take);
      if (have === size) {
        yield Buffer.concat(pending, size);
        pending = [];
        have = 0;
      }
    }
  }
  yield Buffer.concat(pending, have);
}

function nonceFor(prefix, counter) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 8);
  return n;
}

function aadFor(header, counter, final) {
  const a = Buffer.alloc(header.length + 5);
  header.copy(a, 0);
  a.writeUInt32BE(counter, header.length);
  a[header.length + 4] = final ? 1 : 0;
  return a;
}

async function write(out, buf) {
  if (out.writeAsync) return out.writeAsync(buf);
  if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
}

// Encrypts any readable stream into a writable stream.
export async function encryptStream(input, out, key) {
  const k = parseKey(key);
  const prefix = randomBytes(8);
  const header = Buffer.concat([ENC_MAGIC, prefix]);
  await write(out, header);
  let counter = 0;
  let prev = null;
  const emit = async (plain, final) => {
    const c = createCipheriv('aes-256-gcm', k, nonceFor(prefix, counter));
    c.setAAD(aadFor(header, counter, final));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(plain.length);
    await write(out, Buffer.concat([len, c.update(plain), c.final(), c.getAuthTag()]));
    counter++;
    if (counter > 0xfffffff0) throw new Error('Input too large.');
  };
  for await (const chunk of fixedChunks(input, CHUNK)) {
    if (prev) await emit(prev, false);
    prev = chunk;
  }
  await emit(prev || Buffer.alloc(0), true);
}

// Decrypts a container stream, writing plaintext to `out`.
export async function decryptStream(input, out, key) {
  const k = parseKey(key);
  let buf = Buffer.alloc(0);
  let header = null;
  let counter = 0;
  let done = false;
  const tryChunks = async () => {
    while (true) {
      if (!header) {
        if (buf.length < 16) return;
        header = buf.subarray(0, 16);
        if (!header.subarray(0, 8).equals(ENC_MAGIC)) throw new Error('Not a mac-crypt file.');
        header = Buffer.from(header);
        buf = buf.subarray(16);
      }
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > CHUNK) throw new Error('Corrupt chunk length.');
      if (buf.length < 4 + len + 16) return;
      const body = buf.subarray(4, 4 + len);
      const tag = buf.subarray(4 + len, 4 + len + 16);
      buf = buf.subarray(4 + len + 16);
      // A chunk is final only if it authenticates as final.
      const prefix = header.subarray(8, 16);
      let plain = null;
      let final = false;
      for (const flag of [buf.length === 0, buf.length !== 0]) {
        try {
          const d = createDecipheriv('aes-256-gcm', k, nonceFor(prefix, counter));
          d.setAAD(aadFor(header, counter, flag));
          d.setAuthTag(tag);
          plain = Buffer.concat([d.update(body), d.final()]);
          final = flag;
          break;
        } catch { /* try the other flag */ }
      }
      if (!plain) throw new Error('Decryption failed: wrong key or corrupted data.');
      if (done) throw new Error('Data after final chunk.');
      counter++;
      if (plain.length) await write(out, plain);
      if (final) done = true;
    }
  };
  for await (const piece of input) {
    buf = Buffer.concat([buf, piece]);
    await tryChunks();
  }
  await tryChunks();
  if (!done || buf.length) throw new Error('Truncated mac-crypt file.');
}

export async function encryptFile(inPath, outPath, key) {
  const out = createWriteStream(outPath);
  await encryptStream(createReadStream(inPath), out, key);
  out.end();
  await finished(out);
}

export async function decryptFile(inPath, outPath, key) {
  const out = createWriteStream(outPath);
  try {
    await decryptStream(createReadStream(inPath), out, key);
  } catch (err) {
    out.on('error', () => {});
    out.destroy();
    await fsp.rm(outPath, { force: true });
    throw err;
  }
  out.end();
  await finished(out);
}

// ---------- globbing ----------

export function globToRegExp(glob) {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export function splitGlobs(text) {
  return String(text || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

async function walk(dir, base, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.git') continue;
      await walk(full, base, out);
    } else if (e.isFile()) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

export async function findFiles(baseDir, globs) {
  const res = globs.map(globToRegExp);
  const all = await walk(baseDir, baseDir, []);
  return all.filter((p) => res.some((r) => r.test(p))).sort();
}

// ---------- bundles ----------

export function safeRelPath(p) {
  const clean = String(p).replace(/\\/g, '/');
  const parts = clean.split('/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || parts.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Unsafe path in bundle: ${p}`);
  }
  return clean;
}

// Yields the bundle bytes for the given files (relative to baseDir).
export async function* bundleStream(baseDir, files) {
  yield PKG_MAGIC;
  for (const rel of files) {
    const name = Buffer.from(safeRelPath(rel));
    const { size } = await fsp.stat(join(baseDir, rel));
    const head = Buffer.alloc(2 + name.length + 8);
    head.writeUInt16BE(name.length, 0);
    name.copy(head, 2);
    head.writeBigUInt64BE(BigInt(size), 2 + name.length);
    yield head;
    let sent = 0;
    for await (const piece of createReadStream(join(baseDir, rel))) {
      sent += piece.length;
      yield piece;
    }
    if (sent !== size) throw new Error(`${rel} changed while packing.`);
  }
  yield Buffer.alloc(2);
}

// A writable sink that unpacks bundle bytes into destDir.
export function unbundleSink(destDir) {
  const root = resolve(destDir);
  let buf = Buffer.alloc(0);
  let magicOk = false;
  let cur = null; // { out, left, path }
  let ended = false;
  const files = [];
  const sink = {
    async write(piece) {
      buf = buf.length ? Buffer.concat([buf, piece]) : piece;
      while (buf.length) {
        if (!magicOk) {
          if (buf.length < 8) return true;
          if (!buf.subarray(0, 8).equals(PKG_MAGIC)) throw new Error('Not a mac-crypt bundle.');
          magicOk = true;
          buf = buf.subarray(8);
          continue;
        }
        if (cur) {
          const take = Math.min(cur.left, buf.length);
          if (take) await write(cur.out, buf.subarray(0, take));
          cur.left -= take;
          buf = buf.subarray(take);
          if (cur.left === 0) {
            cur.out.end();
            await finished(cur.out);
            files.push({ path: cur.path, size: cur.size });
            cur = null;
          }
          continue;
        }
        if (ended) throw new Error('Data after bundle end.');
        if (buf.length < 2) return true;
        const n = buf.readUInt16BE(0);
        if (n === 0) { ended = true; buf = buf.subarray(2); continue; }
        if (buf.length < 2 + n + 8) return true;
        const rel = safeRelPath(buf.subarray(2, 2 + n).toString('utf8'));
        const size = Number(buf.readBigUInt64BE(2 + n));
        buf = buf.subarray(2 + n + 8);
        const target = resolve(root, rel);
        if (!target.startsWith(root + sep)) throw new Error(`Unsafe path in bundle: ${rel}`);
        await fsp.mkdir(dirname(target), { recursive: true });
        cur = { out: createWriteStream(target), left: size, path: rel, size };
        if (size === 0) { cur.out.end(); await finished(cur.out); files.push({ path: rel, size: 0 }); cur = null; }
      }
      return true;
    },
    async close() {
      if (!magicOk || cur || !ended) throw new Error('Truncated bundle.');
      return files;
    },
    abort() {
      if (cur) { cur.out.on('error', () => {}); cur.out.destroy(); cur = null; }
    },
  };
  return sink;
}

// Adapts the sink to the writer interface decryptStream uses (with backpressure).
function sinkWritable(sink) {
  return { writeAsync: (b) => sink.write(Buffer.from(b)) };
}

export async function seal(outPath, baseDir, globs, key) {
  const files = await findFiles(baseDir, globs);
  if (!files.length) throw new Error(`No files matched: ${globs.join(', ')}`);
  const out = createWriteStream(outPath);
  await encryptStream(bundleStream(baseDir, files), out, key);
  out.end();
  await finished(out);
  return files;
}

export async function open(inPath, destDir, key) {
  await fsp.mkdir(destDir, { recursive: true });
  const sink = unbundleSink(destDir);
  const w = sinkWritable(sink);
  try {
    await decryptStream(createReadStream(inPath), w, key);
    return await sink.close();
  } catch (err) {
    sink.abort();
    throw err;
  }
}

// Packs files without encryption (used by tests and private mode).
export async function pack(outPath, baseDir, files) {
  const out = createWriteStream(outPath);
  for await (const piece of bundleStream(baseDir, files)) await write(out, piece);
  out.end();
  await finished(out);
}

// ---------- CLI ----------

async function cli(argv) {
  const [cmd, ...args] = argv;
  const key = () => process.env.MAC_KEY;
  switch (cmd) {
    case 'keygen':
      console.log(keygen());
      return;
    case 'seal': {
      const [out, base, ...globs] = args;
      if (!out || !base || !globs.length) throw new Error('usage: seal <out.mac> <baseDir> <glob...>');
      const files = await seal(out, base, globs.flatMap(splitGlobs), key());
      console.log(`Sealed ${files.length} file(s) into ${out}`);
      for (const f of files) console.log(`  ${f}`);
      return;
    }
    case 'open': {
      const [inPath, dest] = args;
      if (!inPath || !dest) throw new Error('usage: open <in.mac> <destDir>');
      const files = await open(inPath, dest, key());
      console.log(`Opened ${files.length} file(s) into ${dest}`);
      return;
    }
    case 'encrypt':
      await encryptFile(args[0], args[1], key());
      return;
    case 'decrypt':
      await decryptFile(args[0], args[1], key());
      return;
    default:
      throw new Error('usage: mac-crypt <seal|open|encrypt|decrypt|keygen> ...');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(`mac-crypt: ${err.message}`);
    process.exit(1);
  });
}

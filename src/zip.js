// Streaming single-entry extractor for the artifact zip GitHub returns.
// Supports stored (0) and deflate (8) entries and Zip64 sizes/offsets.
import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

export async function listEntries(zipPath) {
  const fh = await open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end of central directory).');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === EOCD64_LOC_SIG) {
      const eocd64Off = Number(tail.readBigUInt64LE(loc + 8));
      const e64 = await readAt(fh, eocd64Off, 56);
      count = Number(e64.readBigUInt64LE(32));
      cdSize = Number(e64.readBigUInt64LE(40));
      cdOffset = Number(e64.readBigUInt64LE(48));
    }
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) throw new Error('Corrupt central directory.');
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); }
        }
        x += 4 + len;
      }
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      p = xEnd + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

export async function extractEntry(zipPath, entryName, destPath, { maxBytes = Infinity } = {}) {
  const entries = await listEntries(zipPath);
  const entry = entries.find((e) => e.name === entryName) || entries.find((e) => !e.name.endsWith('/'));
  if (!entry) throw new Error(`Zip has no entry ${entryName}.`);
  if (![0, 8].includes(entry.method)) throw new Error(`Unsupported zip compression method ${entry.method}.`);
  const fh = await open(zipPath, 'r');
  let dataStart;
  try {
    const hdr = await readAt(fh, entry.localOffset, 30);
    if (hdr.readUInt32LE(0) !== LOC_SIG) throw new Error('Corrupt local file header.');
    dataStart = entry.localOffset + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  const out = createWriteStream(destPath);
  if (entry.compressedSize === 0) {
    await new Promise((resolve, reject) => out.end(resolve).on('error', reject));
    return { name: entry.name, size: 0 };
  }
  const src = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  // Counts what is actually written, so a file that unpacks to more than its
  // header claims cannot fill the disk.
  let written = 0;
  const cap = new Transform({ transform(chunk, _enc, cb) { written += chunk.length; cb(written > maxBytes ? new Error('The file unpacks to more than the allowed size.') : null, chunk); } });
  if (entry.method === 8) await pipeline(src, createInflateRaw(), cap, out);
  else await pipeline(src, cap, out);
  return { name: entry.name, size: entry.uncompressedSize };
}

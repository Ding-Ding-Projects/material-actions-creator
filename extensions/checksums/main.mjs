// Reads one request line, hashes each output file, replies with one line.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { payload } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const sha256 = (path) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

const items = [];
for (const o of payload.outputs || []) {
  try { items.push({ label: o.name, value: await sha256(o.path) }); } catch (err) { items.push({ label: o.name, value: `unreadable: ${err.code || err.message}` }); }
}
const n = items.length;
console.log(JSON.stringify({ ok: true, result: {
  title: n ? `SHA-256 for ${n} output${n === 1 ? '' : 's'}` : 'No outputs to hash',
  summary: items.map((i) => `${i.value}  ${i.label}`).join('\n'),
  items,
} }));

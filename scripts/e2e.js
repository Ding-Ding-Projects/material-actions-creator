// Live end-to-end check against a running server that has a real GitHub token.
// Usage: BASE_URL=http://localhost:8080 node scripts/e2e.js
import { writeFile } from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://localhost:8080';
const out = process.env.OUT_FILE || 'e2e-image.tar.gz';
const headers = { 'content-type': 'application/json', ...(process.env.APP_ACCESS_KEY ? { 'x-access-key': process.env.APP_ACCESS_KEY } : {}) };
const tag = `mac-e2e:${Date.now()}`;

const auth = await (await fetch(`${base}/api/auth`, { headers })).json();
if (!auth.signedIn) throw new Error(`Server is not signed in: ${auth.error || 'no token'}`);
if (auth.missing.length) throw new Error(`Token is missing scopes: ${auth.missing.join(', ')}`);
console.log(`Signed in as ${auth.login}`);

const res = await fetch(`${base}/api/builds`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    imageName: tag,
    dockerfile: 'FROM alpine:3.20\nARG GREETING\nCOPY hello.txt /hello.txt\nRUN echo "$GREETING" >> /hello.txt\nCMD ["cat", "/hello.txt"]\n',
    files: [{ path: 'hello.txt', content: 'hello from material-actions-creator\n' }],
    buildArgs: { GREETING: 'e2e ok' },
  }),
});
if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
let job = await res.json();
console.log(`Build ${job.id} → ${job.repo}`);

const deadline = Date.now() + 30 * 60 * 1000;
let last = '';
while (job.status === 'running') {
  if (Date.now() > deadline) throw new Error('Timed out waiting for build');
  await new Promise((r) => setTimeout(r, 5000));
  job = await (await fetch(`${base}/api/builds/${job.id}`, { headers })).json();
  const line = job.stages.map((s) => `${s.id}:${s.state}`).join(' ');
  if (line !== last) console.log(line);
  last = line;
}
if (job.status !== 'ready') throw new Error(`Build failed: ${job.error}`);
const cleanup = job.stages.find((s) => s.id === 'cleanup');
if (cleanup.state !== 'done') throw new Error(`Cleanup did not finish: ${cleanup.detail}`);

const dl = await fetch(`${base}${job.downloadUrl}`, { headers });
if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
await writeFile(out, Buffer.from(await dl.arrayBuffer()));
console.log(`Saved ${out} (${job.size} bytes), image tag ${tag}`);
await writeFile(process.env.GITHUB_OUTPUT || '/dev/null', `tag=${tag}\nrepo=${job.owner}/${job.repo}\n`, { flag: 'a' });

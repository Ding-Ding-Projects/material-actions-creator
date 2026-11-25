#!/usr/bin/env node
// Proves local runs for real: builds a small project on this computer through
// the app's own API, with the real runner program (downloaded and hash-checked
// on first use). No GitHub sign-in and no repository are involved.
//
//   node scripts/local-check.mjs            containers when Docker answers, else directly on the host
//   MAC_LOCAL_CONTAINERS=off node scripts/local-check.mjs    force "directly on this computer"
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

const tmp = await mkdtemp(join(tmpdir(), 'mac-local-check-'));
const project = join(tmp, 'project');
await mkdir(join(project, '.github', 'workflows'), { recursive: true });
await writeFile(join(project, 'build.sh'), '#!/bin/sh\nset -e\nmkdir -p dist\nprintf "built by %s" "$1" > dist/hello.txt\n');
await writeFile(join(project, '.github', 'workflows', 'ci.yml'), `name: Local check
on:
  push:
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: sh ./build.sh workflow
      - uses: actions/upload-artifact@v4
        with:
          name: hello
          path: dist/hello.txt
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/hello.txt
  windows-only:
    runs-on: windows-latest
    steps:
      - run: echo never here
`);

let failed = 0;
const line = (good, name, detail = '') => { console.log(`  ${good ? 'ok   ' : 'FAIL '} ${name.padEnd(30)} ${detail}`); if (!good) failed++; };
const env = { ...process.env, DATA_DIR: join(tmp, 'data'), SWEEP_ON_START: 'false', JOURNAL: 'false', GITHUB_TOKEN: '', GH_TOKEN: '', APP_ACCESS_KEY: '' };
const { server, jobs } = createApp({ env, recipeClock: false });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const waitFor = async (id, minutes) => {
  const end = Date.now() + minutes * 60_000;
  let job;
  let last = '';
  while (Date.now() < end) {
    job = await get(`/api/builds/${id}`);
    const now = job.stages.find((s) => s.state === 'active');
    const text = now ? `${now.label}${now.detail ? ` — ${now.detail}` : ''}` : '';
    if (text && text !== last) { console.log(`        … ${text}`); last = text; }
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return job;
};

try {
  const caps = await get('/api/local');
  console.log(`\n  host ${caps.host} ${caps.arch} · containers: ${caps.containers ? `${caps.containers.engine} ${caps.containers.version}` : 'none'} · Linux jobs: ${caps.canRun.linux || 'no'}\n`);

  const scripted = await waitFor((await post('/api/builds', { kind: 'scripts', mode: 'local', localPath: project, scripts: ['build.sh'], outputs: 'dist/**' })).id, 2);
  line(scripted.status === 'ready', 'Script build on the host', scripted.error || `${scripted.outputs.length} output`);

  if (!caps.canRun.linux) line(true, 'Workflow run', 'skipped: this computer cannot run Linux jobs');
  else {
    const scan = await get(`/api/local/scan?path=${encodeURIComponent(project)}`);
    line(scan.workflows[0]?.warnings.some((w) => /Windows jobs need a Windows computer/.test(w)), 'Plan names the skipped job', scan.workflows[0]?.warnings.join(' | '));
    const job = await waitFor((await post('/api/builds', { kind: 'scripts', mode: 'local', localPath: project, workflows: ['.github/workflows/ci.yml'] })).id, 12);
    line(job.status === 'ready', 'Workflow run through act', job.error || job.stages.find((s) => s.id === 'runner').detail);
    const after = await get('/api/local');
    line(after.act.installed, 'Runner program installed', `${after.act.source} · act ${after.act.version}`);
    const out = job.outputs?.find((o) => o.name === 'hello/hello.txt');
    line(Boolean(out), 'Artifact came back', (job.outputs || []).map((o) => o.name).join(', '));
    if (out) line((await (await fetch(base + out.url)).text()) === 'built by workflow', 'Artifact content is right');
    line(job.steps?.some((s) => s.name === 'Build' && s.conclusion === 'success'), 'Step timings captured', `${job.steps?.length || 0} steps`);
    line(job.warnings?.some((w) => /Not run here — Local check \/ windows-only/.test(w)), 'Skipped job is listed');
    line(job.warnings?.some((w) => /Publishing step removed/.test(w)), 'Publishing step removed');
    const log = job.logUrl ? await (await fetch(base + job.logUrl)).text() : '';
    line(/=== Local check ===/.test(log) && log.length > 200, 'Log saved', `${log.length} characters`);
    if (job.status !== 'ready') console.log(log.split('\n').slice(-40).join('\n'));
  }
} catch (err) {
  line(false, 'Local check', err.stack || err.message);
} finally {
  await jobs.stop();
  server.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? `\n  ${failed} check(s) failed.` : '\n  Local check passed.');
process.exit(failed ? 1 : 0);

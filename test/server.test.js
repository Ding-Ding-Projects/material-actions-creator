import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { GitHubClient } from '../src/github.js';
import { fakeGitHub } from './helpers.js';

class FakeGhAuth extends EventEmitter {
  constructor() { super(); this.flow = { state: 'idle' }; this.loggedIn = false; }
  async available() { return 'gh version fake'; }
  async token() { return this.loggedIn ? 'gho_x' : null; }
  status() { return { ...this.flow }; }
  start(mode) { this.flow = { state: 'waiting', mode, code: 'AAAA-BBBB', url: 'https://github.com/login/device' }; return this.status(); }
  cancel() { this.flow = { state: 'cancelled' }; return this.status(); }
  async logout() { this.loggedIn = false; }
}

let base;
let app;
let ghAuth;

before(async () => {
  const gh = fakeGitHub();
  ghAuth = new FakeGhAuth();
  const dataDir = await mkdtemp(join(tmpdir(), 'srv-'));
  app = createApp({
    env: { GITHUB_OWNER: 'Ding-Ding-Projects', DATA_DIR: dataDir, POLL_INTERVAL_MS: '1', APP_ACCESS_KEY: 'sesame' },
    ghAuth,
    githubApp: null,
    makeClient: (token) => new GitHubClient({ token, fetchImpl: gh.fetchImpl, sleepImpl: async () => {} }),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

const call = (path, opts = {}) => fetch(base + path, {
  ...opts,
  headers: { 'content-type': 'application/json', 'x-access-key': 'sesame', ...(opts.headers || {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
});

test('serves the UI and health without a key', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Material Actions Creator/);
  assert.equal((await fetch(base + '/app.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('blocks traversal outside public/', async () => {
  const res = await fetch(base + '/..%2fpackage.json');
  assert.doesNotMatch(await res.text(), /"name": "material-actions-creator"/);
});

test('requires the access key for the API', async () => {
  const res = await fetch(base + '/api/config');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).accessKeyRequired, true);
  assert.equal((await call('/api/config')).status, 200);
});

test('signed-out state, assisted login, then a full build and download', async () => {
  let auth = await (await call('/api/auth')).json();
  assert.equal(auth.signedIn, false);
  assert.deepEqual(auth.required, ['repo', 'workflow', 'delete_repo']);

  const blocked = await call('/api/builds', { method: 'POST', body: { dockerfile: 'FROM alpine\n' } });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /Not signed in/);

  const flow = await (await call('/api/auth/login', { method: 'POST', body: { mode: 'login' } })).json();
  assert.equal(flow.code, 'AAAA-BBBB');
  ghAuth.loggedIn = true;
  auth = await (await call('/api/auth')).json();
  assert.equal(auth.signedIn, true);
  assert.equal(auth.login, 'swiftie');
  assert.deepEqual(auth.missing, []);

  const bad = await call('/api/builds', { method: 'POST', body: { dockerfile: 'nope' } });
  assert.equal(bad.status, 400);

  const res = await call('/api/builds', { method: 'POST', body: { dockerfile: 'FROM alpine\n', imageName: 'demo:2' } });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  await app.jobs.jobs.get(id).promise;
  const job = await (await call(`/api/builds/${id}`)).json();
  assert.equal(job.status, 'ready', job.error);

  assert.equal((await fetch(`${base}/api/builds/${id}/download`)).status, 401);
  const dl = await fetch(`${base}/api/builds/${id}/download?key=sesame`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /image\.tar\.gz/);
  assert.equal(await dl.text(), 'IMAGE:FROM alpine\n');
  assert.equal((await fetch(`${base}/api/builds/${id}/files/9?key=sesame`)).status, 404);

  assert.equal((await call(`/api/builds/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/builds/${id}`)).status, 404);
});

test('scans a repository for build scripts and previews workflows', async () => {
  ghAuth.loggedIn = true;
  const scan = await (await call('/api/scripts?repo=Ding-Ding-Projects/map-editor')).json();
  assert.equal(scan.ref, 'main');
  assert.deepEqual(scan.scripts, ['build/installer.bat', 'tools/clean.cmd']);
  assert.equal(scan.outputsGuess, 'dist/**/*.exe, dist/**/*.msi');
  assert.equal((await call('/api/scripts?repo=bad')).status, 400);

  const preview = await (await call('/api/preview', { method: 'POST', body: { kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', scripts: ['build/installer.bat'], outputs: 'dist/*.exe', mode: 'encrypted-public' } })).json();
  assert.match(preview.yaml, /crypt\.mjs seal out\.mac/);
  assert.equal((await call('/api/preview', { method: 'POST', body: { kind: 'scripts' } })).status, 400);
});

test('encrypted script build through the API lists decrypted outputs', async () => {
  ghAuth.loggedIn = true;
  const res = await call('/api/builds', { method: 'POST', body: { kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', ref: 'main', scripts: ['build/installer.bat'], outputs: 'dist/**/*.exe', mode: 'encrypted-public' } });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  await app.jobs.jobs.get(id).promise;
  const job = await (await call(`/api/builds/${id}`)).json();
  assert.equal(job.status, 'ready', job.error);
  assert.equal(job.outputs.length, 2);
  const msi = job.outputs.find((o) => o.name.endsWith('.msi'));
  const dl = await fetch(`${base}${msi.url}?key=sesame`);
  assert.equal(await dl.text(), 'MSI');
  assert.match(dl.headers.get('content-disposition'), /filename="Setup-1\.0\.msi"/);
  const cfg = await (await call('/api/config')).json();
  assert.ok(cfg.runners.includes('windows-latest'));
  assert.deepEqual(cfg.modes, ['private', 'encrypted-public']);
  assert.equal((await (await call('/api/recovery')).json()), null);
});

test('streams build updates over server-sent events', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?key=sesame`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: hello/);
  ctrl.abort();
});

test('extensions API: list, lint a workflow, consent gate, and the finished-build hook', async () => {
  assert.equal((await fetch(base + '/api/extensions')).status, 401);
  const list = await (await call('/api/extensions')).json();
  assert.deepEqual(list.extensions.map((e) => e.id).sort(), ['build-summary', 'checksums', 'workflow-lint']);
  assert.ok(list.extensions.every((e) => e.enabled && e.source === 'builtin'));
  assert.equal(list.protocol, 1);
  assert.ok(['bwrap', 'none'].includes(list.isolation.mode));
  assert.ok(list.gallery.some((g) => g.id === 'hello-shell'));

  const lint = await (await call('/api/extensions/workflow-lint/run', { method: 'POST', body: { hook: 'workflow.lint', yaml: 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n' } })).json();
  assert.equal(lint.ok, true);
  assert.equal(lint.result.findings.length, 2);

  // The build that finished earlier in this file was handed to the built-in extensions.
  const deadline = Date.now() + 5000;
  let sums;
  while (Date.now() < deadline) {
    sums = (await (await call('/api/extensions')).json()).extensions.find((e) => e.id === 'checksums').lastRun;
    if (sums) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(sums.ok, true);
  assert.equal(sums.hook, 'build.finished');
  assert.ok(sums.result.items.length >= 1); // hashing itself is covered in extensions.test.js

  const off = await (await call('/api/extensions/checksums', { method: 'POST', body: { enabled: false } })).json();
  assert.equal(off.enabled, false);
  assert.equal((await call('/api/extensions/checksums/run', { method: 'POST', body: { hook: 'build.finished' } })).status, 409);
  assert.equal((await call('/api/extensions/checksums', { method: 'POST', body: { grant: ['build:read'] } })).status, 409);
  assert.equal((await call('/api/extensions/nope', { method: 'POST', body: { enabled: true } })).status, 404);
  assert.equal((await (await call('/api/extensions/checksums', { method: 'POST', body: { enabled: true } })).json()).enabled, true);
});

test('recipes API: save, list, run starts a build, delete', async () => {
  assert.equal((await fetch(base + '/api/recipes')).status, 401);
  const saved = await (await call('/api/recipes', { method: 'POST', body: { name: 'Installer', request: { kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', scripts: ['build\\installer.bat'], outputs: 'dist/**/*.msi' }, schedule: { type: 'interval', hours: 12 } } })).json();
  assert.ok(saved.id && saved.nextAt > Date.now());
  assert.equal((await call('/api/recipes', { method: 'POST', body: { name: 'Installer', request: { kind: 'scripts', repo: 'a/b', scripts: ['x.sh'], outputs: 'x' } } })).status, 409);
  assert.equal((await call('/api/recipes', { method: 'POST', body: { name: 'Bad', request: { kind: 'scripts', repo: 'nope' } } })).status, 400);
  const ran = await call(`/api/recipes/${saved.id}/run`, { method: 'POST' });
  assert.equal(ran.status, 202);
  const { build, recipe } = await ran.json();
  assert.equal(build.status, 'running');
  assert.equal(recipe.lastRun.buildId, build.id);
  const put = await (await call(`/api/recipes/${saved.id}`, { method: 'PUT', body: { name: 'Installer nightly', schedule: { type: 'daily', time: '02:00' } } })).json();
  assert.deepEqual(put.schedule, { type: 'daily', time: '02:00' });
  const list = await (await call('/api/recipes')).json();
  assert.deepEqual(list.recipes.map((r) => r.name), ['Installer nightly']);
  assert.deepEqual((await (await call(`/api/recipes/${saved.id}`, { method: 'DELETE' })).json()).recipes, []);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { GitHubClient } from '../src/github.js';
import { fakeGitHub, makeZip } from './helpers.js';

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
const image = Buffer.from('IMAGE-BYTES');

before(async () => {
  const gh = fakeGitHub({ artifactZip: makeZip([{ name: 'image.tar.gz', data: image }]) });
  ghAuth = new FakeGhAuth();
  const dataDir = await mkdtemp(join(tmpdir(), 'srv-'));
  app = createApp({
    env: { GITHUB_OWNER: 'Ding-Ding-Projects', DATA_DIR: dataDir, POLL_INTERVAL_MS: '1', APP_ACCESS_KEY: 'sesame' },
    ghAuth,
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
  assert.match(dl.headers.get('content-disposition'), /demo_2\.tar\.gz/);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(image));

  assert.equal((await call(`/api/builds/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/builds/${id}`)).status, 404);
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

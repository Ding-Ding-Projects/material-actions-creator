import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { GitHubClient } from '../src/github.js';
import { main } from '../src/cli.js';
import { fakeGitHub, SOURCE_TARBALL_BYTES } from './helpers.js';

class FakeGhAuth extends EventEmitter {
  constructor() { super(); this.flow = { state: 'idle' }; this.loggedIn = false; this.starts = []; }
  async available() { return 'gh version fake'; }
  async token() { return this.loggedIn ? 'gho_x' : null; }
  status() { return { ...this.flow }; }
  start(mode) {
    this.starts.push(mode);
    this.flow = { state: 'waiting', mode, code: 'CLI1-2345', url: 'https://github.com/login/device' };
    setTimeout(() => { this.loggedIn = true; this.flow = { state: 'done', mode }; }, 50);
    return this.status();
  }
  cancel() { this.flow = { state: 'cancelled' }; return this.status(); }
  async logout() { this.loggedIn = false; }
}

let app; let server; let ghAuth; let out;

async function run(...argv) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const code = await main([...argv, '--server', server]);
    return { code, text: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

before(async () => {
  const gh = fakeGitHub();
  ghAuth = new FakeGhAuth();
  const dataDir = await mkdtemp(join(tmpdir(), 'cli-'));
  out = await mkdtemp(join(tmpdir(), 'cli-out-'));
  app = createApp({
    env: { GITHUB_OWNER: 'Ding-Ding-Projects', DATA_DIR: dataDir, POLL_INTERVAL_MS: '1' },
    ghAuth, githubApp: null, journal: false,
    makeClient: (token) => new GitHubClient({ token, fetchImpl: gh.fetchImpl, sleepImpl: async () => {} }),
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  server = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.server.closeAllConnections?.(); });

test('help and version', async () => {
  const h = await run('--help');
  assert.match(h.text, /mac login/);
  assert.match(h.text, /--all-workflows/);
});

test('whoami before and after assisted login', async () => {
  const before = await run('whoami');
  assert.equal(before.code, 1);
  assert.match(before.text, /Not signed in/);
  const login = await run('login');
  assert.equal(login.code, 0);
  assert.match(login.text, /CLI1-2345/);
  assert.match(login.text, /github\.com\/login\/device/);
  assert.match(login.text, /Signed in as swiftie/);
  assert.deepEqual(ghAuth.starts, ['login']);
  const after = await run('whoami', '--json');
  assert.equal(JSON.parse(after.text).login, 'swiftie');
});

test('scan lists scripts and workflows with warnings', async () => {
  const r = await run('scan', 'Ding-Ding-Projects/map-editor', '--encrypted');
  assert.equal(r.code, 0);
  assert.match(r.text, /build\/installer\.bat/);
  assert.match(r.text, /\.github\/workflows\/release\.yml/);
  assert.match(r.text, /removed publishing step/);
  assert.match(r.text, /callable only/);
});

test('preview prints the generated workflow', async () => {
  const r = await run('preview', 'Ding-Ding-Projects/map-editor', '--script', 'build/installer.bat', '--outputs', 'dist/*.exe', '--encrypted');
  assert.match(r.text, /crypt\.mjs seal out\.mac src/);
});

test('build with all scripts and all workflows, encrypted, saves decrypted outputs', async () => {
  const r = await run('build', 'Ding-Ding-Projects/map-editor', '--all-scripts', '--all-workflows', '--encrypted', '--out', out);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Download and decrypt outputs/);
  assert.match(r.text, /Release/);
  const exe = await readFile(join(out, 'Release', 'installers', 'dist', 'App-from-workflow.exe'), 'utf8');
  assert.equal(exe, `release.yml built from ${SOURCE_TARBALL_BYTES}`);
  const runs = await run('runs');
  assert.match(runs.text, /ready/);
});

test('detach, watch and download', async () => {
  const d = await run('build', 'Ding-Ding-Projects/map-editor', '--script', 'build/installer.bat', '--outputs', 'dist/**/*.exe', '--detach', '--json');
  const { id } = JSON.parse(d.text);
  const w = await run('watch', id, '--out', join(out, 'w'));
  assert.equal(w.code, 0);
  const dl = await run('download', id, '--out', join(out, 'dl'), '--json');
  const saved = JSON.parse(dl.text);
  assert.ok(saved.length >= 1);
  const rm = await run('rm', id);
  assert.match(rm.text, /Removed/);
});

test('docker command reads the Dockerfile and extra files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-docker-'));
  await writeFile(join(dir, 'Dockerfile'), 'FROM alpine\nCOPY a.txt /\n');
  await writeFile(join(dir, 'a.txt'), 'hi');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const r = await run('docker', '--file', 'a.txt', '--image', 'cli-test:1', '--build-arg', 'A=1', '--encrypted', '--out', join(out, 'img'));
    assert.equal(r.code, 0, r.text);
    assert.equal(await readFile(join(out, 'img', 'image.tar.gz'), 'utf8'), 'IMAGE:FROM alpine\nCOPY a.txt /\n');
    await assert.rejects(run('docker', '--build-arg', 'oops'), /KEY=VALUE/);
  } finally {
    process.chdir(cwd);
  }
});

test('errors are readable', async () => {
  await assert.rejects(run('build'), /Which repository/);
  await assert.rejects(run('nope'), /Unknown command/);
  await assert.rejects(main(['runs', '--server', 'http://127.0.0.1:9']), /Cannot reach/);
});

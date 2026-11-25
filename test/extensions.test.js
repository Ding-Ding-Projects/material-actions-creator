import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ExtensionHost, validateManifest, cleanResult, ManifestError } from '../src/extensions.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const base = { manifestVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0', run: { command: 'node', args: ['main.mjs'] }, hooks: ['command'], permissions: [] };

async function makeExt(dir, manifest, code) {
  await mkdir(join(dir, manifest.id), { recursive: true });
  await writeFile(join(dir, manifest.id, 'manifest.json'), JSON.stringify(manifest));
  if (code) await writeFile(join(dir, manifest.id, 'main.mjs'), code);
}
const READ = "const c=[];for await(const x of process.stdin)c.push(x);const req=JSON.parse(Buffer.concat(c).toString());";

async function host(setup) {
  const root = await mkdtemp(join(tmpdir(), 'ext-'));
  const user = join(root, 'user');
  const builtin = join(root, 'builtin');
  await mkdir(user); await mkdir(builtin);
  await setup({ user, builtin });
  const h = new ExtensionHost({ dirs: [{ path: builtin, source: 'builtin' }, { path: user, source: 'user' }], dataDir: join(root, 'data'), env: { PATH: process.env.PATH, GITHUB_TOKEN: 'ghp_should_never_be_seen', GH_TOKEN: 'also_secret' } });
  await h.load();
  return { h, root, user, builtin };
}

test('manifest validation names the problem', () => {
  assert.equal(validateManifest(base, 'demo').id, 'demo');
  const bad = (patch, re) => assert.throws(() => validateManifest({ ...base, ...patch }, 'demo'), (e) => e instanceof ManifestError && re.test(e.message));
  bad({ manifestVersion: 2 }, /manifestVersion/);
  bad({ id: 'Bad_ID' }, /id must/);
  bad({ id: 'other' }, /folder name/);
  bad({ version: '1.0' }, /version/);
  bad({ run: { command: '/bin/sh' } }, /run\.command/);
  bad({ run: { command: './../../evil' } }, /run\.command/);
  bad({ run: { command: 'sh', args: [1] } }, /run\.args/);
  bad({ hooks: ['on.everything'] }, /hooks/);
  bad({ permissions: ['token:read'] }, /permissions/);
  bad({ limits: { timeoutMs: 600000 } }, /timeoutMs/);
  bad({ limits: { maxOutputBytes: 0 } }, /maxOutputBytes/);
  assert.equal(validateManifest({ ...base, run: { command: './bin/tool' } }, 'demo').run.command, './bin/tool');
});

test('built-in extensions start on, user extensions start off and need consent', async () => {
  const { h } = await host(async ({ user, builtin }) => {
    await makeExt(builtin, { ...base, id: 'shipped', permissions: ['build:read'] }, `${READ}console.log(JSON.stringify({ok:true,result:{title:'hi'}}))`);
    await makeExt(user, { ...base, id: 'mine', permissions: ['build:read'] }, `${READ}console.log(JSON.stringify({ok:true,result:{title:'hi'}}))`);
  });
  assert.equal(h.view('shipped').enabled, true);
  const mine = h.view('mine');
  assert.equal(mine.enabled, false);
  assert.deepEqual(mine.pendingPermissions, ['build:read']);
  await assert.rejects(h.configure('mine', { enabled: true }), /permissions allowed/);
  await assert.rejects(h.run('mine', 'command'), /waiting for its permissions/);
  await assert.rejects(h.configure('mine', { grant: ['build:read', 'outputs:read'] }), /permission list changed/);
  const on = await h.configure('mine', { grant: ['build:read'], enabled: true });
  assert.equal(on.enabled, true);
  assert.equal((await h.run('mine', 'command')).ok, true);
});

test('a user extension with no permissions still needs a first yes', async () => {
  const { h } = await host(async ({ user }) => makeExt(user, base, `${READ}console.log(JSON.stringify({ok:true,result:{}}))`));
  assert.equal(h.view('demo').needsConsent, true);
  await assert.rejects(h.configure('demo', { enabled: true }), /permissions allowed/);
  assert.equal((await h.configure('demo', { grant: [], enabled: true })).enabled, true);
});

test('a new permission in a newer version switches the extension off until allowed', async () => {
  const { h, user } = await host(async ({ user }) => makeExt(user, { ...base, permissions: ['build:read'] }, `${READ}console.log(JSON.stringify({ok:true,result:{items:[{label:'keys',value:Object.keys(req.payload).join(',')}]}}))`));
  await h.configure('demo', { grant: ['build:read'], enabled: true });
  await makeExt(user, { ...base, version: '1.1.0', permissions: ['build:read', 'outputs:read'] });
  await h.scan();
  const v = h.view('demo');
  assert.equal(v.enabled, false);
  assert.equal(v.wantsEnabled, true);
  assert.deepEqual(v.pendingPermissions, ['outputs:read']);
  assert.equal(v.grantedVersion, '1.0.0');
  await h.configure('demo', { grant: ['build:read', 'outputs:read'] });
  assert.equal(h.view('demo').enabled, true);
  // Dropping a permission needs no new consent.
  await makeExt(user, { ...base, version: '1.2.0', permissions: [] });
  await h.scan();
  assert.equal(h.view('demo').enabled, true);
});

test('payload only carries what was granted, and the environment has no sign-in values', async () => {
  const code = `${READ}console.log(JSON.stringify({ok:true,result:{summary:JSON.stringify({keys:Object.keys(req.payload).sort(),env:Object.keys(process.env).sort(),home:process.env.HOME,proto:req.protocol})}}))`;
  const { h, root } = await host(async ({ user }) => {
    await makeExt(user, { ...base, id: 'narrow', hooks: ['build.finished'], permissions: ['build:read'] }, code);
    await makeExt(user, { ...base, id: 'wide', hooks: ['build.finished'], permissions: ['build:read', 'outputs:read'] }, code);
  });
  await h.configure('narrow', { grant: ['build:read'], enabled: true });
  await h.configure('wide', { grant: ['build:read', 'outputs:read'], enabled: true });
  const ctx = { build: { id: 'abc', title: 'T', status: 'ready', stages: [], outputs: [{}], repo: 'mac-tmp-abc', owner: 'someone' }, outputs: [{ name: 'a.exe', size: 1, path: '/x/a.exe' }], yaml: 'on: push' };
  const results = await h.dispatch('build.finished', ctx);
  assert.equal(results.length, 2);
  const narrow = JSON.parse(results.find((r) => r.id === 'narrow').result.summary);
  const wide = JSON.parse(results.find((r) => r.id === 'wide').result.summary);
  assert.deepEqual(narrow.keys, ['build']);
  assert.deepEqual(wide.keys, ['build', 'outputs']);
  assert.equal(narrow.proto, 1);
  assert.ok(!narrow.env.some((k) => /TOKEN|KEY|SECRET/i.test(k)), `no sign-in values: ${narrow.env}`);
  assert.equal(narrow.home, join(root, 'data', 'extension-data', 'narrow'));
  const p = h.payloadFor('build.finished', ['build:read'], ctx);
  assert.equal(p.build.repo, undefined, 'temporary repository name is not shared');
  assert.equal(p.build.owner, undefined);
});

test('time limit, size limit, bad replies and missing programs fail cleanly', async () => {
  const { h } = await host(async ({ user }) => {
    await makeExt(user, { ...base, id: 'slow', limits: { timeoutMs: 300 } }, 'setTimeout(()=>{},60000)');
    await makeExt(user, { ...base, id: 'loud', limits: { maxOutputBytes: 1000 } }, "process.stdout.write('x'.repeat(50000));setTimeout(()=>{},60000)");
    await makeExt(user, { ...base, id: 'garbled' }, "console.log('not json')");
    await makeExt(user, { ...base, id: 'refuses' }, "console.log(JSON.stringify({ok:false,error:'nope'}))");
    await makeExt(user, { ...base, id: 'crashes' }, "console.error('boom');process.exit(3)");
    await makeExt(user, { ...base, id: 'ghost', run: { command: 'definitely-not-a-real-program-xyz' } });
  });
  for (const id of ['slow', 'loud', 'garbled', 'refuses', 'crashes', 'ghost']) await h.configure(id, { grant: [], enabled: true });
  const t0 = Date.now();
  assert.match((await h.run('slow', 'command')).error, /time limit/);
  assert.ok(Date.now() - t0 < 5000);
  assert.match((await h.run('loud', 'command')).error, /size limit/);
  assert.match((await h.run('garbled', 'command')).error, /one line of JSON/);
  assert.equal((await h.run('refuses', 'command')).error, 'nope');
  assert.match((await h.run('crashes', 'command')).error, /code 3.*boom/);
  assert.match((await h.run('ghost', 'command')).error, /Program not found/);
  assert.equal(h.view('slow').lastRun.ok, false);
});

test('broken manifests are listed, not loaded; state survives a restart', async () => {
  const { h, root, user, builtin } = await host(async ({ user }) => {
    await makeExt(user, base, `${READ}console.log(JSON.stringify({ok:true,result:{}}))`);
    await mkdir(join(user, 'broken'));
    await writeFile(join(user, 'broken', 'manifest.json'), '{nope');
    await mkdir(join(user, 'not-an-extension'));
  });
  assert.deepEqual(h.list().extensions.map((e) => e.id), ['demo']);
  assert.equal(h.list().broken.length, 1);
  assert.match(h.list().broken[0].error, /not valid JSON/);
  await h.configure('demo', { grant: [], enabled: true });
  const again = await new ExtensionHost({ dirs: [{ path: builtin, source: 'builtin' }, { path: user, source: 'user' }], dataDir: join(root, 'data') }).load();
  assert.equal(again.view('demo').enabled, true);
});

test('results are trimmed to plain, bounded data', () => {
  const r = cleanResult({ title: 'x'.repeat(999), html: '<script>', items: [{ label: 1, value: {} }, null], findings: [{ level: 'fatal', message: 'm', line: 2.5 }] });
  assert.equal(r.title.length, 200);
  assert.equal(r.html, undefined);
  assert.deepEqual(r.items, [{ label: '1', value: '[object Object]' }]);
  assert.deepEqual(r.findings, [{ level: 'info', message: 'm' }]);
});

test('shipped extensions and author samples have valid manifests and really run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ext-real-'));
  const user = join(root, 'user');
  await cp(join(ROOT, 'extension-samples'), user, { recursive: true });
  const h = await new ExtensionHost({ dirs: [{ path: join(ROOT, 'extensions'), source: 'builtin' }, { path: user, source: 'user' }], dataDir: join(root, 'data') }).load();
  assert.deepEqual(h.list().broken, []);
  assert.deepEqual(h.list().extensions.map((e) => e.id).sort(), ['build-summary', 'checksums', 'hello-shell', 'word-count-python', 'workflow-lint']);

  const file = join(root, 'out.bin');
  await writeFile(file, 'abc');
  const build = { id: 'b1', title: 'demo build', mode: 'encrypted-public', platform: 'ubuntu-latest', status: 'ready', createdAt: 0, updatedAt: 75_000, stages: [{ id: 'build', label: 'Build', state: 'done' }], outputs: [{}] };
  const results = await h.dispatch('build.finished', { build, outputs: [{ name: 'out.bin', size: 3, path: file }] });
  const sums = results.find((r) => r.id === 'checksums');
  assert.equal(sums.result.items[0].value, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(results.find((r) => r.id === 'build-summary').result.summary, /Took: 1 min 15 s/);

  const lint = await h.run('workflow-lint', 'workflow.lint', { yaml: 'jobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n' });
  assert.equal(lint.result.findings.length, 2);
  const pinned = await h.run('workflow-lint', 'workflow.lint', { yaml: `jobs:\n  a:\n    timeout-minutes: 5\n    steps:\n      - uses: a/b@${'0'.repeat(40)}\n` });
  assert.equal(pinned.result.title, 'No problems found');

  if (process.platform !== 'win32') {
    await h.configure('hello-shell', { grant: [], enabled: true });
    assert.match((await h.run('hello-shell', 'command', { input: '' })).result.summary, /Extension id: hello-shell/);
  }
  if (spawnSync('python3', ['--version']).status === 0) {
    await h.configure('word-count-python', { grant: [], enabled: true });
    assert.equal((await h.run('word-count-python', 'command', { input: 'one two\nthree' })).result.title, '3 words');
  } else t.diagnostic('python3 not installed: Python sample not run');
  assert.ok((await readFile(join(root, 'data', 'extensions.json'), 'utf8')).includes('lastRun'));
});

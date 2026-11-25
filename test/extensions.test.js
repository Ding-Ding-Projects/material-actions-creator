import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ExtensionHost, validateManifest, cleanResult, ManifestError, bwrapArgs, toolDirs } from '../src/extensions.js';
import { makeZip } from './helpers.js';

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

test('runs of one extension queue up instead of overlapping', async () => {
  const { h } = await host(async ({ user }) => makeExt(user, base, `${READ}setTimeout(()=>console.log(JSON.stringify({ok:true,result:{title:req.payload.input}})),120)`));
  await h.configure('demo', { grant: [], enabled: true });
  const t0 = Date.now();
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((input) => h.run('demo', 'command', { input })));
  assert.deepEqual([a.result.title, b.result.title, c.result.title], ['a', 'b', 'c']);
  assert.ok(Date.now() - t0 >= 340, 'ran one after another');
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
  assert.deepEqual(h.list().extensions.map((e) => e.id).sort(), ['build-summary', 'checksums', 'hello-shell', 'release-notes', 'size-budget', 'word-count-python', 'workflow-lint']);

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

test('gallery: add a bundled sample, upload a zip, reject unsafe zips, remove', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-gal-'));
  const user = join(root, 'data', 'extensions');
  const h = await new ExtensionHost({ dirs: [{ path: join(ROOT, 'extensions'), source: 'builtin' }, { path: user, source: 'user' }], dataDir: join(root, 'data'), samplesDir: join(ROOT, 'extension-samples') }).load();
  const gallery = await h.gallery();
  assert.deepEqual(gallery.map((g) => g.id), ['hello-shell', 'release-notes', 'size-budget', 'word-count-python']);
  assert.ok(gallery.every((g) => g.installed === false));
  const added = await h.installSample('size-budget');
  assert.equal(added.source, 'user');
  assert.equal(added.enabled, false, 'added extensions start off');
  assert.equal((await h.gallery()).find((g) => g.id === 'size-budget').installed, true);
  await assert.rejects(h.installSample('../extensions/checksums'), /Unknown sample/);
  await assert.rejects(h.installSample('nope'), /Unknown sample/);

  const manifest = { ...base, id: 'zipped', name: 'Zipped' };
  const zip = async (entries) => { const p = join(root, `u-${Math.random()}.zip`); await writeFile(p, makeZip(entries)); return p; };
  const code = Buffer.from(`${READ}console.log(JSON.stringify({ok:true,result:{title:'from zip'}}))`);
  const flat = await h.installZip(await zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'main.mjs', data: code }]));
  assert.equal(flat.id, 'zipped');
  await h.configure('zipped', { grant: [], enabled: true });
  assert.equal((await h.run('zipped', 'command')).result.title, 'from zip');
  // A zip with one top folder works too, and replaces the earlier copy without losing consent.
  await h.installZip(await zip([{ name: 'zipped-1.0/manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, version: '1.0.1' })) }, { name: 'zipped-1.0/main.mjs', data: code }]));
  assert.equal(h.view('zipped').version, '1.0.1');
  assert.equal(h.view('zipped').enabled, true);

  await assert.rejects(async () => h.installZip(await zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: '../escape.txt', data: Buffer.from('x') }])), /Unsafe path/);
  await assert.rejects(async () => h.installZip(await zip([{ name: 'readme.txt', data: Buffer.from('x') }])), /no valid manifest/);
  await assert.rejects(async () => h.installZip(await zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, id: 'checksums' })) }])), /built-in/);
  await assert.rejects(async () => h.installZip(await zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, permissions: ['everything'] })) }])), /permissions may only contain/);
  const notZip = join(root, 'not.zip'); await writeFile(notZip, 'hello');
  await assert.rejects(h.installZip(notZip), /not a zip|empty/);

  await h.uninstall('zipped');
  assert.equal(h.view('zipped'), null);
  await assert.rejects(h.uninstall('checksums'), /cannot be removed/);
});

test('sandbox arguments hide home and app data, and only open what was granted', () => {
  const a = bwrapArgs({ dir: '/opt/app/extensions/x', home: '/data/extension-data/x', hide: ['/home/me/.nvm/versions/node/v22/secret', '/home/me', '/home/me', '/data', '/', undefined], outputs: ['/data/b1/files/out.bin'], tools: ['/home/me/.nvm/versions/node/v22'], command: 'node', args: ['main.mjs'] });
  const s = a.join(' ');
  assert.ok(a.includes('--unshare-all') && !a.includes('--share-net'), 'no network by default');
  assert.match(s, /--tmpfs \/data --tmpfs \/home\/me /, 'parents are hidden before what is inside them');
  assert.match(s, /v22 --tmpfs \/home\/me\/\.nvm\/versions\/node\/v22\/secret --ro-bind \/opt/, 'hidden folders inside a tool folder stay hidden');
  assert.ok(!/--tmpfs \/ /.test(s), 'never hides the root');
  assert.match(s, /--ro-bind \/home\/me\/\.nvm\/versions\/node\/v22 \/home\/me\/\.nvm\/versions\/node\/v22/);
  assert.ok(s.indexOf('--tmpfs /data') < s.indexOf('--bind /data/extension-data/x'), 'own folder is put back after hiding app data');
  assert.match(s, /--ro-bind \/data\/b1\/files\/out\.bin \/data\/b1\/files\/out\.bin/);
  assert.deepEqual(a.slice(-3), ['--', 'node', 'main.mjs']);
  assert.ok(bwrapArgs({ dir: '/x', home: '/y', network: true, command: 'sh' }).includes('--share-net'));
});

test('tool folders: only existing PATH folders under a hidden folder are put back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ext-tools-'));
  await mkdir(join(root, 'home', 'node', 'bin'), { recursive: true });
  await mkdir(join(root, 'home', 'node', 'lib', 'node_modules'), { recursive: true });
  await mkdir(join(root, 'home', 'plain', 'bin'), { recursive: true });
  const dirs = toolDirs([join(root, 'home', 'node', 'bin'), join(root, 'home', 'plain', 'bin'), join(root, 'home', 'missing', 'bin'), '/usr/bin', join(root, 'home')], [join(root, 'home')]);
  assert.deepEqual(dirs, [join(root, 'home', 'node'), join(root, 'home', 'plain', 'bin')]);
});

test('isolation setting: off never sandboxes, require refuses to run without one', async () => {
  const mk = async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'ext-iso-'));
    await makeExt(join(root, 'user'), base, `${READ}console.log(JSON.stringify({ok:true,result:{}}))`);
    const h = await new ExtensionHost({ dirs: [{ path: join(root, 'user'), source: 'user' }], dataDir: join(root, 'data'), env: { PATH: process.env.PATH, MAC_EXTENSION_ISOLATION: mode } }).load();
    await h.configure('demo', { grant: [], enabled: true });
    return h;
  };
  const off = await mk('off');
  assert.deepEqual(off.detectIsolation(), { mode: 'none', reason: 'off', required: false });
  assert.equal((await off.run('demo', 'command')).sandboxed, false);
  const req = await mk('require');
  const iso = req.detectIsolation();
  const run = await req.run('demo', 'command');
  if (iso.mode === 'bwrap') { assert.equal(run.ok, true); assert.equal(run.sandboxed, true); } else assert.match(run.error, /only in a sandbox/);
});

test('when a sandbox is available it really hides the home folder and the network', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ext-box-'));
  const fakeHome = join(root, 'home');
  await mkdir(join(fakeHome, '.config'), { recursive: true });
  await writeFile(join(fakeHome, '.config', 'token'), 'sign-in-value');
  const probe = `${READ}import {readFileSync,writeFileSync} from 'node:fs';import net from 'node:net';
    const read=(p)=>{try{return readFileSync(p,'utf8')}catch(e){return 'ERR:'+e.code}};
    const write=(p)=>{try{writeFileSync(p,'x');return 'ok'}catch(e){return 'ERR:'+e.code}};
    const netOk=await new Promise(r=>{const s=net.connect({host:'1.1.1.1',port:53,timeout:1500});s.on('connect',()=>{s.destroy();r('connected')});s.on('error',e=>r('ERR:'+e.code));s.on('timeout',()=>{s.destroy();r('timeout')})});
    console.log(JSON.stringify({ok:true,result:{summary:JSON.stringify({token:read(${JSON.stringify(join(fakeHome, '.config', 'token'))}),own:write(process.env.MAC_EXTENSION_DATA+'/note'),sys:write('/usr/mac-probe'),net:netOk})}}))`;
  await makeExt(join(root, 'user'), base, probe);
  const h = await new ExtensionHost({ dirs: [{ path: join(root, 'user'), source: 'user' }], dataDir: join(root, 'data'), hide: [fakeHome], env: { PATH: process.env.PATH } }).load();
  if (process.env.MAC_REQUIRE_SANDBOX_TEST) assert.equal(h.detectIsolation().mode, 'bwrap', `sandbox required for this run: ${h.detectIsolation().reason}`);
  if (h.detectIsolation().mode !== 'bwrap') { t.skip(`no sandbox here (${h.detectIsolation().reason})`); return; }
  await h.configure('demo', { grant: [], enabled: true });
  const r = await h.run('demo', 'command');
  assert.equal(r.ok, true, r.error);
  const seen = JSON.parse(r.result.summary);
  assert.equal(seen.token, 'ERR:ENOENT', 'home folder is hidden');
  assert.equal(seen.own, 'ok', 'own data folder is writable');
  assert.match(seen.sys, /^ERR:/, 'system is read-only');
  assert.match(seen.net, /^ERR:/, 'no network without the permission');
});

test('overlapping state saves do not fail', async () => {
  const { h, root } = await host(async ({ user }) => makeExt(user, base, `${READ}console.log(JSON.stringify({ok:true,result:{}}))`));
  await h.configure('demo', { grant: [], enabled: true });
  await Promise.all([...Array.from({ length: 8 }, () => h.save()), h.run('demo', 'command'), h.configure('demo', { enabled: false })]);
  assert.equal(JSON.parse(await readFile(join(root, 'data', 'extensions.json'), 'utf8')).demo.enabled, false);
});

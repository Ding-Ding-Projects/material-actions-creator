import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalRunner, ACT, planWorkflow, jobSystems, localWorkflow, actArgs, parseActLine, collectArtifacts, osOfLabel } from '../src/local.js';
import { JobManager, stagesFor } from '../src/jobs.js';
import { validateRequest } from '../src/workflow.js';
import { makeZip } from './helpers.js';

const linuxDocker = { canRun: { linux: 'container', windows: false, macos: false } };
const linuxHost = { canRun: { linux: 'host', windows: false, macos: false } };
const windowsHost = { canRun: { linux: false, windows: 'host', macos: false } };
const WF = `name: CI
on:
  push:
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./build.sh
      - uses: softprops/action-gh-release@v2
  win:
    name: Windows package
    runs-on: windows-latest
    steps:
      - run: build.bat
  matrix:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: echo hi
  odd:
    runs-on: [self-hosted, gpu]
    steps:
      - run: echo hi
  shared:
    uses: ./.github/workflows/other.yml
`;

test('runner labels map to operating systems', () => {
  assert.equal(osOfLabel('ubuntu-24.04-arm'), 'linux');
  assert.equal(osOfLabel('windows-2022'), 'windows');
  assert.equal(osOfLabel('macos-latest'), 'macos');
  assert.equal(osOfLabel('gpu'), null);
  assert.deepEqual(jobSystems({ 'runs-on': { group: 'big', labels: ['ubuntu-latest'] } }).systems, ['linux']);
  assert.deepEqual(jobSystems({ 'runs-on': '${{ matrix.os }}', strategy: { matrix: { include: [{ os: 'windows-latest' }] } } }).systems, ['windows']);
  assert.equal(jobSystems({ 'runs-on': '${{ inputs.runner }}' }).unknown, true);
});

test('the plan says per job what this computer can and cannot run', () => {
  const p = planWorkflow(WF, linuxDocker);
  assert.equal(p.event, 'workflow_dispatch');
  const by = Object.fromEntries(p.jobs.map((j) => [j.id, j]));
  assert.deepEqual([by.build.runnable, by.build.how], [true, 'container']);
  assert.deepEqual([by.win.runnable, by.win.name, by.win.reason], [false, 'Windows package', 'Windows jobs need a Windows computer']);
  assert.deepEqual([by.matrix.runnable, by.matrix.partial, by.matrix.reason], [true, true, 'macOS jobs need a Mac']);
  assert.equal(by.odd.runnable, false);
  assert.match(by.odd.reason, /runner label/);
  assert.equal(by.shared.how, 'reusable');
  assert.deepEqual([p.runnable, p.skipped], [3, 2]);
  const w = planWorkflow(WF, windowsHost);
  assert.equal(Object.fromEntries(w.jobs.map((j) => [j.id, j.runnable])).win, true);
  assert.match(w.jobs.find((j) => j.id === 'build').reason, /Linux jobs need Docker/);
  assert.equal(planWorkflow('on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n', linuxHost).event, 'push');
  assert.throws(() => planWorkflow('on: push\n', linuxHost), /no jobs/);
  assert.throws(() => planWorkflow('a: [', linuxHost), /Not valid YAML/);
});

test('publishing steps are removed for local runs, everything else is kept', () => {
  const { yaml, removed } = localWorkflow(WF);
  assert.deepEqual(removed, ['build: softprops/action-gh-release@v2']);
  assert.ok(!yaml.includes('action-gh-release'));
  assert.ok(yaml.includes('actions/checkout@v4') && yaml.includes('./build.sh'));
  assert.match(yaml, /^on:/m, 'the trigger block survives');
});

test('act arguments follow what the host can run', () => {
  const a = actArgs({ event: 'push', workflow: '.github/workflows/ci.yml', artifactDir: '/a', caps: linuxDocker }).join(' ');
  assert.match(a, /^push -W \.github\/workflows\/ci\.yml --artifact-server-path \/a /);
  assert.match(a, /-P ubuntu-latest=catthehacker\/ubuntu:act-latest/);
  assert.ok(!a.includes('windows'));
  assert.match(actArgs({ event: 'push', workflow: 'w', artifactDir: '/a', caps: linuxHost }).join(' '), /-P ubuntu-latest=-self-hosted/);
  assert.match(actArgs({ event: 'push', workflow: 'w', artifactDir: '/a', caps: windowsHost }).join(' '), /-P windows-latest=-self-hosted/);
});

test('act log lines become step starts and results', () => {
  assert.deepEqual(parseActLine('[CI/build] ⭐ Run Main ./build.sh'), { job: 'CI/build', kind: 'start', phase: 'Main', name: './build.sh' });
  assert.deepEqual(parseActLine('\u001b[36m[CI/build] \u001b[0m  ✅  Success - Main ./build.sh [1.204s]'), { job: 'CI/build', kind: 'success', phase: 'Main', name: './build.sh' });
  assert.equal(parseActLine('[CI/build]   ❌  Failure - Post actions/checkout@v4').kind, 'failure');
  assert.equal(parseActLine('[CI/build]   | compiling'), null);
});

test('the runner program is downloaded once, hash-checked, and a wrong file is deleted', async (t) => {
  if (process.platform === 'win32') { t.skip('tar fixture is POSIX'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'local-act-'));
  await writeFile(join(dir, 'act'), '#!/bin/sh\necho fake act\n');
  spawnSync('tar', ['-czf', join(dir, 'a.tgz'), '-C', dir, 'act']);
  const archive = await readFile(join(dir, 'a.tgz'));
  const key = `${process.platform}-${process.arch}`;
  const real = ACT.assets[key].sha256;
  let calls = 0;
  const fetchImpl = async (url) => { calls++; assert.match(url, /nektos\/act\/releases\/download\/v0\.2\.98\//); return new Response(archive, { headers: { 'content-length': String(archive.length) } }); };
  const mk = () => new LocalRunner({ toolsDir: join(dir, 'tools'), env: { PATH: process.env.PATH }, fetchImpl });
  await assert.rejects(mk().ensureAct(), /does not match its expected hash/);
  await assert.rejects(access(join(dir, 'tools', `act-${ACT.version}`)), 'nothing is left behind');
  ACT.assets[key].sha256 = createHash('sha256').update(archive).digest('hex');
  try {
    const r = mk();
    assert.equal(r.capabilities().act.installed, false);
    const seen = [];
    const [a, b] = await Promise.all([r.ensureAct((p) => seen.push(p)), r.ensureAct()]);
    assert.equal(a, b);
    assert.equal(calls, 2, 'two callers share one download');
    assert.ok(seen.at(-1).got === archive.length);
    assert.equal(spawnSync(a, []).stdout.toString().trim(), 'fake act');
    assert.deepEqual([r.capabilities().act.installed, r.capabilities().act.source], [true, 'managed']);
    await r.ensureAct();
    assert.equal(calls, 2, 'already installed: no download');
  } finally { ACT.assets[key].sha256 = real; }
  await assert.rejects(new LocalRunner({ toolsDir: join(dir, 't2'), env: { PATH: process.env.PATH }, fetchImpl: async () => new Response('no', { status: 404 }) }).ensureAct(), /HTTP 404/);
  await assert.rejects(new LocalRunner({ toolsDir: join(dir, 't3'), env: {}, platform: 'sunos', arch: 'sparc' }).ensureAct(), /no runner program for sunos/);
});

test('scripts pick the right shell, and say why when they cannot run here', () => {
  const linux = new LocalRunner({ toolsDir: '/x', platform: 'linux' });
  assert.match(linux.scriptCommand('build.sh').command, /^(bash|sh)$/);
  assert.throws(() => linux.scriptCommand('build\\installer.bat'), /only runs on a Windows computer/);
  const win = new LocalRunner({ toolsDir: '/x', platform: 'win32', env: { PATH: '' } });
  assert.deepEqual(win.scriptCommand('build/installer.bat'), { command: 'cmd.exe', args: ['/d', '/c', 'build\\installer.bat'] });
});

test('sign-in values never reach a local run', () => {
  const r = new LocalRunner({ toolsDir: '/x', env: { PATH: '/bin', GITHUB_TOKEN: 'a', GH_TOKEN: 'b', APP_ACCESS_KEY: 'c', MAC_KEY: 'd', NPM_TOKEN: 'e', DB_PASSWORD: 'f', HOME: '/h' } });
  assert.deepEqual(Object.keys(r.runEnv({ X: '1' })).sort(), ['CI', 'HOME', 'PATH', 'X']);
});

test('artifacts saved by the runner are unpacked, unsafe names are skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-art-'));
  await mkdir(join(dir, 'in', '1', 'installers'), { recursive: true });
  await writeFile(join(dir, 'in', '1', 'installers', 'installers.zip'), makeZip([{ name: 'dist/app.tar.gz', data: Buffer.from('APP') }, { name: '../evil', data: Buffer.from('x') }]));
  const out = await collectArtifacts(join(dir, 'in'), join(dir, 'out'));
  assert.deepEqual(out.map((o) => [o.name, o.size]), [['installers/dist/app.tar.gz', 3]]);
  assert.equal(await readFile(join(dir, 'out', 'installers', 'dist', 'app.tar.gz'), 'utf8'), 'APP');
});

// ---- whole local builds through the job manager ----
async function manager({ act = null, containers = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-jobs-'));
  const local = new LocalRunner({ toolsDir: join(dataDir, 'tools'), env: { ...process.env, GITHUB_TOKEN: 'must-not-leak', ...(act ? { MAC_ACT_PATH: act } : {}) } });
  local.containers = () => containers;
  const jobs = new JobManager({ getClient: async () => { throw new Error('GitHub must not be used for a local folder'); }, dataDir, local, ttlMs: 60_000, journal: false });
  return { jobs, dataDir };
}
const done = async (jobs, id) => { await jobs.jobs.get(id).promise; return jobs.get(id); };

test('local stages', () => {
  assert.deepEqual(stagesFor('local').map((s) => s.id), ['source', 'runner', 'build', 'download', 'cleanup']);
});

test('a folder on this computer: scripts run with the host shell and outputs come back', async (t) => {
  if (process.platform === 'win32') { t.skip('uses sh'); return; }
  const project = await mkdtemp(join(tmpdir(), 'local-proj-'));
  await writeFile(join(project, 'build.sh'), 'set -e\necho "building in $PWD"\necho "token=${GITHUB_TOKEN:-none}"\nmkdir -p dist\nprintf BUILT > dist/app.bin\n');
  await writeFile(join(project, 'second.sh'), 'cat dist/app.bin > dist/copy.bin\necho done\n');
  const { jobs, dataDir } = await manager();
  const req = validateRequest({ kind: 'scripts', mode: 'local', localPath: project, scripts: ['build.sh', 'second.sh'], outputs: 'dist/**' });
  assert.equal(req.repo.startsWith('local/'), true);
  const job = await done(jobs, jobs.create(req).id);
  assert.equal(job.status, 'ready', job.error);
  assert.deepEqual(job.stages.map((s) => s.state), Array(5).fill('done'));
  assert.equal(job.repo, null, 'no repository is created');
  assert.deepEqual(job.outputs.map((o) => o.name), ['dist/app.bin', 'dist/copy.bin']);
  assert.equal(await readFile(jobs.filePath(job.id, 0), 'utf8'), 'BUILT');
  assert.deepEqual(job.steps.map((s) => [s.name, s.conclusion]), [['build.sh', 'success'], ['second.sh', 'success']]);
  const log = await readFile(jobs.logPath(job.id), 'utf8');
  assert.match(log, /=== Build scripts \/ build\.sh ===\nbuilding in /);
  assert.match(log, /token=none/, 'sign-in values are not passed on');
  await assert.rejects(access(join(dataDir, job.id, 'src')), 'the working folder is removed');
  await assert.rejects(access(join(project, 'dist')), 'the original folder is not touched');
});

test('a failing script stops the run and is named', async (t) => {
  if (process.platform === 'win32') { t.skip('uses sh'); return; }
  const project = await mkdtemp(join(tmpdir(), 'local-fail-'));
  await writeFile(join(project, 'build.sh'), 'echo about to fail\nexit 3\n');
  await writeFile(join(project, 'never.sh'), 'echo never\n');
  const { jobs } = await manager();
  const job = await done(jobs, jobs.create(validateRequest({ kind: 'scripts', mode: 'local', localPath: project, scripts: ['build.sh', 'never.sh'], outputs: 'dist/**' })).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /build\.sh ended with code 3/);
  assert.equal(job.steps.length, 1);
  assert.equal(job.logUrl, `/api/builds/${job.id}/log`);
});

test('a batch file on Linux is refused with the reason before anything runs', async (t) => {
  if (process.platform === 'win32') { t.skip('host is Windows'); return; }
  const project = await mkdtemp(join(tmpdir(), 'local-bat-'));
  await writeFile(join(project, 'build.bat'), 'echo hi\r\n');
  const { jobs } = await manager();
  const job = await done(jobs, jobs.create(validateRequest({ kind: 'scripts', mode: 'local', localPath: project, scripts: ['build.bat'], outputs: '*.exe' })).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /only runs on a Windows computer/);
});

test('workflows run through the runner program; skipped jobs and removed steps are listed', async (t) => {
  if (process.platform === 'win32') { t.skip('fake runner is a sh script'); return; }
  const project = await mkdtemp(join(tmpdir(), 'local-wf-'));
  await mkdir(join(project, '.github', 'workflows'), { recursive: true });
  await writeFile(join(project, '.github', 'workflows', 'ci.yml'), WF);
  // A stand-in for act: checks its arguments and environment, prints act-style lines, saves one artifact.
  const fake = join(project, 'fake-act.sh');
  const zip = makeZip([{ name: 'app.tar.gz', data: Buffer.from('FROM-WORKFLOW') }]).toString('base64');
  await writeFile(fake, `#!/bin/sh
[ "$1" = "workflow_dispatch" ] || { echo "bad event $1"; exit 9; }
[ -f "$XDG_CONFIG_HOME/act/actrc" ] || { echo "no actrc"; exit 9; }
[ -z "$GITHUB_TOKEN" ] || { echo "token leaked"; exit 9; }
grep -q action-gh-release "$3" && { echo "publish step still there"; exit 9; }
echo "args: $*"
echo "[CI/build] ⭐ Run Main ./build.sh"
echo "[CI/build]   | compiling"
echo "[CI/build]   ✅  Success - Main ./build.sh [0.5s]"
mkdir -p "$5/1/installers"
echo "${zip}" | base64 -d > "$5/1/installers/installers.zip"
`);
  await chmod(fake, 0o755);
  const { jobs } = await manager({ act: fake });
  const job = await done(jobs, jobs.create(validateRequest({ kind: 'scripts', mode: 'local', localPath: project, workflows: ['.github/workflows/ci.yml'] })).id);
  assert.equal(job.status, 'ready', job.error);
  assert.deepEqual(job.outputs.map((o) => o.name), ['installers/app.tar.gz']);
  assert.equal(await readFile(jobs.filePath(job.id, 0), 'utf8'), 'FROM-WORKFLOW');
  assert.deepEqual(job.steps.map((s) => [s.run, s.job, s.name, s.conclusion]), [['CI', 'CI/build', './build.sh', 'success']]);
  assert.ok(job.warnings.some((w) => /Not run here — CI \/ Windows package: Windows jobs need a Windows computer/.test(w)), job.warnings.join('|'));
  assert.ok(job.warnings.some((w) => /Publishing step removed — build: softprops/.test(w)));
  assert.ok(job.warnings.some((w) => /No Docker: Linux jobs run directly on this computer/.test(w)));
  const log = await readFile(jobs.logPath(job.id), 'utf8');
  assert.match(log, /args: workflow_dispatch -W \.github\/workflows\/ci\.yml --artifact-server-path .* -P ubuntu-latest=-self-hosted/);
  assert.equal(job.localPlan[0].jobs.find((j) => j.id === 'win').runnable, false);
});

test('a workflow with nothing this computer can run fails with the reasons', async () => {
  const project = await mkdtemp(join(tmpdir(), 'local-none-'));
  await mkdir(join(project, '.github', 'workflows'), { recursive: true });
  await writeFile(join(project, '.github', 'workflows', 'mac.yml'), 'on: push\njobs:\n  a:\n    runs-on: macos-latest\n    steps:\n      - run: echo hi\n');
  const { jobs } = await manager();
  jobs.local.platform = 'linux';
  const job = await done(jobs, jobs.create(validateRequest({ kind: 'scripts', mode: 'local', localPath: project, workflows: ['.github/workflows/mac.yml'] })).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /None of the jobs can run on this computer\. macOS jobs need a Mac/);
});

test('a Docker image build without Docker explains what is missing', async () => {
  const { jobs } = await manager();
  const job = await done(jobs, jobs.create(validateRequest({ dockerfile: 'FROM alpine\n', imageName: 'demo:1', mode: 'local' })).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /needs Docker.*cannot install it for you/);
});

test('requests: a folder is only allowed in local mode and must be a full path', () => {
  assert.throws(() => validateRequest({ kind: 'scripts', localPath: '/x', scripts: ['a.sh'], outputs: 'x' }), /only be built in local mode/);
  assert.throws(() => validateRequest({ kind: 'scripts', mode: 'local', localPath: 'relative/dir', scripts: ['a.sh'], outputs: 'x' }), /full path/);
  assert.equal(validateRequest({ kind: 'scripts', mode: 'local', repo: 'o/r', scripts: ['a.bat'], outputs: 'x', runner: 'ubuntu-latest' }).scripts[0], 'a.bat');
});

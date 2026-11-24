import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../src/github.js';
import { JobManager, REPO_PREFIX, PUBLIC_PREFIX, stagesFor } from '../src/jobs.js';
import { validateRequest } from '../src/workflow.js';
import { fakeGitHub, SOURCE_TARBALL_BYTES } from './helpers.js';

const noSleep = async () => {};
const docker = validateRequest({ dockerfile: 'FROM alpine\n', imageName: 'demo:1', files: [{ path: 'app/run.sh', content: 'echo hi' }] });
const dockerEnc = validateRequest({ dockerfile: 'FROM alpine\nCOPY app /app\n', imageName: 'demo:enc', files: [{ path: 'app/run.sh', content: 'echo secret' }], mode: 'encrypted-public' });
const scripts = validateRequest({ kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', ref: 'main', scripts: ['build\\installer.bat'], outputs: 'dist/**/*.exe,dist/**/*.msi' });
const scriptsEnc = { ...scripts, mode: 'encrypted-public' };

async function setup(opts = {}) {
  const gh = fakeGitHub(opts);
  const mk = (token = 't') => new GitHubClient({ token, fetchImpl: gh.fetchImpl, sleepImpl: noSleep });
  const dataDir = opts.dataDir || await mkdtemp(join(tmpdir(), 'jobs-'));
  const jobs = new JobManager({
    getClient: async () => mk(), makeClient: mk, app: opts.app || null,
    owner: opts.owner ?? 'Ding-Ding-Projects', dataDir, sleepImpl: opts.sleepImpl || noSleep, ttlMs: 60_000,
  });
  return { gh, jobs, dataDir, mk };
}

async function finish(jobs, id) {
  await jobs.jobs.get(id).promise;
  await jobs.saving;
  return jobs.get(id);
}

const states = (job) => job.stages.map((s) => s.state);

test('stage lists differ per mode', () => {
  assert.deepEqual(stagesFor('private').map((s) => s.id), ['repo', 'commit', 'dispatch', 'build', 'download', 'cleanup']);
  const enc = stagesFor('encrypted-public');
  assert.deepEqual(enc.map((s) => s.id), ['key', 'encrypt', 'repo', 'commit', 'secret', 'dispatch', 'build', 'download', 'cleanup']);
  assert.equal(enc.find((s) => s.id === 'repo').label, 'Create public repository');
  assert.equal(enc.find((s) => s.id === 'download').label, 'Download and decrypt outputs');
});

test('private Dockerfile build: commit, download and delete', async () => {
  const { gh, jobs } = await setup();
  const created = jobs.create(docker);
  assert.ok(created.repo.startsWith(REPO_PREFIX));
  let snapshot;
  jobs.on('update', (j) => { if (j.stages[1].state === 'done' && !snapshot) snapshot = structuredClone(gh.state.repos.get(j.repo)); });
  const job = await finish(jobs, created.id);
  assert.equal(job.status, 'ready', job.error);
  assert.deepEqual(states(job), Array(6).fill('done'));
  assert.deepEqual(job.outputs.map((o) => o.name), ['image.tar.gz']);
  assert.equal(job.downloadUrl, `/api/builds/${job.id}/files/0`);
  assert.equal(await readFile(jobs.filePath(job.id, 0), 'utf8'), 'IMAGE:FROM alpine\n');
  assert.equal(gh.state.repos.size, 0, 'temporary repo must be deleted');
  assert.deepEqual(Object.keys(snapshot.files).sort(), ['.github/workflows/mac-build.yml', 'README.md', 'context/Dockerfile', 'context/app/run.sh']);
  assert.equal(snapshot.private, true);
});

test('encrypted Dockerfile build: public repo holds only ciphertext, image comes back decrypted', async () => {
  const { gh, jobs } = await setup();
  const created = jobs.create(dockerEnc);
  assert.ok(created.repo.startsWith(PUBLIC_PREFIX));
  let snapshot;
  jobs.on('update', (j) => { if (j.stages.find((s) => s.id === 'secret').state === 'done' && !snapshot) snapshot = structuredClone(gh.state.repos.get(j.repo)); });
  const job = await finish(jobs, created.id);
  assert.equal(job.status, 'ready', job.error);
  assert.deepEqual(states(job), Array(9).fill('done'));
  assert.equal(job.keySource, 'session');
  assert.equal(snapshot.private, false);
  assert.deepEqual(Object.keys(snapshot.files).sort(), ['.github/workflows/mac-build.yml', '.mac/crypt.mjs', 'README.md', 'src.mac']);
  const everything = Object.values(snapshot.filesRaw).map((b) => b.toString('latin1')).join('\n');
  assert.ok(!everything.includes('echo secret'), 'plaintext source leaked into the public repo');
  assert.ok(!everything.includes('COPY app'), 'Dockerfile leaked into the public repo');
  assert.ok(snapshot.secrets.MAC_KEY, 'key stored as an Actions secret');
  assert.equal(gh.state.seen.dockerfile, 'FROM alpine\nCOPY app /app\n', 'runner decrypted the real context');
  assert.equal(await readFile(jobs.filePath(job.id, 0), 'utf8'), `IMAGE:${dockerEnc.dockerfile}`);
  assert.equal(gh.state.repos.size, 0);
});

test('private script build: source tarball in, installer files out', async () => {
  const { gh, jobs } = await setup();
  const job = await finish(jobs, jobs.create(scripts).id);
  assert.equal(job.status, 'ready', job.error);
  assert.equal(job.title, 'map-editor build');
  assert.equal(gh.state.seen.tarball, SOURCE_TARBALL_BYTES.toString());
  assert.deepEqual(job.outputs.map((o) => o.name).sort(), ['Setup-1.0.exe', 'msi/Setup-1.0.msi']);
  assert.equal(await readFile(jobs.filePath(job.id, job.outputs.findIndex((o) => o.name === 'Setup-1.0.exe')), 'utf8'), `EXE built from ${SOURCE_TARBALL_BYTES}`);
});

test('encrypted script build: outputs listed and auto-decrypted', async () => {
  const { gh, jobs } = await setup();
  let snapshot;
  const created = jobs.create(scriptsEnc);
  jobs.on('update', (j) => { if (j.stages.find((s) => s.id === 'commit').state === 'done' && !snapshot) snapshot = structuredClone(gh.state.repos.get(j.repo)); });
  const job = await finish(jobs, created.id);
  assert.equal(job.status, 'ready', job.error);
  assert.ok(!Object.values(snapshot.filesRaw).some((b) => b.includes(SOURCE_TARBALL_BYTES)), 'source tarball leaked');
  assert.deepEqual(job.outputs.map((o) => o.name).sort(), ['Setup-1.0.exe', 'msi/Setup-1.0.msi']);
  assert.match(job.stages.find((s) => s.id === 'download').detail, /2 files .* decrypted/);
  assert.equal(await readFile(jobs.filePath(job.id, job.outputs.findIndex((o) => o.name === 'msi/Setup-1.0.msi')), 'utf8'), 'MSI');
});

test('GitHub App mode mints a temporary key per run and revokes it', async () => {
  let minted = 0;
  const app = { mintToken: async () => { minted++; return { token: `ghs_temp${minted}`, expiresAt: Date.now() + 3600_000 }; } };
  const { gh, jobs } = await setup({ app });
  const job = await finish(jobs, jobs.create(dockerEnc).id);
  assert.equal(job.status, 'ready', job.error);
  assert.equal(job.keySource, 'github-app');
  assert.ok(job.keyExpiresAt > Date.now());
  assert.equal(minted, 1);
  assert.equal(gh.state.revoked, 1);
  assert.match(job.stages.at(-1).detail, /key revoked/);
});

test('failed runs report the failing step and still delete the repo', async () => {
  const { gh, jobs } = await setup({ conclusion: 'failure' });
  const job = await finish(jobs, jobs.create(scriptsEnc).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Failed step: Run script 1/);
  assert.equal(job.stages.find((s) => s.id === 'cleanup').state, 'done');
  assert.equal(gh.state.repos.size, 0);
});

test('cleanup failure is surfaced but the outputs stay downloadable', async () => {
  const { jobs } = await setup({ failDelete: true });
  const job = await finish(jobs, jobs.create(docker).id);
  assert.equal(job.status, 'ready');
  assert.equal(job.stages.find((s) => s.id === 'cleanup').state, 'failed');
  assert.match(job.error, /could not be deleted/);
});

test('signed-out errors fail the job without creating anything', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const jobs = new JobManager({ getClient: async () => { throw new Error('Not signed in'); }, owner: 'x', dataDir, sleepImpl: noSleep });
  const job = await finish(jobs, jobs.create(docker).id);
  assert.equal(job.status, 'failed');
  assert.equal(job.stages.find((s) => s.id === 'cleanup').state, 'skipped');
});

test('expired downloads are removed from disk', async () => {
  const { jobs } = await setup();
  const job = await finish(jobs, jobs.create(docker).id);
  const file = jobs.filePath(job.id);
  await jobs.expire(job.id);
  assert.equal(jobs.get(job.id).status, 'expired');
  await assert.rejects(access(file));
});

test('the journal never keeps keys or requests for finished builds', async () => {
  const { jobs, dataDir } = await setup();
  await finish(jobs, jobs.create(dockerEnc).id);
  const journal = await readFile(join(dataDir, 'journal.json'), 'utf8');
  assert.doesNotMatch(journal, /"key":"/);
  assert.doesNotMatch(journal, /COPY app/);
});

test('app stops mid-build, restarts, reattaches and finishes the encrypted build', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jobs-'));
  // First life: the build is running when the app stops.
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = await setup({ dataDir, pollsUntilDone: 1000, sleepImpl: () => gate });
  const created = first.jobs.create(scriptsEnc);
  while (first.jobs.jobs.get(created.id).stages.find((s) => s.id === 'build').state !== 'active') await new Promise((r) => setTimeout(r, 5));
  await first.jobs.stop();
  release();
  await first.jobs.jobs.get(created.id).promise;
  const saved = JSON.parse(await readFile(join(dataDir, 'journal.json'), 'utf8'));
  assert.equal(saved.jobs[0].job.status, 'running');
  assert.ok(saved.jobs[0].priv.key, 'key must survive a restart so outputs can be decrypted');
  assert.equal(first.gh.state.repos.size, 1, 'repo keeps building while the app is down');

  // Second life: same GitHub, fresh manager reading the same journal.
  const gh = first.gh;
  const mk = () => new GitHubClient({ token: 't', fetchImpl: gh.fetchImpl, sleepImpl: noSleep });
  gh.state.runPolls = 0;
  const jobs = new JobManager({ getClient: async () => mk(), makeClient: mk, owner: 'Ding-Ding-Projects', dataDir, sleepImpl: noSleep, ttlMs: 60_000 });
  const fakeGh = gh; // finish the run quickly now
  fakeGh.state.runPolls = 1000;
  const recovery = await jobs.load();
  assert.deepEqual(recovery.jobs, [created.id]);
  const job = await finish(jobs, created.id);
  assert.equal(job.status, 'ready', job.error);
  assert.equal(job.recovered, true);
  assert.deepEqual(job.outputs.map((o) => o.name).sort(), ['Setup-1.0.exe', 'msi/Setup-1.0.msi']);
  assert.equal(gh.state.repos.size, 0, 'repo cleaned up after recovery');
  assert.equal(jobs.recoveryView().builds[0].status, 'ready');
});

test('a restart during repository setup cleans up instead of guessing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const { gh, jobs: first } = await setup({ dataDir });
  first.jobs.set('abc123', { id: 'abc123', mode: 'private', kind: 'dockerfile', status: 'running', repo: `${REPO_PREFIX}abc123`, owner: 'Ding-Ding-Projects', stages: stagesFor('private'), outputs: [], createdAt: Date.now() });
  first.priv.set('abc123', { phase: 'commit' });
  gh.state.repos.set(`${REPO_PREFIX}abc123`, { name: `${REPO_PREFIX}abc123`, files: {}, filesRaw: {}, secrets: {} });
  await first.save();
  const mk = () => new GitHubClient({ token: 't', fetchImpl: gh.fetchImpl, sleepImpl: noSleep });
  const jobs = new JobManager({ getClient: async () => mk(), owner: 'Ding-Ding-Projects', dataDir, sleepImpl: noSleep });
  await jobs.load();
  const job = await finish(jobs, 'abc123');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /being prepared/);
  assert.equal(gh.state.repos.size, 0);
});

test('expired ready builds are dropped on load', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jobs-'));
  await writeFile(join(dataDir, 'journal.json'), JSON.stringify({ v: 1, savedAt: Date.now(), jobs: [{ job: { id: 'old1', status: 'ready', expiresAt: Date.now() - 1, stages: [], outputs: [{ name: 'a', size: 1 }] }, priv: {} }] }));
  const jobs = new JobManager({ getClient: async () => null, owner: 'x', dataDir, sleepImpl: noSleep });
  assert.equal(await jobs.load(), null);
  assert.equal(jobs.get('old1').status, 'expired');
});

test('sweep deletes only stale prefixed repos', async () => {
  const { gh, jobs } = await setup();
  const old = new Date(Date.now() - 4 * 3600_000).toISOString();
  for (const name of [`${REPO_PREFIX}old`, `${PUBLIC_PREFIX}old`, 'important-project']) gh.state.repos.set(name, { name, created_at: old, files: {} });
  gh.state.repos.set(`${REPO_PREFIX}fresh`, { name: `${REPO_PREFIX}fresh`, created_at: new Date().toISOString(), files: {} });
  const deleted = await jobs.sweep();
  assert.deepEqual(deleted.sort(), [`${PUBLIC_PREFIX}old`, `${REPO_PREFIX}old`]);
  assert.ok(gh.state.repos.has('important-project'));
});

const withWorkflows = { ...scriptsEnc, workflows: ['.github/workflows/release.yml', '.github/workflows/lint.yml'] };

test('encrypted run of the source repository\'s own workflows plus scripts', async () => {
  const { gh, jobs } = await setup();
  let snapshot;
  const created = jobs.create(validateRequest(withWorkflows));
  jobs.on('update', (j) => { if (j.stages.find((s) => s.id === 'commit').state === 'done' && !snapshot) snapshot = structuredClone(gh.state.repos.get(j.repo)); });
  const job = await finish(jobs, created.id);
  assert.equal(job.status, 'ready', job.error);
  // Pinned to one commit for the whole build.
  assert.equal(gh.state.seen.tarballRef, 'abc1234def5678900000000000000000000000ff');
  assert.equal(gh.state.seen.contentsRef, 'abc1234def5678900000000000000000000000ff');
  assert.match(job.subtitle, /abc1234/);
  // Every source workflow is committed (rewritten); three runs start: scripts, Release, Lint.
  const wfFiles = Object.keys(snapshot.files).filter((p) => p.startsWith('.github/workflows/')).sort();
  assert.deepEqual(wfFiles, ['.github/workflows/lint.yml', '.github/workflows/mac-build.yml', '.github/workflows/release.yml', '.github/workflows/reusable.yml']);
  assert.match(snapshot.files['.github/workflows/release.yml'], /Rewritten by material-actions-creator/);
  assert.doesNotMatch(snapshot.files['.github/workflows/release.yml'], /action-gh-release/);
  assert.deepEqual(job.runs.map((r) => r.name), ['Build scripts', 'Release', 'Lint']);
  assert.ok(job.runs.every((r) => r.conclusion === 'success'));
  assert.ok(job.warnings.some((w) => /^Release: .*removed publishing step/.test(w)));
  // Outputs from every run, decrypted into one folder per run/artifact.
  const names = job.outputs.map((o) => o.name).sort();
  assert.ok(names.includes('Release/installers/dist/App-from-workflow.exe'), names.join());
  assert.ok(names.includes('Build-scripts/build/Setup-1.0.exe'), names.join());
  const idx = job.outputs.findIndex((o) => o.name === 'Release/installers/dist/App-from-workflow.exe');
  assert.equal(await readFile(jobs.filePath(job.id, idx), 'utf8'), `release.yml built from ${SOURCE_TARBALL_BYTES}`);
});

test('one failing workflow still delivers the others and says which failed', async () => {
  const { gh, jobs } = await setup();
  gh.state.failFiles.add('lint.yml');
  const job = await finish(jobs, jobs.create(validateRequest(withWorkflows)).id);
  assert.equal(job.status, 'ready');
  assert.match(job.error, /Lint: Run finished with failure/);
  assert.equal(job.stages.find((s) => s.id === 'build').state, 'failed');
  assert.ok(job.outputs.length >= 2);
  assert.equal(gh.state.repos.size, 0);
});

test('workflows-only runs need no scripts or outputs', async () => {
  const { jobs } = await setup();
  const req = validateRequest({ kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', workflows: ['.github/workflows/release.yml'], mode: 'encrypted-public' });
  const job = await finish(jobs, jobs.create(req).id);
  assert.equal(job.status, 'ready', job.error);
  assert.deepEqual(job.runs.map((r) => r.name), ['Release']);
  assert.deepEqual(job.outputs.map((o) => o.name), ['dist/App-from-workflow.exe']);
});

test('choosing a missing or reusable-only workflow fails clearly', async () => {
  const { jobs } = await setup();
  const missing = await finish(jobs, jobs.create(validateRequest({ kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', workflows: ['.github/workflows/nope.yml'] })).id);
  assert.match(missing.error, /nope\.yml is not in/);
  const reusable = await finish(jobs, jobs.create(validateRequest({ kind: 'scripts', repo: 'Ding-Ding-Projects/map-editor', workflows: ['.github/workflows/reusable.yml'] })).id);
  assert.match(reusable.error, /can be started manually/);
});

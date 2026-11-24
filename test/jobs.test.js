import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../src/github.js';
import { JobManager, REPO_PREFIX } from '../src/jobs.js';
import { validateRequest } from '../src/workflow.js';
import { fakeGitHub, makeZip } from './helpers.js';

const noSleep = async () => {};
const request = validateRequest({ dockerfile: 'FROM alpine\n', imageName: 'demo:1', files: [{ path: 'app/run.sh', content: 'echo hi' }] });

async function setup(opts = {}) {
  const image = Buffer.from('pretend-this-is-a-docker-image');
  const gh = fakeGitHub({ artifactZip: makeZip([{ name: 'image.tar.gz', data: image }]), ...opts });
  const client = new GitHubClient({ token: 't', fetchImpl: gh.fetchImpl, sleepImpl: noSleep });
  const dataDir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const jobs = new JobManager({ getClient: async () => client, owner: opts.owner ?? 'Ding-Ding-Projects', dataDir, sleepImpl: noSleep, ttlMs: 60_000 });
  return { gh, jobs, image, dataDir };
}

async function finish(jobs, id) {
  await jobs.jobs.get(id).promise;
  return jobs.get(id);
}

test('happy path builds, downloads, and deletes the temporary repo', async () => {
  const { gh, jobs, image } = await setup();
  const created = jobs.create(request);
  assert.ok(created.repo.startsWith(REPO_PREFIX));
  let repoSnapshot;
  jobs.on('update', (j) => { if (j.stages[1].state === 'done' && !repoSnapshot) repoSnapshot = structuredClone(gh.state.repos.get(j.repo)); });
  const job = await finish(jobs, created.id);

  assert.equal(job.status, 'ready', job.error);
  assert.deepEqual(job.stages.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'done']);
  assert.equal(job.downloadUrl, `/api/builds/${job.id}/download`);
  assert.ok((await readFile(jobs.filePath(job.id))).equals(image));
  assert.equal(gh.state.repos.size, 0, 'temporary repo must be deleted');
  assert.ok(gh.state.calls.includes(`POST /orgs/Ding-Ding-Projects/repos`));
  assert.deepEqual(Object.keys(repoSnapshot.files).sort(), ['.github/workflows/build-image.yml', 'README.md', 'context/Dockerfile', 'context/app/run.sh']);
  assert.equal(repoSnapshot.private, true);
  assert.ok(!('filePath' in job), 'server paths must not leak to clients');
});

test('user owners create repos under /user/repos', async () => {
  const { gh, jobs } = await setup({ ownerType: 'User', owner: 'swiftie' });
  const job = await finish(jobs, jobs.create(request).id);
  assert.equal(job.status, 'ready');
  assert.ok(gh.state.calls.includes('POST /user/repos'));
});

test('owner falls back to the signed-in user', async () => {
  const { jobs } = await setup({ owner: '', ownerType: 'User' });
  const job = await finish(jobs, jobs.create(request).id);
  assert.equal(job.owner, 'swiftie');
});

test('failed runs report the failing step and still delete the repo', async () => {
  const { gh, jobs } = await setup({ conclusion: 'failure' });
  const job = await finish(jobs, jobs.create(request).id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Failed step: Build image/);
  assert.equal(job.stages.find((s) => s.id === 'build').state, 'failed');
  assert.equal(job.stages.find((s) => s.id === 'cleanup').state, 'done');
  assert.equal(gh.state.repos.size, 0);
});

test('cleanup failure is surfaced but the image stays downloadable', async () => {
  const { jobs } = await setup({ failDelete: true });
  const job = await finish(jobs, jobs.create(request).id);
  assert.equal(job.status, 'ready');
  assert.equal(job.stages.find((s) => s.id === 'cleanup').state, 'failed');
  assert.match(job.error, /could not be deleted/);
});

test('signed-out errors fail the job without creating anything', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jobs-'));
  const jobs = new JobManager({ getClient: async () => { throw new Error('Not signed in'); }, owner: 'x', dataDir, sleepImpl: noSleep });
  const job = await finish(jobs, jobs.create(request).id);
  assert.equal(job.status, 'failed');
  assert.equal(job.stages.find((s) => s.id === 'cleanup').state, 'skipped');
});

test('expired downloads are removed from disk', async () => {
  const { jobs } = await setup();
  const job = await finish(jobs, jobs.create(request).id);
  const file = jobs.filePath(job.id);
  await jobs.expire(job.id);
  assert.equal(jobs.get(job.id).status, 'expired');
  await assert.rejects(access(file));
});

test('sweep deletes only stale prefixed repos', async () => {
  const { gh, jobs } = await setup();
  const old = new Date(Date.now() - 4 * 3600_000).toISOString();
  gh.state.repos.set(`${REPO_PREFIX}old`, { name: `${REPO_PREFIX}old`, created_at: old, files: {} });
  gh.state.repos.set(`${REPO_PREFIX}fresh`, { name: `${REPO_PREFIX}fresh`, created_at: new Date().toISOString(), files: {} });
  gh.state.repos.set('important-project', { name: 'important-project', created_at: old, files: {} });
  const deleted = await jobs.sweep();
  assert.deepEqual(deleted, [`${REPO_PREFIX}old`]);
  assert.ok(gh.state.repos.has('important-project'));
  assert.ok(gh.state.repos.has(`${REPO_PREFIX}fresh`));
});

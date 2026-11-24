// Build orchestration: temp repo -> commit -> dispatch -> wait -> download -> delete repo.
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventEmitter } from 'node:events';
import { buildRepoFiles, WORKFLOW_FILE, ARTIFACT_NAME, IMAGE_FILE, downloadName } from './workflow.js';
import { extractEntry } from './zip.js';

export const REPO_PREFIX = 'mac-tmp-';
export const REPO_TOPIC = 'material-actions-creator-temp';

export const STAGES = [
  { id: 'repo', label: 'Create temporary repository' },
  { id: 'commit', label: 'Commit Dockerfile and workflow' },
  { id: 'dispatch', label: 'Start workflow run' },
  { id: 'build', label: 'Build image on GitHub Actions' },
  { id: 'download', label: 'Download image artifact' },
  { id: 'cleanup', label: 'Delete temporary repository' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JobManager extends EventEmitter {
  constructor({ getClient, owner, dataDir, pollMs = 5000, ttlMs = 60 * 60 * 1000, sleepImpl = sleep, keepRepoOnFailure = false }) {
    super();
    this.getClient = getClient;
    this.owner = owner;
    this.dataDir = dataDir;
    this.pollMs = pollMs;
    this.ttlMs = ttlMs;
    this.sleep = sleepImpl;
    this.keepRepoOnFailure = keepRepoOnFailure;
    this.jobs = new Map();
  }

  list() {
    return [...this.jobs.values()].map((j) => this.view(j)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this.view(j) : null;
  }

  view(j) {
    const { filePath, ...rest } = j;
    return { ...rest, downloadUrl: j.status === 'ready' ? `/api/builds/${j.id}/download` : null };
  }

  update(job, patch) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.emit('update', this.view(job));
  }

  stage(job, id, state, detail) {
    const s = job.stages.find((x) => x.id === id);
    s.state = state;
    if (detail !== undefined) s.detail = detail;
    if (state === 'active') s.startedAt = Date.now();
    if (['done', 'failed', 'skipped'].includes(state)) s.endedAt = Date.now();
    this.update(job, {});
  }

  create(request) {
    const id = randomBytes(5).toString('hex');
    const job = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      imageName: request.imageName,
      platform: request.platform,
      repo: `${REPO_PREFIX}${id}`,
      owner: null,
      runUrl: null,
      error: null,
      fileName: downloadName(request.imageName),
      size: null,
      expiresAt: null,
      stages: STAGES.map((s) => ({ ...s, state: 'pending', detail: null })),
    };
    this.jobs.set(id, job);
    job.promise = this.run(job, request).catch(() => {});
    Object.defineProperty(job, 'promise', { enumerable: false });
    return this.view(job);
  }

  async run(job, request) {
    let gh;
    let owner;
    let repoCreated = false;
    let failed = false;
    try {
      gh = await this.getClient();
      owner = this.owner || (await gh.viewer()).login;
      job.owner = owner;
      const isOrg = (await gh.ownerType(owner)) === 'Organization';

      this.stage(job, 'repo', 'active');
      const repo = await gh.createRepo(owner, job.repo, { isOrg, description: `Temporary build for ${request.imageName} (auto-deleted)` });
      repoCreated = true;
      const branch = repo.default_branch || 'main';
      try { await gh.setTopics(owner, job.repo, [REPO_TOPIC]); } catch { /* topics are best-effort */ }
      this.stage(job, 'repo', 'done', `${owner}/${job.repo}`);

      this.stage(job, 'commit', 'active');
      const files = buildRepoFiles(request);
      for (const [i, f] of files.entries()) {
        await gh.putFile(owner, job.repo, f.path, f.content, `Add ${f.path}`);
        this.stage(job, 'commit', 'active', `${i + 1}/${files.length} files`);
      }
      this.stage(job, 'commit', 'done', `${files.length} files`);

      this.stage(job, 'dispatch', 'active');
      await gh.dispatchWorkflow(owner, job.repo, WORKFLOW_FILE, branch);
      let run = null;
      for (let i = 0; i < 60 && !run; i++) {
        run = await gh.latestRun(owner, job.repo, WORKFLOW_FILE);
        if (!run) await this.sleep(this.pollMs);
      }
      if (!run) throw new Error('The workflow run never appeared.');
      this.update(job, { runUrl: run.html_url });
      this.stage(job, 'dispatch', 'done', `Run #${run.run_number}`);

      this.stage(job, 'build', 'active', run.status);
      while (run.status !== 'completed') {
        await this.sleep(this.pollMs);
        run = await gh.getRun(owner, job.repo, run.id);
        this.stage(job, 'build', 'active', run.status.replace('_', ' '));
      }
      if (run.conclusion !== 'success') {
        let detail = `Run finished with ${run.conclusion}.`;
        try {
          const jobs = await gh.runJobs(owner, job.repo, run.id);
          const failedSteps = jobs.flatMap((j) => (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name));
          if (failedSteps.length) detail += ` Failed step: ${failedSteps.join(', ')}.`;
        } catch { /* best effort */ }
        this.stage(job, 'build', 'failed', detail);
        throw new Error(detail);
      }
      this.stage(job, 'build', 'done', 'success');

      this.stage(job, 'download', 'active');
      const artifacts = await gh.runArtifacts(owner, job.repo, run.id);
      const artifact = artifacts.find((a) => a.name === ARTIFACT_NAME);
      if (!artifact) throw new Error('The run did not upload the image artifact.');
      await mkdir(this.dataDir, { recursive: true });
      const zipPath = join(this.dataDir, `${job.id}.zip`);
      const outPath = join(this.dataDir, `${job.id}.tar.gz`);
      const res = await gh.downloadArtifact(owner, job.repo, artifact.id);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
      await extractEntry(zipPath, IMAGE_FILE, outPath);
      await rm(zipPath, { force: true });
      const { size } = await stat(outPath);
      job.filePath = outPath;
      Object.defineProperty(job, 'filePath', { enumerable: false, writable: true });
      this.stage(job, 'download', 'done', formatBytes(size));
      this.update(job, { size });
    } catch (err) {
      failed = true;
      const active = job.stages.find((s) => s.state === 'active');
      if (active) this.stage(job, active.id, 'failed', err.message);
      this.update(job, { error: err.message });
    } finally {
      if (repoCreated && !(failed && this.keepRepoOnFailure)) {
        this.stage(job, 'cleanup', 'active');
        try {
          await gh.deleteRepo(owner, job.repo);
          this.stage(job, 'cleanup', 'done', 'Repository deleted');
        } catch (err) {
          this.stage(job, 'cleanup', 'failed', err.message);
          if (!failed) this.update(job, { error: `Image ready, but the temporary repository could not be deleted: ${err.message}` });
        }
      } else {
        this.stage(job, 'cleanup', 'skipped', repoCreated ? 'Kept for debugging' : 'Nothing to delete');
      }
      for (const s of job.stages) if (s.state === 'pending') s.state = 'skipped';
      const ready = !failed && job.filePath;
      this.update(job, {
        status: ready ? 'ready' : 'failed',
        expiresAt: ready ? Date.now() + this.ttlMs : null,
      });
      if (ready) setTimeout(() => this.expire(job.id), this.ttlMs).unref?.();
    }
  }

  filePath(id) {
    const j = this.jobs.get(id);
    return j && j.status === 'ready' ? j.filePath : null;
  }

  async expire(id) {
    const j = this.jobs.get(id);
    if (!j) return;
    if (j.filePath) await rm(j.filePath, { force: true });
    this.update(j, { status: 'expired', filePath: null });
  }

  async remove(id) {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.status === 'running') return false;
    if (j.filePath) await rm(j.filePath, { force: true });
    this.jobs.delete(id);
    this.emit('remove', id);
    return true;
  }

  // Deletes temp repos left behind by a crash or restart.
  async sweep({ olderThanMs = 3 * 60 * 60 * 1000 } = {}) {
    const gh = await this.getClient();
    const owner = this.owner || (await gh.viewer()).login;
    const isOrg = (await gh.ownerType(owner)) === 'Organization';
    const repos = await gh.listRepos(owner, isOrg);
    const active = new Set([...this.jobs.values()].filter((j) => j.status === 'running').map((j) => j.repo));
    const deleted = [];
    for (const r of repos) {
      if (!r.name.startsWith(REPO_PREFIX) || active.has(r.name)) continue;
      if (Date.now() - new Date(r.created_at).getTime() < olderThanMs) continue;
      await gh.deleteRepo(owner, r.name);
      deleted.push(r.name);
    }
    return deleted;
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

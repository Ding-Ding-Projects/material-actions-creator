// Build orchestration with a crash-safe journal.
//
// private:          temp private repo -> commit -> dispatch -> wait -> download -> delete repo
// encrypted-public: mint temp key -> encrypt sources -> temp public repo -> commit ->
//                   store key as Actions secret -> dispatch -> wait ->
//                   download + decrypt lap saps -> delete repo + revoke key
//
// Every stage change is written to <dataDir>/journal.json. If the app stops,
// the builds keep running on GitHub; on the next start each unfinished build is
// picked up where it was and finished (download, decrypt, clean up).
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventEmitter } from 'node:events';
import {
  renderWorkflow, readme, describe, WORKFLOW_FILE, ARTIFACT_NAME, IMAGE_FILE,
  SEALED_SOURCE, SEALED_OUTPUT, SOURCE_TARBALL, CRYPT_PATH,
} from './workflow.js';
import { listEntries, extractEntry } from './zip.js';
import { keygen, seal, open, safeRelPath } from './mac-crypt.mjs';
import { sealedBox } from './sealedbox.js';

export const REPO_PREFIX = 'mac-tmp-';
export const PUBLIC_PREFIX = 'mac-pub-';
export const REPO_TOPIC = 'material-actions-creator-temp';
const CRYPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'mac-crypt.mjs');
const MAX_UPLOAD = 50 * 1024 * 1024; // contents API request size

const STAGE_LABELS = {
  key: 'Mint temporary key',
  encrypt: 'Encrypt sources',
  repo: 'Create temporary repository',
  repoPublic: 'Create public repository',
  commit: 'Commit files and workflow',
  secret: 'Store run key as Actions secret',
  dispatch: 'Start workflow run',
  build: 'Build on GitHub Actions',
  download: 'Download lap saps',
  downloadEnc: 'Download and decrypt lap saps',
  cleanup: 'Delete temporary repository',
  cleanupEnc: 'Destroy repository and key',
};

export function stagesFor(mode) {
  const enc = mode === 'encrypted-public';
  const ids = enc
    ? ['key', 'encrypt', 'repo', 'commit', 'secret', 'dispatch', 'build', 'download', 'cleanup']
    : ['repo', 'commit', 'dispatch', 'build', 'download', 'cleanup'];
  return ids.map((id) => ({
    id,
    label: STAGE_LABELS[enc && STAGE_LABELS[`${id}Public`] ? `${id}Public` : enc && STAGE_LABELS[`${id}Enc`] ? `${id}Enc` : id],
    state: 'pending',
    detail: null,
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Interrupted extends Error {}

export class JobManager extends EventEmitter {
  constructor({
    getClient, makeClient = null, app = null, owner, dataDir, pollMs = 5000, ttlMs = 60 * 60 * 1000,
    sleepImpl = sleep, keepRepoOnFailure = false, journal = true,
  }) {
    super();
    this.getClient = getClient;
    this.makeClient = makeClient;
    this.app = app;
    this.owner = owner;
    this.dataDir = dataDir;
    this.pollMs = pollMs;
    this.ttlMs = ttlMs;
    this.sleep = sleepImpl;
    this.keepRepoOnFailure = keepRepoOnFailure;
    this.journalEnabled = journal;
    this.jobs = new Map(); // id -> public job
    this.priv = new Map(); // id -> { request, key, runId, branch, phase, keySource }
    this.recovery = null;
    this.saving = Promise.resolve();
    this.stopped = false;
  }

  get journalPath() { return join(this.dataDir, 'journal.json'); }

  // ---------- views ----------
  list() {
    return [...this.jobs.values()].map((j) => this.view(j)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this.view(j) : null;
  }

  view(j) {
    const ready = j.status === 'ready';
    return {
      ...j,
      stages: j.stages.map((s) => ({ ...s })),
      outputs: (j.outputs || []).map((o, index) => ({ index, name: o.name, size: o.size, url: ready ? `/api/builds/${j.id}/files/${index}` : null })),
      downloadUrl: ready && j.outputs?.length ? `/api/builds/${j.id}/files/0` : null,
    };
  }

  update(job, patch = {}) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    this.emit('update', this.view(job));
    this.save();
  }

  stage(job, id, state, detail) {
    const s = job.stages.find((x) => x.id === id);
    if (!s) return;
    s.state = state;
    if (detail !== undefined) s.detail = detail;
    if (state === 'active') {
      s.startedAt = Date.now();
      const p = this.priv.get(job.id);
      // Re-minting a key while resuming must not hide how far the build got.
      if (!(id === 'key' && p.phase)) p.phase = id;
    }
    if (['done', 'failed', 'skipped'].includes(state)) s.endedAt = Date.now();
    this.update(job);
  }

  // ---------- journal ----------
  save() {
    if (!this.journalEnabled) return this.saving;
    this.saving = this.saving.then(async () => {
      const data = {
        v: 1,
        savedAt: Date.now(),
        jobs: [...this.jobs.values()].map((j) => {
          const p = this.priv.get(j.id) || {};
          return { job: j, priv: { ...p, request: j.status === 'running' ? p.request : undefined, key: j.status === 'running' ? p.key : undefined } };
        }),
      };
      await mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.journalPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await rename(tmp, this.journalPath);
    }).catch((err) => this.emit('journal-error', err));
    return this.saving;
  }

  startHeartbeat(ms = 30000) {
    this.heartbeat = setInterval(() => {
      if ([...this.jobs.values()].some((j) => j.status === 'running')) this.save();
    }, ms);
    this.heartbeat.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    await this.saving;
  }

  // Loads the journal and resumes unfinished builds. Returns the recovery summary.
  async load() {
    let data;
    try { data = JSON.parse(await readFile(this.journalPath, 'utf8')); } catch { return null; }
    const resumed = [];
    for (const { job, priv } of data.jobs || []) {
      this.jobs.set(job.id, job);
      this.priv.set(job.id, priv || {});
      if (job.status === 'ready') {
        if (!job.expiresAt || job.expiresAt <= Date.now()) await this.expire(job.id);
        else setTimeout(() => this.expire(job.id), job.expiresAt - Date.now()).unref?.();
      }
      if (job.status === 'running') resumed.push(job);
    }
    if (resumed.length) {
      this.recovery = { at: Date.now(), offlineMs: Math.max(0, Date.now() - (data.savedAt || Date.now())), jobs: resumed.map((j) => j.id) };
      for (const job of resumed) {
        job.recovered = true;
        const promise = this.drive(job, { resume: true }).catch(() => {});
        Object.defineProperty(job, 'promise', { value: promise, enumerable: false, configurable: true });
      }
      this.emit('recovery', this.recoveryView());
    }
    return this.recovery;
  }

  recoveryView() {
    if (!this.recovery) return null;
    return { ...this.recovery, builds: this.recovery.jobs.map((id) => this.get(id)).filter(Boolean) };
  }

  dismissRecovery() {
    this.recovery = null;
  }

  // ---------- lifecycle ----------
  create(request) {
    const id = randomBytes(5).toString('hex');
    const enc = request.mode === 'encrypted-public';
    const { title, subtitle } = describe(request);
    const job = {
      id,
      kind: request.kind,
      mode: request.mode,
      title,
      subtitle,
      // Kept for older clients.
      imageName: request.kind === 'dockerfile' ? request.imageName : title,
      platform: request.kind === 'dockerfile' ? request.platform : request.runner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      repo: `${enc ? PUBLIC_PREFIX : REPO_PREFIX}${id}`,
      owner: null,
      runUrl: null,
      error: null,
      outputs: [],
      expiresAt: null,
      keySource: null,
      keyExpiresAt: null,
      recovered: false,
      stages: stagesFor(request.mode),
    };
    this.jobs.set(id, job);
    this.priv.set(id, { request, key: enc ? keygen() : null, phase: null });
    this.save();
    const promise = this.drive(job, { resume: false }).catch(() => {});
    Object.defineProperty(job, 'promise', { value: promise, enumerable: false, configurable: true });
    return this.view(job);
  }

  // Picks the GitHub client for this job: a freshly minted App token for
  // encrypted runs when a GitHub App is configured, else the signed-in user.
  async clientFor(job) {
    const p = this.priv.get(job.id);
    if (job.mode === 'encrypted-public' && this.app && this.makeClient) {
      const { token, expiresAt } = await this.app.mintToken();
      p.keySource = 'github-app';
      this.update(job, { keySource: 'github-app', keyExpiresAt: expiresAt });
      return { gh: this.makeClient(token), revocable: true };
    }
    if (job.mode === 'encrypted-public') this.update(job, { keySource: 'session', keyExpiresAt: null });
    return { gh: await this.getClient(), revocable: false };
  }

  async drive(job, { resume }) {
    const p = this.priv.get(job.id);
    const enc = job.mode === 'encrypted-public';
    let gh;
    let revocable = false;
    let owner = job.owner;
    let failed = false;
    let mayHaveRepo = resume;
    const stageState = (id) => job.stages.find((s) => s.id === id)?.state;
    try {
      // On resume, decide where to pick up.
      let from = 'start';
      if (resume) {
        const phase = p.phase;
        if (!phase || ['key', 'encrypt'].includes(phase)) { mayHaveRepo = false; throw new Interrupted('The app stopped before the repository was created. Run it again.'); }
        if (['repo', 'commit', 'secret'].includes(phase)) throw new Interrupted('The app stopped while the repository was being prepared. It was cleaned up; run it again.');
        from = phase === 'cleanup' ? 'cleanup' : phase === 'dispatch' ? 'dispatch' : 'build';
      }

      if (enc) this.stage(job, 'key', 'active');
      ({ gh, revocable } = await this.clientFor(job));
      if (!owner) owner = this.owner || (await (await this.getClient()).viewer()).login;
      job.owner = owner;
      if (enc && stageState('key') === 'active') this.stage(job, 'key', 'done', job.keySource === 'github-app' ? '1h installation token' : 'signed-in session');

      if (from === 'cleanup') return;
      if (from === 'start') {
        const user = await this.getClient();
        const isOrg = (await user.ownerType(owner)) === 'Organization';
        const files = await this.prepareFiles(job, user);

        this.stage(job, 'repo', 'active');
        mayHaveRepo = true;
        const repo = await gh.createRepo(owner, job.repo, {
          isOrg, isPrivate: !enc, description: `Temporary ${enc ? 'encrypted ' : ''}build (auto-deleted)`,
        });
        p.branch = repo.default_branch || 'main';
        try { await gh.setTopics(owner, job.repo, [REPO_TOPIC]); } catch { /* best effort */ }
        this.stage(job, 'repo', 'done', `${owner}/${job.repo}${enc ? ' · public' : ''}`);

        this.stage(job, 'commit', 'active');
        for (const [i, f] of files.entries()) {
          await gh.putFile(owner, job.repo, f.path, f.content, `Add ${f.path}`);
          this.stage(job, 'commit', 'active', `${i + 1}/${files.length} files`);
        }
        this.stage(job, 'commit', 'done', `${files.length} files`);

        if (enc) {
          this.stage(job, 'secret', 'active');
          const pk = await gh.secretsPublicKey(owner, job.repo);
          await gh.putSecret(owner, job.repo, 'MAC_KEY', sealedBox(p.key, pk.key), pk.key_id);
          this.stage(job, 'secret', 'done', 'MAC_KEY');
        }
      }

      let run = null;
      if (from === 'start' || from === 'dispatch') {
        this.stage(job, 'dispatch', 'active');
        if (from === 'dispatch') run = await gh.latestRun(owner, job.repo, WORKFLOW_FILE);
        if (!run) await gh.dispatchWorkflow(owner, job.repo, WORKFLOW_FILE, p.branch || 'main');
        for (let i = 0; i < 60 && !run; i++) {
          run = await gh.latestRun(owner, job.repo, WORKFLOW_FILE);
          if (!run) await this.sleep(this.pollMs);
        }
        if (!run) throw new Error('The workflow run never appeared.');
        p.runId = run.id;
        this.update(job, { runUrl: run.html_url });
        this.stage(job, 'dispatch', 'done', `Run #${run.run_number}`);
      } else {
        run = await gh.getRun(owner, job.repo, p.runId);
      }

      this.stage(job, 'build', 'active', run.status);
      while (run.status !== 'completed') {
        if (this.stopped) throw new Interrupted('stopping');
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
      const outputs = await this.collect(job, gh, owner, run.id);
      const total = outputs.reduce((n, o) => n + o.size, 0);
      this.stage(job, 'download', 'done', `${outputs.length} file${outputs.length === 1 ? '' : 's'} · ${formatBytes(total)}${enc ? ' · decrypted' : ''}`);
      this.update(job, { outputs });
    } catch (err) {
      if (err instanceof Interrupted && err.message === 'stopping') return; // app shutting down: journal resumes it
      failed = true;
      const active = job.stages.find((s) => s.state === 'active');
      if (active) this.stage(job, active.id, 'failed', err.message);
      this.update(job, { error: err.message });
    } finally {
      if (!(this.stopped && job.status === 'running' && !failed && !job.outputs?.length)) {
        await this.finish(job, { gh, revocable, owner, failed, mayHaveRepo });
      }
    }
  }

  async finish(job, { gh, revocable, owner, failed, mayHaveRepo }) {
    const enc = job.mode === 'encrypted-public';
    if (mayHaveRepo && owner && !(failed && this.keepRepoOnFailure)) {
      this.stage(job, 'cleanup', 'active');
      try {
        if (!gh) gh = await this.getClient();
        await gh.deleteRepo(owner, job.repo);
        let detail = 'Repository deleted';
        if (enc && revocable) {
          try { await gh.revokeInstallationToken(); detail += ', key revoked'; } catch { detail += ', key expires within 1h'; }
        }
        this.stage(job, 'cleanup', 'done', detail);
      } catch (err) {
        this.stage(job, 'cleanup', 'failed', err.message);
        if (!failed) this.update(job, { error: `Lap saps ready, but the temporary repository could not be deleted: ${err.message}` });
      }
    } else {
      this.stage(job, 'cleanup', 'skipped', mayHaveRepo ? 'Kept for debugging' : 'Nothing to delete');
    }
    for (const s of job.stages) if (s.state === 'pending' || s.state === 'active') s.state = 'skipped';
    const ready = !failed && job.outputs?.length > 0;
    const p = this.priv.get(job.id);
    if (p) { p.key = undefined; p.request = undefined; }
    this.update(job, { status: ready ? 'ready' : 'failed', expiresAt: ready ? Date.now() + this.ttlMs : null });
    if (ready) setTimeout(() => this.expire(job.id), this.ttlMs).unref?.();
  }

  // Builds the list of files to commit to the temporary repository.
  async prepareFiles(job, user) {
    const p = this.priv.get(job.id);
    const req = p.request;
    const enc = job.mode === 'encrypted-public';
    const work = join(this.dataDir, job.id, 'work');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    if (enc) this.stage(job, 'encrypt', 'active');
    try {
      const files = [{ path: 'README.md', content: readme(req) }];
      let plainDir = null;
      if (req.kind === 'scripts') {
        const [o, r] = req.repo.split('/');
        const res = await user.downloadTarball(o, r, req.ref);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(join(work, SOURCE_TARBALL)));
        if (!enc) files.push({ path: SOURCE_TARBALL, content: await readLimited(join(work, SOURCE_TARBALL)) });
        plainDir = work;
      } else if (enc) {
        plainDir = join(work, 'context');
        await mkdir(plainDir, { recursive: true });
        for (const f of [{ path: 'Dockerfile', content: req.dockerfile }, ...req.files]) {
          const target = join(plainDir, safeRelPath(f.path));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.content);
        }
      } else {
        files.push({ path: 'context/Dockerfile', content: req.dockerfile });
        for (const f of req.files) files.push({ path: `context/${f.path}`, content: f.content });
      }
      if (enc) {
        const sealedPath = join(work, SEALED_SOURCE);
        const globs = req.kind === 'scripts' ? [SOURCE_TARBALL] : ['**/*'];
        const packed = await seal(sealedPath, plainDir, globs, p.key);
        files.push({ path: SEALED_SOURCE, content: await readLimited(sealedPath) });
        files.push({ path: CRYPT_PATH, content: await readFile(CRYPT_SOURCE) });
        const { size } = await stat(sealedPath);
        this.stage(job, 'encrypt', 'done', `${packed.length} file${packed.length === 1 ? '' : 's'} · ${formatBytes(size)}`);
      }
      files.push({ path: `.github/workflows/${WORKFLOW_FILE}`, content: renderWorkflow(req) });
      return files;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  // Downloads the run's artifact and turns it into downloadable files.
  async collect(job, gh, owner, runId) {
    const p = this.priv.get(job.id);
    const enc = job.mode === 'encrypted-public';
    const artifacts = await gh.runArtifacts(owner, job.repo, runId);
    const artifact = artifacts.find((a) => a.name === ARTIFACT_NAME) || artifacts.find((a) => a.name === 'docker-image');
    if (!artifact) throw new Error('The run did not upload a lap sap.');
    const base = join(this.dataDir, job.id);
    const filesDir = join(base, 'files');
    await rm(filesDir, { recursive: true, force: true });
    await mkdir(filesDir, { recursive: true });
    const zipPath = join(base, 'artifact.zip');
    const res = await gh.downloadArtifact(owner, job.repo, artifact.id);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
    try {
      const entries = (await listEntries(zipPath)).filter((e) => !e.name.endsWith('/'));
      if (enc) {
        const sealedPath = join(base, SEALED_OUTPUT);
        await extractEntry(zipPath, SEALED_OUTPUT, sealedPath);
        try {
          const opened = await open(sealedPath, filesDir, p.key);
          return opened.map((f) => ({ name: f.path, size: f.size }));
        } finally {
          await rm(sealedPath, { force: true });
        }
      }
      const out = [];
      for (const e of entries) {
        const name = safeRelPath(e.name);
        const target = join(filesDir, name);
        await mkdir(dirname(target), { recursive: true });
        await extractEntry(zipPath, e.name, target);
        out.push({ name, size: (await stat(target)).size });
      }
      if (!out.length) throw new Error('The lap sap was empty.');
      return out;
    } finally {
      await rm(zipPath, { force: true });
    }
  }

  filePath(id, index = 0) {
    const j = this.jobs.get(id);
    const o = j?.status === 'ready' ? j.outputs?.[index] : null;
    return o ? join(this.dataDir, id, 'files', safeRelPath(o.name)) : null;
  }

  fileName(id, index = 0) {
    const o = this.jobs.get(id)?.outputs?.[index];
    return o ? basename(o.name) : null;
  }

  async expire(id) {
    const j = this.jobs.get(id);
    if (!j) return;
    await rm(join(this.dataDir, id), { recursive: true, force: true });
    this.update(j, { status: 'expired' });
  }

  async remove(id) {
    const j = this.jobs.get(id);
    if (!j || j.status === 'running') return false;
    await rm(join(this.dataDir, id), { recursive: true, force: true });
    this.jobs.delete(id);
    this.priv.delete(id);
    this.emit('remove', id);
    this.save();
    return true;
  }

  // Deletes temp repos left behind by a crash or restart, except journaled ones.
  async sweep({ olderThanMs = 3 * 60 * 60 * 1000 } = {}) {
    const gh = await this.getClient();
    const owner = this.owner || (await gh.viewer()).login;
    const isOrg = (await gh.ownerType(owner)) === 'Organization';
    const repos = await gh.listRepos(owner, isOrg);
    const active = new Set([...this.jobs.values()].filter((j) => j.status === 'running').map((j) => j.repo));
    const deleted = [];
    for (const r of repos) {
      if (!(r.name.startsWith(REPO_PREFIX) || r.name.startsWith(PUBLIC_PREFIX)) || active.has(r.name)) continue;
      if (Date.now() - new Date(r.created_at).getTime() < olderThanMs) continue;
      await gh.deleteRepo(owner, r.name);
      deleted.push(r.name);
    }
    return deleted;
  }
}

async function readLimited(path) {
  const { size } = await stat(path);
  if (size > MAX_UPLOAD) throw new Error(`Source is ${formatBytes(size)}; the limit is ${formatBytes(MAX_UPLOAD)}.`);
  return readFile(path);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}


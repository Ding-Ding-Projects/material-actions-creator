// Local runs: build on this computer instead of on GitHub.
//
//   - Build scripts run directly with the matching shell.
//   - A repository's own workflows run through nektos/act (MIT), which this
//     module downloads at a pinned version and checks against a pinned hash.
//   - Dockerfile builds use the local Docker.
//
// What can run depends on the host: Linux jobs run in Docker containers, or
// directly on a Linux host when there is no Docker; Windows jobs only run on
// Windows and macOS jobs only on a Mac. Jobs that cannot run are reported by
// name instead of being silently skipped.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import YAML from 'yaml';
import { listEntries, extractEntry } from './zip.js';

export const ACT = {
  version: '0.2.98',
  url: (file) => `https://github.com/nektos/act/releases/download/v0.2.98/${file}`,
  assets: {
    'linux-x64': { file: 'act_Linux_x86_64.tar.gz', sha256: 'd3344bd0810c04b000d2444030b08c90ab9fbf905bbe2c3e26298be00c620d65' },
    'linux-arm64': { file: 'act_Linux_arm64.tar.gz', sha256: 'a30ba1a1582cb93810c77f743415cac33c16f60fc288116a8e0943144b6a6a4f' },
    'darwin-x64': { file: 'act_Darwin_x86_64.tar.gz', sha256: 'a0885179705d0f3f5d27201cefa0309ac78e3fccda447ecdfb96877b66b565b0' },
    'darwin-arm64': { file: 'act_Darwin_arm64.tar.gz', sha256: '14477d7e076b12a885c54301beff2b524a905e4238a2b3ec9b3d1fd0efdc100f' },
    'win32-x64': { file: 'act_Windows_x86_64.zip', sha256: 'd0d868ee2b33bb710f4df82d69345ce3a10d2f9fc7bbee9522bf36a15779ada0' },
    'win32-arm64': { file: 'act_Windows_arm64.zip', sha256: 'c67cd28ccd1c9a9238614306a8f49c2037b7df7aa01b5d890ad671d43cbdc503' },
  },
};
// Container image act uses for Linux jobs (its "medium" default).
export const LINUX_IMAGE = 'catthehacker/ubuntu:act-latest';
const LINUX_LABELS = ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'ubuntu-20.04'];
const WINDOWS_LABELS = ['windows-latest', 'windows-2025', 'windows-2022', 'windows-2019'];
const MACOS_LABELS = ['macos-latest', 'macos-15', 'macos-14', 'macos-13'];
const HOST_OS = { linux: 'linux', win32: 'windows', darwin: 'macos' };

export class LocalError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

const sha256File = (path) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

export function osOfLabel(label) {
  const l = String(label).toLowerCase();
  if (l.startsWith('ubuntu') || l === 'linux') return 'linux';
  if (l.startsWith('windows')) return 'windows';
  if (l.startsWith('macos')) return 'macos';
  return null;
}

// Which operating systems a job asks for, from its runs-on (plain label, list,
// group form, or a matrix expression resolved against strategy.matrix).
export function jobSystems(job) {
  let runsOn = job?.['runs-on'];
  if (runsOn && typeof runsOn === 'object' && !Array.isArray(runsOn)) runsOn = runsOn.labels ?? [];
  const labels = (Array.isArray(runsOn) ? runsOn : [runsOn]).filter((x) => x !== undefined && x !== null).map(String);
  const systems = new Set();
  let unknown = false;
  for (const label of labels) {
    const m = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(label.trim());
    if (m) {
      const matrix = job.strategy?.matrix || {};
      const values = [...(Array.isArray(matrix[m[1]]) ? matrix[m[1]] : []), ...(Array.isArray(matrix.include) ? matrix.include.map((i) => i?.[m[1]]).filter(Boolean) : [])];
      if (!values.length) unknown = true;
      for (const v of values) { const os = osOfLabel(v); if (os) systems.add(os); else unknown = true; }
    } else if (label.includes('${{')) unknown = true;
    else if (label.toLowerCase() === 'self-hosted') continue;
    else { const os = osOfLabel(label); if (os) systems.add(os); else unknown = true; }
  }
  return { systems: [...systems], unknown, labels };
}

// What will happen to each job of a workflow on a host with these capabilities.
export function planWorkflow(text, caps) {
  let wf;
  try { wf = YAML.parse(text, { maxAliasCount: 100 }); } catch (err) { throw new LocalError(`Not valid YAML: ${err.message.split('\n')[0]}`, 400); }
  if (!wf?.jobs || typeof wf.jobs !== 'object') throw new LocalError('The workflow has no jobs.', 400);
  const on = wf.on ?? wf.true;
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on || {});
  const event = ['workflow_dispatch', 'push', 'pull_request'].find((e) => triggers.includes(e)) || triggers.find((t) => t !== 'workflow_call') || 'workflow_dispatch';
  const jobs = Object.entries(wf.jobs).map(([id, job]) => {
    const name = typeof job?.name === 'string' && !job.name.includes('${{') ? job.name : id;
    if (job?.uses) return { id, name, systems: [], how: 'reusable', runnable: true, partial: false, reason: null };
    const { systems, unknown } = jobSystems(job || {});
    const can = systems.filter((s) => caps.canRun[s]);
    const cannot = systems.filter((s) => !caps.canRun[s]);
    const how = can.map((s) => caps.canRun[s]);
    let reason = null;
    if (cannot.length) reason = cannot.map((s) => (s === 'windows' ? 'Windows jobs need a Windows computer' : s === 'macos' ? 'macOS jobs need a Mac' : 'Linux jobs need Docker, or a Linux computer')).join('; ');
    else if (unknown && !systems.length) reason = 'The runner label is not one this computer knows how to provide';
    return { id, name, systems, how: [...new Set(how)].join('+') || null, runnable: can.length > 0, partial: can.length > 0 && cannot.length > 0, reason };
  });
  return { event, triggers, jobs, runnable: jobs.filter((j) => j.runnable).length, skipped: jobs.filter((j) => !j.runnable).length };
}

// Removes steps that would publish somewhere. Locally they have no sign-in
// values and would fail, and nothing should leave this computer anyway.
const PUBLISH_RE = /^(softprops\/action-gh-release|actions\/create-release|actions\/upload-release-asset|ncipollo\/release-action|marvinpinto\/action-automatic-releases|svenstaro\/upload-release-action|peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|actions\/deploy-pages|actions\/upload-pages-artifact|pypa\/gh-action-pypi-publish|JS-DevTools\/npm-publish|stefanzweifel\/git-auto-commit-action|EndBug\/add-and-commit|peter-evans\/create-pull-request|actions\/attest-build-provenance|docker\/login-action)@/i;
export function localWorkflow(text) {
  const wf = YAML.parse(text, { maxAliasCount: 100 });
  const removed = [];
  for (const [id, job] of Object.entries(wf.jobs || {})) {
    if (!Array.isArray(job?.steps)) continue;
    job.steps = job.steps.filter((s) => {
      if (typeof s?.uses === 'string' && PUBLISH_RE.test(s.uses)) { removed.push(`${id}: ${s.name || s.uses}`); return false; }
      return true;
    });
  }
  if (wf.true !== undefined && wf.on === undefined) { wf.on = wf.true; delete wf.true; }
  return { yaml: YAML.stringify(wf, { lineWidth: 0 }), removed };
}

// Arguments for one act run.
export function actArgs({ event, workflow, artifactDir, caps }) {
  const args = [event, '-W', workflow, '--artifact-server-path', artifactDir];
  const map = (labels, value) => { for (const l of labels) args.push('-P', `${l}=${value}`); };
  if (caps.canRun.linux === 'container') map(LINUX_LABELS, LINUX_IMAGE);
  else if (caps.canRun.linux === 'host') map(LINUX_LABELS, '-self-hosted');
  if (caps.canRun.windows === 'host') map(WINDOWS_LABELS, '-self-hosted');
  if (caps.canRun.macos === 'host') map(MACOS_LABELS, '-self-hosted');
  return args;
}

// Step starts and results from act's log lines, for the timing chart.
export function parseActLine(line) {
  const clean = line.replace(/\u001b\[[0-9;]*m/g, '');
  const m = /^\[([^\]]+)\]\s+(⭐\s+Run|✅\s+Success -|❌\s+Failure -)\s+(?:(Pre|Main|Post|Complete)\s+)?(.+?)(?:\s+\[[\d.a-zµ]+\])?\s*$/u.exec(clean);
  if (!m) return null;
  const kind = m[2].startsWith('⭐') ? 'start' : m[2].startsWith('✅') ? 'success' : 'failure';
  return { job: m[1].trim(), kind, phase: m[3] || 'Main', name: m[4].trim() };
}

export class LocalRunner {
  constructor({ toolsDir, env = process.env, fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch } = {}) {
    Object.assign(this, { toolsDir, env, fetchImpl, platform, arch });
    this.installing = null;
    this.progress = null;
  }

  which(program) {
    const r = spawnSync(this.platform === 'win32' ? 'where' : 'which', [program], { env: this.env, encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
  }

  managedActPath() { return join(this.toolsDir, `act-${ACT.version}`, this.platform === 'win32' ? 'act.exe' : 'act'); }

  findAct() {
    if (this.env.MAC_ACT_PATH && existsSync(this.env.MAC_ACT_PATH)) return { path: this.env.MAC_ACT_PATH, source: 'setting' };
    if (existsSync(this.managedActPath())) return { path: this.managedActPath(), source: 'managed' };
    const onPath = this.which('act');
    return onPath ? { path: onPath, source: 'path' } : null;
  }

  containers() {
    if (this.env.MAC_LOCAL_CONTAINERS === 'off') return null;
    const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env: this.env, encoding: 'utf8', timeout: 8000 });
    return r.status === 0 && r.stdout.trim() ? { engine: 'docker', version: r.stdout.trim() } : null;
  }

  capabilities() {
    const host = HOST_OS[this.platform] || this.platform;
    const act = this.findAct();
    const containers = this.containers();
    const asset = ACT.assets[`${this.platform}-${this.arch}`];
    const shells = { sh: Boolean(this.which('sh')), bash: Boolean(this.which('bash')), pwsh: Boolean(this.which('pwsh')), cmd: this.platform === 'win32' };
    return {
      host, arch: this.arch,
      act: { installed: Boolean(act), path: act?.path || null, source: act?.source || null, version: ACT.version, installable: Boolean(asset), installing: Boolean(this.installing), progress: this.progress },
      containers, shells,
      canRun: { linux: containers ? 'container' : host === 'linux' ? 'host' : false, windows: host === 'windows' ? 'host' : false, macos: host === 'macos' ? 'host' : false },
    };
  }

  // Downloads the pinned runner program once, checks its hash and unpacks it.
  ensureAct(onProgress = () => {}) {
    const found = this.findAct();
    if (found) return Promise.resolve(found.path);
    this.installing ||= this.installAct(onProgress).finally(() => { this.installing = null; this.progress = null; });
    return this.installing;
  }

  async installAct(onProgress) {
    const asset = ACT.assets[`${this.platform}-${this.arch}`];
    if (!asset) throw new LocalError(`There is no runner program for ${this.platform} ${this.arch}. Install "act" yourself and put it on the PATH.`);
    const dir = join(this.toolsDir, `act-${ACT.version}`);
    const tmp = `${dir}.download`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const archive = join(tmp, asset.file);
    try {
      let res;
      try { res = await this.fetchImpl(ACT.url(asset.file), { redirect: 'follow' }); } catch (err) { throw new LocalError(`The runner program could not be downloaded (${err.message}). Check the network, or install "act" yourself.`, 502); }
      if (!res.ok || !res.body) throw new LocalError(`The runner program could not be downloaded (HTTP ${res.status}).`, 502);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (c) => { got += c.length; this.progress = { got, total }; onProgress(this.progress); });
      await pipeline(body, createWriteStream(archive));
      const sum = await sha256File(archive);
      if (sum !== asset.sha256) throw new LocalError(`The downloaded runner program does not match its expected hash, so it was deleted. Expected ${asset.sha256.slice(0, 12)}…, got ${sum.slice(0, 12)}….`, 502);
      const name = this.platform === 'win32' ? 'act.exe' : 'act';
      if (asset.file.endsWith('.zip')) {
        if (!(await listEntries(archive)).some((e) => e.name === name)) throw new LocalError('The runner archive does not contain the program.', 502);
        await extractEntry(archive, name, join(tmp, name), { maxBytes: 200 * 1024 * 1024 });
      } else {
        const r = spawnSync('tar', ['-xzf', archive, '-C', tmp, name], { env: this.env, timeout: 60_000 });
        if (r.status !== 0) throw new LocalError('The runner archive could not be unpacked (is "tar" installed?).', 500);
      }
      await rm(archive, { force: true });
      await chmod(join(tmp, name), 0o755);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      return join(dir, name);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  // The shell command for one build script on this host, or a LocalError.
  scriptCommand(script) {
    const ext = script.toLowerCase().split('.').pop();
    const path = script.replace(/\\/g, '/');
    if (ext === 'sh') {
      if (this.platform === 'win32' && !this.which('bash')) throw new LocalError(`${script} needs bash, which was not found on this Windows computer.`);
      return { command: this.which('bash') ? 'bash' : 'sh', args: [path] };
    }
    if (ext === 'ps1') {
      const ps = this.which('pwsh') ? 'pwsh' : this.platform === 'win32' ? 'powershell' : null;
      if (!ps) throw new LocalError(`${script} needs PowerShell (pwsh), which is not installed on this computer.`);
      return { command: ps, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path] };
    }
    if (this.platform !== 'win32') throw new LocalError(`${script} is a Windows batch file and only runs on a Windows computer.`);
    return { command: 'cmd.exe', args: ['/d', '/c', script.replace(/\//g, '\\')] };
  }

  // Environment for local runs: the host's, minus anything that signs in.
  runEnv(extra = {}) {
    const env = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (/TOKEN|SECRET|PASSWORD|ACCESS_KEY|PRIVATE_KEY|^GH_|^GITHUB_|^MAC_|^APP_ACCESS/i.test(k)) continue;
      env[k] = v;
    }
    return { ...env, CI: 'true', ...extra };
  }

  // Runs a program, streaming its combined output to onLine. Resolves the exit code.
  exec(command, args, { cwd, env, onLine = () => {}, signal } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(command, args, { cwd, env: env || this.runEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { reject(new LocalError(`Could not start ${command}: ${err.message}`)); return; }
      const feed = (stream) => {
        let rest = '';
        stream.setEncoding('utf8');
        stream.on('data', (c) => { const parts = (rest + c).split(/\r?\n/); rest = parts.pop(); for (const l of parts) onLine(l); });
        stream.on('end', () => { if (rest) onLine(rest); });
      };
      feed(child.stdout); feed(child.stderr);
      const abort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref?.(); };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', (err) => reject(new LocalError(err.code === 'ENOENT' ? `Program not found: ${command}` : `Could not start ${command}: ${err.message}`)));
      child.on('close', (code, sig) => { signal?.removeEventListener('abort', abort); resolve(code ?? (sig ? 143 : 1)); });
    });
  }
}

// Unpacks every artifact act's artifact server saved under dir into destDir.
// Returns [{ name, path, size }] with names like "<artifact>/<file>".
export async function collectArtifacts(dir, destDir, { maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const out = [];
  let budget = maxBytes;
  const walk = async (d) => {
    let names = [];
    try { names = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.zip')) continue;
      const artifact = e.name.replace(/\.zip$/i, '');
      for (const entry of (await listEntries(p)).filter((x) => !x.name.endsWith('/'))) {
        const rel = entry.name.replace(/\\/g, '/');
        if (rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) continue;
        const dest = join(destDir, artifact, rel);
        await mkdir(join(dest, '..'), { recursive: true });
        const { size } = await extractEntry(p, entry.name, dest, { maxBytes: budget });
        budget -= size;
        out.push({ name: `${artifact}/${rel}`, path: dest, size: (await stat(dest)).size });
      }
    }
  };
  await walk(dir);
  return out;
}

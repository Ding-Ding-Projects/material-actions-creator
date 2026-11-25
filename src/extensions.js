// Extension host. An extension is a folder with a manifest.json and any
// program that speaks the protocol below. It runs as a separate process:
//
//   host  -> stdin : one JSON line  {"protocol":1,"hook":"...","extension":{id,version},"payload":{...}}
//   ext   -> stdout: one JSON line  {"ok":true,"result":{...}}  or  {"ok":false,"error":"..."}
//
// The host enforces a time limit and an output size limit, starts the process
// with a minimal environment (no sign-in values, HOME pointed at the
// extension's own data folder), and only puts data in the payload that the
// user has approved for that extension. This is not an operating-system
// sandbox: an extension is still a program running as the same user.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { readFile, readdir, writeFile, mkdir, rename, rm, cp, mkdtemp, stat, lstat } from 'node:fs/promises';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { listEntries, extractEntry } from './zip.js';

export const PROTOCOL = 1;
export const MANIFEST_VERSION = 1;
export const HOOKS = ['build.finished', 'workflow.lint', 'command'];
export const PERMISSIONS = {
  'build:read': 'Build details: title, mode, status, timing and stage names.',
  'outputs:read': 'Output files: names, sizes and where the decrypted files are on this computer.',
  'workflow:read': 'Workflow text: the generated workflow YAML being previewed.',
  network: 'Network access. Only enforced when extensions run sandboxed; without a sandbox every extension can reach the network.',
};
const UPLOAD = { maxFiles: 200, maxBytes: 5 * 1024 * 1024 };
export const LIMITS = { timeoutMs: { default: 10_000, max: 60_000 }, maxOutputBytes: { default: 256 * 1024, max: 1024 * 1024 } };
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST = 32 * 1024;

export class ManifestError extends Error {}

// Returns a normalised manifest or throws ManifestError naming the first problem.
export function validateManifest(raw, folderName) {
  const fail = (msg) => { throw new ManifestError(msg); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The manifest must be a JSON object.');
  if (raw.manifestVersion !== MANIFEST_VERSION) fail(`manifestVersion must be ${MANIFEST_VERSION}.`);
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) fail('id must be 2-40 lowercase letters, digits or dashes.');
  if (folderName !== undefined && raw.id !== folderName) fail(`id "${raw.id}" must match its folder name "${folderName}".`);
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) fail('name is required (60 characters at most).');
  if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) fail('version must look like 1.2.3.');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 300)) fail('description must be text (300 characters at most).');
  const run = raw.run;
  if (!run || typeof run !== 'object' || typeof run.command !== 'string' || !run.command) fail('run.command is required.');
  const cmd = run.command;
  const local = cmd.startsWith('./');
  if (local ? (cmd.includes('..') || cmd.includes('\\') || cmd.length < 3) : !/^[A-Za-z0-9._+-]+$/.test(cmd)) fail('run.command must be a program name (found on PATH) or a ./relative path inside the extension folder.');
  const args = run.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 500)) fail('run.args must be a list of up to 32 strings.');
  const hooks = raw.hooks;
  if (!Array.isArray(hooks) || !hooks.length || hooks.some((h) => !HOOKS.includes(h))) fail(`hooks must list at least one of: ${HOOKS.join(', ')}.`);
  const permissions = raw.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some((p) => !Object.hasOwn(PERMISSIONS, p))) fail(`permissions may only contain: ${Object.keys(PERMISSIONS).join(', ')}.`);
  const lim = raw.limits ?? {};
  const limits = {};
  for (const [k, spec] of Object.entries(LIMITS)) {
    const v = lim[k] ?? spec.default;
    if (!Number.isInteger(v) || v < 1 || v > spec.max) fail(`limits.${k} must be a whole number from 1 to ${spec.max}.`);
    limits[k] = v;
  }
  const command = raw.command;
  if (command !== undefined && (typeof command !== 'object' || typeof command.title !== 'string' || command.title.length > 60)) fail('command.title must be text (60 characters at most).');
  return {
    manifestVersion: MANIFEST_VERSION, id: raw.id, name: raw.name.trim(), version: raw.version,
    description: raw.description || '', author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : '',
    run: { command: cmd, args }, hooks: [...new Set(hooks)], permissions: [...new Set(permissions)].sort(), limits,
    command: command ? { title: command.title, inputLabel: typeof command.inputLabel === 'string' ? command.inputLabel.slice(0, 80) : '' } : null,
  };
}

// Keeps a result small and plain so it is safe to store, send and render.
export function cleanResult(r) {
  const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  if (!r || typeof r !== 'object') return {};
  const out = {};
  if (text(r.title, 200)) out.title = text(r.title, 200);
  if (text(r.summary, 20_000)) out.summary = text(r.summary, 20_000);
  if (Array.isArray(r.items)) out.items = r.items.slice(0, 200).filter((i) => i && typeof i === 'object').map((i) => ({ label: text(String(i.label ?? ''), 300), value: text(String(i.value ?? ''), 2000) }));
  if (Array.isArray(r.findings)) {
    out.findings = r.findings.slice(0, 200).filter((f) => f && typeof f === 'object').map((f) => ({
      level: ['error', 'warning', 'info'].includes(f.level) ? f.level : 'info', message: text(String(f.message ?? ''), 1000),
      ...(Number.isInteger(f.line) ? { line: f.line } : {}),
    }));
  }
  return out;
}

const under = (child, parent) => { const c = resolve(child); const p = resolve(parent); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };

// Arguments for bubblewrap: a read-only system, no home folder, no app data,
// no network unless allowed, and only the extension's own folders plus the
// output files it was granted. Pure, so it can be tested without bubblewrap.
export function bwrapArgs({ dir, home, hide = [], tools = [], outputs = [], network = false, command, args = [] }) {
  const hidden = [...new Set(hide.filter((h) => h && resolve(h) !== '/').map((h) => resolve(h)))].sort((x, y) => x.length - y.length);
  const out = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (network) out.push('--share-net');
  out.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  for (const h of hidden) out.push('--tmpfs', h);
  // Programs installed under a hidden folder or under /tmp (a per-user Node.js,
  // an unpacked AppImage) are put back read-only; anything hidden inside them is hidden again.
  for (const t of tools) {
    out.push('--ro-bind', t, t);
    for (const h of hidden) if (under(h, t)) out.push('--tmpfs', h);
  }
  out.push('--ro-bind', dir, dir, '--bind', home, home);
  for (const o of outputs) out.push('--ro-bind', o, o);
  out.push('--chdir', dir, '--', command, ...args);
  return out;
}

// PATH folders that the sandbox would hide, so they can be put back. A Node.js
// prefix (bin next to lib/node_modules) is put back whole.
export function toolDirs(pathDirs, hidden) {
  const out = new Set();
  for (const d of pathDirs) {
    const dirPath = resolve(d);
    if (!existsSync(dirPath) || !hidden.some((h) => h && under(dirPath, h) && dirPath !== resolve(h))) continue;
    out.add(basename(dirPath) === 'bin' && existsSync(join(dirname(dirPath), 'lib', 'node_modules')) ? dirname(dirPath) : dirPath);
  }
  return [...out];
}

export class ExtensionHost extends EventEmitter {
  // dirs: [{ path, source: 'builtin' | 'user' }]
  constructor({ dirs = [], dataDir, env = process.env, samplesDir = null, hide = [] } = {}) {
    super();
    this.samplesDir = samplesDir;
    this.hide = hide;
    this.isolation = null;
    this.dirs = dirs;
    this.dataDir = dataDir;
    this.stateFile = dataDir ? join(dataDir, 'extensions.json') : null;
    this.env = env;
    this.exts = new Map();
    this.state = {};
    this.broken = [];
    this.running = new Map();
  }

  // Decides once whether bubblewrap can be used here. MAC_EXTENSION_ISOLATION:
  // "off" never sandboxes, "require" refuses to run extensions without it,
  // anything else uses it when it works.
  detectIsolation() {
    if (this.isolation) return this.isolation;
    const want = String(this.env.MAC_EXTENSION_ISOLATION || 'auto').toLowerCase();
    let mode = 'none';
    let reason = 'off';
    if (want !== 'off') {
      if (process.platform !== 'linux') reason = 'not-linux';
      else {
        const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', 'true'], { env: { PATH: this.env.PATH || '/usr/bin:/bin' }, timeout: 5000, stdio: 'ignore' });
        if (probe.error?.code === 'ENOENT') reason = 'not-installed';
        else if (probe.status === 0) { mode = 'bwrap'; reason = 'ok'; } else reason = 'not-permitted';
      }
    }
    this.isolation = { mode, reason, required: want === 'require' };
    return this.isolation;
  }

  userDir() { return this.dirs.find((d) => d.source === 'user')?.path || null; }

  // Bundled samples that can be added with one click.
  async gallery() {
    if (!this.samplesDir) return [];
    let names = [];
    try { names = (await readdir(this.samplesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
    const out = [];
    for (const name of names) {
      try {
        const m = validateManifest(JSON.parse(await readFile(join(this.samplesDir, name, 'manifest.json'), 'utf8')), name);
        out.push({ id: m.id, name: m.name, version: m.version, description: m.description, program: m.run.command, permissions: m.permissions, hooks: m.hooks, installed: this.exts.has(m.id) });
      } catch { /* a broken sample is not offered */ }
    }
    return out;
  }

  async installSample(id) {
    if (!ID.test(String(id))) throw Object.assign(new Error('Unknown sample.'), { status: 404 });
    const from = join(this.samplesDir || '', id);
    try { await stat(join(from, 'manifest.json')); } catch { throw Object.assign(new Error('Unknown sample.'), { status: 404 }); }
    return this.installFolder(from, id);
  }

  // Unpacks an uploaded zip into a scratch folder, checks it, then installs it.
  async installZip(zipPath) {
    const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
    let entries;
    try { entries = (await listEntries(zipPath)).filter((e) => !e.name.endsWith('/')); } catch { fail('That file is not a zip archive.'); }
    if (!entries.length) fail('The zip is empty.');
    if (entries.length > UPLOAD.maxFiles) fail(`The zip has more than ${UPLOAD.maxFiles} files.`);
    if (entries.reduce((n, e) => n + e.uncompressedSize, 0) > UPLOAD.maxBytes) fail('The zip unpacks to more than 5 MB.');
    const top = entries.every((e) => e.name.includes('/')) && new Set(entries.map((e) => e.name.split('/')[0])).size === 1 ? `${entries[0].name.split('/')[0]}/` : '';
    const scratch = await mkdtemp(join(tmpdir(), 'mac-ext-'));
    try {
      let budget = UPLOAD.maxBytes;
      for (const e of entries) {
        const rel = e.name.slice(top.length);
        if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((part) => part === '..' || part === '')) fail(`Unsafe path in the zip: ${e.name}`);
        const dest = join(scratch, rel);
        if (!under(dest, scratch)) fail(`Unsafe path in the zip: ${e.name}`);
        await mkdir(dirname(dest), { recursive: true });
        try { budget -= (await extractEntry(zipPath, e.name, dest, { maxBytes: budget })).size; } catch (err) { fail(`Could not unpack ${rel}: ${err.message}`); }
      }
      let manifest;
      try { manifest = validateManifest(JSON.parse(await readFile(join(scratch, 'manifest.json'), 'utf8'))); } catch (err) { fail(err instanceof ManifestError ? err.message : 'The zip has no valid manifest.json at its top level.'); }
      return await this.installFolder(scratch, manifest.id);
    } finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }

  async installFolder(from, id) {
    const userDir = this.userDir();
    if (!userDir) throw Object.assign(new Error('This server has no folder for added extensions.'), { status: 409 });
    if (this.exts.get(id)?.source === 'builtin') throw Object.assign(new Error(`"${id}" is a built-in extension and cannot be replaced.`), { status: 409 });
    const dest = join(userDir, id);
    await mkdir(userDir, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(from, dest, { recursive: true, dereference: false, filter: async (src) => !(await lstat(src)).isSymbolicLink() });
    await this.scan();
    if (!this.exts.has(id)) throw Object.assign(new Error(this.broken.find((b) => b.folder === id)?.error || 'The extension could not be loaded.'), { status: 400 });
    return this.view(id);
  }

  async uninstall(id) {
    const e = this.exts.get(id);
    if (!e) throw Object.assign(new Error('Extension not found.'), { status: 404 });
    if (e.source !== 'user') throw Object.assign(new Error('Built-in extensions cannot be removed. Turn it off instead.'), { status: 409 });
    await rm(e.dir, { recursive: true, force: true });
    delete this.state[id];
    await this.save();
    await this.scan();
  }

  async load() {
    if (this.stateFile) {
      try { this.state = JSON.parse(await readFile(this.stateFile, 'utf8')); } catch { this.state = {}; }
    }
    await this.scan();
    return this;
  }

  async scan() {
    const found = new Map();
    const broken = [];
    for (const { path, source } of this.dirs) {
      let names = [];
      try { names = (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { continue; }
      for (const name of names) {
        const dir = join(path, name);
        try {
          const text = await readFile(join(dir, 'manifest.json'), 'utf8');
          if (Buffer.byteLength(text) > MAX_MANIFEST) throw new ManifestError('The manifest is larger than 32 KB.');
          let raw;
          try { raw = JSON.parse(text); } catch { throw new ManifestError('manifest.json is not valid JSON.'); }
          const manifest = validateManifest(raw, name);
          if (found.has(manifest.id)) throw new ManifestError(`Another extension already uses the id "${manifest.id}".`);
          found.set(manifest.id, { manifest, dir, source });
        } catch (err) {
          if (err.code === 'ENOENT') continue; // a folder without a manifest is not an extension
          broken.push({ folder: name, source, error: err.message });
        }
      }
    }
    this.exts = found;
    this.broken = broken;
    let changed = false;
    for (const { manifest, source } of found.values()) {
      if (this.state[manifest.id]) continue;
      // Built-in extensions ship with the app: on first sight they are on with
      // the permissions they shipped with. Anything else starts off.
      this.state[manifest.id] = source === 'builtin'
        ? { enabled: true, granted: manifest.permissions, grantedVersion: manifest.version }
        : { enabled: false, granted: [], grantedVersion: null };
      changed = true;
    }
    if (changed) await this.save();
    this.emit('change');
  }

  // Saves are queued: two overlapping writes would fight over the same
  // temporary file and one of them would fail.
  save() {
    if (!this.stateFile) return Promise.resolve();
    const write = async () => {
      await mkdir(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 1));
      await rename(tmp, this.stateFile);
    };
    this.saving = (this.saving || Promise.resolve()).then(write, write);
    return this.saving;
  }

  pendingPermissions(id) {
    const e = this.exts.get(id);
    const granted = new Set(this.state[id]?.granted || []);
    return e ? e.manifest.permissions.filter((p) => !granted.has(p)) : [];
  }

  // A first run always needs a yes, even with no permissions: turning an
  // extension on means letting its program run.
  needsConsent(id) {
    return this.pendingPermissions(id).length > 0 || !this.state[id]?.grantedVersion;
  }

  view(id) {
    const e = this.exts.get(id);
    if (!e) return null;
    const s = this.state[id] || {};
    const pending = this.pendingPermissions(id);
    return {
      ...e.manifest, source: e.source,
      enabled: Boolean(s.enabled) && !this.needsConsent(id),
      wantsEnabled: Boolean(s.enabled),
      granted: s.granted || [], grantedVersion: s.grantedVersion || null,
      pendingPermissions: pending, needsConsent: this.needsConsent(id),
      lastRun: s.lastRun || null,
    };
  }

  list() {
    return { extensions: [...this.exts.keys()].map((id) => this.view(id)), broken: this.broken, hooks: HOOKS, permissions: PERMISSIONS, limits: LIMITS, protocol: PROTOCOL, isolation: this.detectIsolation() };
  }

  // grant must repeat the exact permission list the user was shown, so consent
  // can never cover a manifest that changed in between.
  async configure(id, { enabled, grant } = {}) {
    const e = this.exts.get(id);
    if (!e) throw Object.assign(new Error('Extension not found.'), { status: 404 });
    const s = this.state[id] ||= { enabled: false, granted: [], grantedVersion: null };
    if (grant !== undefined) {
      const want = [...e.manifest.permissions];
      if (!Array.isArray(grant) || [...grant].sort().join() !== want.join()) {
        throw Object.assign(new Error('The permission list changed. Review it again before allowing.'), { status: 409 });
      }
      s.granted = want;
      s.grantedVersion = e.manifest.version;
    }
    if (enabled !== undefined) {
      if (enabled && this.needsConsent(id)) throw Object.assign(new Error('This extension needs its permissions allowed before it can be turned on.'), { status: 409 });
      s.enabled = Boolean(enabled);
    }
    await this.save();
    this.emit('change');
    return this.view(id);
  }

  // Only what the granted permissions cover goes into the payload.
  payloadFor(hook, granted, ctx = {}) {
    const p = {};
    const has = (k) => granted.includes(k);
    if (ctx.build && has('build:read')) {
      const b = ctx.build;
      p.build = { id: b.id, kind: b.kind, mode: b.mode, title: b.title, subtitle: b.subtitle, platform: b.platform, status: b.status, createdAt: b.createdAt, updatedAt: b.updatedAt, error: b.error || null, stages: (b.stages || []).map((s) => ({ id: s.id, label: s.label, state: s.state })), outputCount: (b.outputs || []).length };
    }
    if (ctx.outputs && has('outputs:read')) p.outputs = ctx.outputs.map((o) => ({ name: o.name, size: o.size, path: o.path }));
    if (typeof ctx.yaml === 'string' && has('workflow:read')) p.workflow = { yaml: ctx.yaml };
    if (hook === 'command' && typeof ctx.input === 'string') p.input = ctx.input.slice(0, 100_000);
    return p;
  }

  async run(id, hook, ctx = {}) {
    const e = this.exts.get(id);
    if (!e) throw Object.assign(new Error('Extension not found.'), { status: 404 });
    const v = this.view(id);
    if (!v.enabled) throw Object.assign(new Error(v.needsConsent ? 'This extension is waiting for its permissions to be allowed.' : 'This extension is turned off.'), { status: 409 });
    if (!e.manifest.hooks.includes(hook)) throw Object.assign(new Error(`This extension does not handle "${hook}".`), { status: 400 });
    const payload = this.payloadFor(hook, v.granted, ctx);
    // One run at a time per extension; later requests wait their turn.
    const prev = this.running.get(id) || Promise.resolve();
    let release;
    const turn = new Promise((r) => { release = r; });
    this.running.set(id, prev.then(() => turn));
    await prev;
    const started = Date.now();
    let outcome;
    try {
      outcome = await this.exec(e, { protocol: PROTOCOL, hook, extension: { id, version: e.manifest.version }, payload }, { outputs: (payload.outputs || []).map((o) => o.path), network: v.granted.includes('network') });
    } finally { release(); }
    const record = { at: started, hook, ms: Date.now() - started, bytes: outcome.bytes, sandboxed: Boolean(outcome.sandboxed), ok: outcome.ok, error: outcome.error || null, result: outcome.result || null, ...(ctx.build ? { buildId: ctx.build.id } : {}) };
    this.state[id].lastRun = record;
    await this.save().catch(() => {});
    this.emit('run', { id, name: e.manifest.name, ...record });
    return record;
  }

  // Runs every enabled extension that handles the hook, one after another.
  async dispatch(hook, ctx = {}) {
    const results = [];
    for (const [id, e] of this.exts) {
      if (!e.manifest.hooks.includes(hook) || !this.view(id).enabled) continue;
      try { results.push({ id, ...(await this.run(id, hook, ctx)) }); } catch (err) { results.push({ id, ok: false, error: err.message }); }
    }
    return results;
  }

  async exec(e, message, { outputs = [], network = false } = {}) {
    const { manifest, dir } = e;
    const home = this.dataDir ? join(this.dataDir, 'extension-data', manifest.id) : dir;
    await mkdir(home, { recursive: true }).catch(() => {});
    const env = { PATH: this.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: this.env.LANG || 'C.UTF-8', MAC_EXTENSION_ID: manifest.id, MAC_EXTENSION_DATA: home, MAC_PROTOCOL: String(PROTOCOL) };
    if (this.env.SystemRoot) env.SystemRoot = this.env.SystemRoot; // Windows needs it to start programs
    let command = manifest.run.command.startsWith('./') ? join(dir, manifest.run.command) : manifest.run.command;
    let argv = manifest.run.args;
    const iso = this.detectIsolation();
    if (iso.mode === 'bwrap') {
      // Only folders that exist can be hidden or put back.
      const hide = [homedir(), this.env.HOME, this.dataDir, ...this.hide].filter((h) => h && existsSync(h));
      argv = bwrapArgs({ dir, home, hide, tools: toolDirs(env.PATH.split(':').filter(Boolean), [...hide, '/tmp']), outputs: outputs.filter((o) => existsSync(o)), network, command, args: manifest.run.args });
      command = 'bwrap';
    } else if (iso.required) {
      return { ok: false, error: 'Extensions are set to run only in a sandbox, and no sandbox is available on this computer.', bytes: 0 };
    }
    return new Promise((resolve) => {
      let child;
      try { child = spawn(command, argv, { cwd: dir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) { resolve({ ok: false, error: `Could not start: ${err.message}`, bytes: 0 }); return; }
      const chunks = [];
      let bytes = 0;
      let err = '';
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ bytes, sandboxed: iso.mode === 'bwrap', ...r }); };
      const timer = setTimeout(() => finish({ ok: false, error: `Stopped after ${manifest.limits.timeoutMs / 1000} s (time limit).` }), manifest.limits.timeoutMs);
      child.on('error', (e2) => finish({ ok: false, error: e2.code === 'ENOENT' ? `Program not found: ${manifest.run.command}` : `Could not start: ${e2.message}` }));
      child.stdout.on('data', (c) => {
        bytes += c.length;
        if (bytes > manifest.limits.maxOutputBytes) { finish({ ok: false, error: `Stopped: output passed ${manifest.limits.maxOutputBytes} bytes (size limit).` }); return; }
        chunks.push(c);
      });
      child.stderr.on('data', (c) => { if (err.length < 4000) err += c.toString('utf8').slice(0, 4000 - err.length); });
      child.stdin.on('error', () => { /* the program exited without reading */ });
      child.on('close', (code) => {
        const line = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).pop() || '';
        let reply;
        if (/^bwrap: execvp .*No such file or directory/m.test(err)) { finish({ ok: false, error: `Program not found: ${manifest.run.command}` }); return; }
        try { reply = JSON.parse(line); } catch { finish({ ok: false, error: code ? `Exited with code ${code}. ${err.trim().slice(0, 500)}`.trim() : 'The reply was not one line of JSON.' }); return; }
        if (!reply || typeof reply !== 'object' || reply.ok !== true) { finish({ ok: false, error: String(reply?.error || `Exited with code ${code}.`).slice(0, 1000) }); return; }
        finish({ ok: true, result: cleanResult(reply.result) });
      });
      child.stdin.end(`${JSON.stringify(message)}\n`);
    });
  }
}

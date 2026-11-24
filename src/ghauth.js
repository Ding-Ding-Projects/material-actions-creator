// Assisted GitHub CLI login: drives `gh auth login --web` (device flow) with the
// scopes this app needs, surfaces the one-time code to the UI, and reads the
// resulting token with `gh auth token`.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const REQUIRED_SCOPES = ['repo', 'workflow', 'delete_repo'];
export const OPTIONAL_SCOPES = ['read:org'];

const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const URL_RE = /(https:\/\/[^\s]+\/login\/device)/;

export function parseDeviceOutput(text) {
  const code = text.match(CODE_RE)?.[1] || null;
  const url = text.match(URL_RE)?.[1] || (code ? 'https://github.com/login/device' : null);
  return { code, url };
}

export function missingScopes(scopes) {
  return REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
}

export class GhAuth extends EventEmitter {
  constructor({ ghBin = process.env.GH_BIN || 'gh', hostname = 'github.com', env = process.env, spawnImpl = spawn, execFileImpl = execFile } = {}) {
    super();
    this.ghBin = ghBin;
    this.hostname = hostname;
    this.env = env;
    this.spawn = spawnImpl;
    this.execFile = execFileImpl;
    this.flow = null; // { state, code, url, error, startedAt, mode }
    this.child = null;
  }

  childEnv() {
    const env = { ...this.env, BROWSER: 'true', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    // An injected token would shadow the login we are about to make.
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    return env;
  }

  async available() {
    return new Promise((resolve) => {
      this.execFile(this.ghBin, ['--version'], { env: this.childEnv() }, (err, stdout) => {
        resolve(err ? null : String(stdout).split('\n')[0].trim());
      });
    });
  }

  async token() {
    return new Promise((resolve) => {
      this.execFile(this.ghBin, ['auth', 'token', '--hostname', this.hostname], { env: this.childEnv() }, (err, stdout) => {
        const t = String(stdout || '').trim();
        resolve(err || !t ? null : t);
      });
    });
  }

  status() {
    return this.flow ? { ...this.flow } : { state: 'idle' };
  }

  // mode: "login" for a fresh login, "refresh" to add scopes to an existing one.
  start(mode = 'login') {
    if (this.flow && ['starting', 'waiting'].includes(this.flow.state)) return this.status();
    const scopes = [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES].join(',');
    const args = mode === 'refresh'
      ? ['auth', 'refresh', '--hostname', this.hostname, '--scopes', scopes]
      : ['auth', 'login', '--hostname', this.hostname, '--git-protocol', 'https', '--web', '--scopes', scopes];
    this.flow = { state: 'starting', mode, code: null, url: null, error: null, startedAt: Date.now(), scopes: scopes.split(',') };
    let output = '';
    const child = this.spawn(this.ghBin, args, { env: this.childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const onData = (chunk) => {
      output += chunk.toString();
      const { code, url } = parseDeviceOutput(output);
      if (code && this.flow.state === 'starting') {
        Object.assign(this.flow, { state: 'waiting', code, url });
        this.emit('update', this.status());
      }
      // gh asks to press Enter before polling; answer every prompt.
      if (/press enter/i.test(chunk.toString())) child.stdin.write('\n');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});
    child.stdin.write('\n');
    child.on('error', (err) => {
      Object.assign(this.flow, { state: 'error', error: `Could not run ${this.ghBin}: ${err.message}` });
      this.emit('update', this.status());
    });
    child.on('close', (code) => {
      this.child = null;
      if (this.flow.state === 'error') return;
      if (code === 0) Object.assign(this.flow, { state: 'done', code: null });
      else Object.assign(this.flow, { state: 'error', error: output.trim().split('\n').slice(-3).join(' ') || `gh exited with ${code}` });
      this.emit('update', this.status());
    });
    return this.status();
  }

  cancel() {
    if (this.child) this.child.kill('SIGTERM');
    if (this.flow) Object.assign(this.flow, { state: 'cancelled' });
    return this.status();
  }

  async logout() {
    return new Promise((resolve) => {
      this.execFile(this.ghBin, ['auth', 'logout', '--hostname', this.hostname], { env: this.childEnv() }, () => resolve());
    });
  }
}

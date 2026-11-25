import http from 'node:http';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { GitHubClient } from './github.js';
import { GhAuth, missingScopes, REQUIRED_SCOPES } from './ghauth.js';
import { JobManager } from './jobs.js';
import { validateRequest, renderWorkflow, PLATFORMS, RUNNERS, MODES, ValidationError } from './workflow.js';
import { GitHubApp } from './githubapp.js';
import { transformWorkflow, workflowName } from './transform.js';
import { ExtensionHost } from './extensions.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// Version and "updated at" for the front screen. Values come from the build
// (MAC_COMMIT / MAC_BUILT_AT) or the local git checkout; unknown stays null.
export async function provenance(env = process.env) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  let commit = env.MAC_COMMIT || null;
  let updatedAt = env.MAC_BUILT_AT || null;
  if (!commit) {
    try {
      let gitDir = join(ROOT, '.git');
      const dotGit = await readFile(gitDir, 'utf8').catch(() => null); // worktrees: "gitdir: <path>"
      if (dotGit?.startsWith('gitdir: ')) gitDir = dotGit.slice(8).trim();
      const common = await readFile(join(gitDir, 'commondir'), 'utf8').then((c) => join(gitDir, c.trim())).catch(() => gitDir);
      const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
      if (/^[0-9a-f]{40}$/.test(head)) commit = head;
      else if (head.startsWith('ref: ')) {
        const ref = head.slice(5);
        commit = (await readFile(join(gitDir, ref), 'utf8').catch(() => readFile(join(common, ref), 'utf8')).catch(async () => {
          const packed = await readFile(join(common, 'packed-refs'), 'utf8');
          return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] || '';
        })).trim() || null;
      }
    } catch { /* not a git checkout (images) */ }
    if (commit && !updatedAt) {
      updatedAt = await new Promise((resolve) => {
        execFile('git', ['log', '-1', '--format=%cI', commit], { cwd: ROOT, timeout: 3000 }, (err, out) => resolve(err ? null : out.trim() || null));
      });
    }
  }
  return { version: pkg.version, commit: commit ? commit.slice(0, 12) : null, updatedAt, source: env.MAC_COMMIT ? 'build' : commit ? 'git' : 'unknown' };
}

export function createApp(opts = {}) {
  const env = opts.env || process.env;
  const ghAuth = opts.ghAuth || new GhAuth({ env });
  const makeClient = opts.makeClient || ((token) => new GitHubClient({ token, apiUrl: env.GITHUB_API_URL || 'https://api.github.com' }));
  const accessKey = env.APP_ACCESS_KEY || '';

  async function resolveToken() {
    const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (envToken) return { token: envToken, source: 'env' };
    const t = await ghAuth.token();
    return t ? { token: t, source: 'gh' } : { token: null, source: null };
  }

  async function getClient() {
    const { token } = await resolveToken();
    if (!token) throw new ValidationError('Not signed in to GitHub. Use “Sign in with GitHub CLI” first.');
    return makeClient(token);
  }

  const githubApp = opts.githubApp !== undefined ? opts.githubApp : GitHubApp.fromEnv(env);
  const jobs = opts.jobs || new JobManager({
    getClient,
    makeClient,
    app: githubApp,
    journal: opts.journal !== undefined ? opts.journal : env.JOURNAL !== 'false',
    owner: env.GITHUB_OWNER || '',
    dataDir: env.DATA_DIR || join(ROOT, 'data'),
    pollMs: Number(env.POLL_INTERVAL_MS || 5000),
    ttlMs: Number(env.DOWNLOAD_TTL_MINUTES || 60) * 60 * 1000,
    keepRepoOnFailure: env.KEEP_REPO_ON_FAILURE === 'true',
  });

  const dataDir = env.DATA_DIR || join(ROOT, 'data');
  const extensions = opts.extensions || new ExtensionHost({
    dirs: [{ path: join(ROOT, 'extensions'), source: 'builtin' }, { path: join(dataDir, 'extensions'), source: 'user' }],
    dataDir, env,
  });
  const extensionsReady = extensions.load().catch(() => {});

  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  // Extensions hear about a build once, when it first reaches an end state.
  const finished = new Set();
  jobs.on('update', (job) => {
    broadcast('build', job);
    if (!['ready', 'failed'].includes(job.status) || finished.has(job.id)) return;
    finished.add(job.id);
    const outputs = (job.outputs || []).map((o, i) => ({ name: o.name, size: o.size, path: jobs.filePath(job.id, i) })).filter((o) => o.path);
    extensionsReady.then(() => extensions.dispatch('build.finished', { build: job, outputs })).catch(() => {});
  });
  extensions.on('run', (r) => broadcast('extension', r));
  extensions.on('change', () => broadcast('extensions', {}));
  jobs.on('remove', (id) => broadcast('remove', { id }));
  jobs.on('recovery', (r) => broadcast('recovery', r));
  ghAuth.on('update', (flow) => broadcast('auth', flow));

  function authorized(req, url) {
    if (!accessKey) return true;
    const given = req.headers['x-access-key'] || url.searchParams.get('key') || '';
    const a = Buffer.from(String(given));
    const b = Buffer.from(accessKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 30 * 1024 * 1024) throw new ValidationError('Request too large.');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Invalid JSON.'); }
  }

  async function authInfo() {
    const ghVersion = await ghAuth.available();
    const { token, source } = await resolveToken();
    const info = { ghAvailable: Boolean(ghVersion), ghVersion, source, signedIn: false, login: null, avatarUrl: null, scopes: [], missing: [...REQUIRED_SCOPES], required: REQUIRED_SCOPES, flow: ghAuth.status(), owner: env.GITHUB_OWNER || null };
    if (!token) return info;
    try {
      const v = await makeClient(token).viewer();
      Object.assign(info, { signedIn: true, login: v.login, avatarUrl: v.avatarUrl, scopes: v.scopes, missing: v.scopes.length ? missingScopes(v.scopes) : [] });
    } catch (err) {
      info.error = err.message;
    }
    return info;
  }

  async function api(req, res, url) {
    const { pathname } = url;
    const m = pathname.match(/^\/api\/builds\/([a-f0-9]+)(\/download|\/files\/(\d+))?$/);

    if (pathname === '/api/health') return json(res, 200, { ok: true });
    if (pathname === '/api/provenance') return json(res, 200, await provenance(env));
    if (!authorized(req, url)) return json(res, 401, { error: 'Access key required.', accessKeyRequired: true });

    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        platforms: PLATFORMS, runners: RUNNERS, modes: MODES, owner: env.GITHUB_OWNER || null,
        ttlMinutes: Number(env.DOWNLOAD_TTL_MINUTES || 60), githubApp: Boolean(githubApp),
      });
    }
    if (pathname === '/api/preview' && req.method === 'POST') {
      return json(res, 200, { yaml: renderWorkflow(validateRequest(await body(req))) });
    }
    if (pathname === '/api/scripts' && req.method === 'GET') {
      const repo = (url.searchParams.get('repo') || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
      if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new ValidationError('Repository must look like owner/name.');
      const [o, r] = repo.split('/');
      const gh = await getClient();
      const info = await gh.getRepo(o, r);
      const ref = url.searchParams.get('ref') || info.default_branch;
      const tree = await gh.getTree(o, r, ref);
      const scripts = (tree.tree || []).filter((t) => t.type === 'blob' && /\.(bat|cmd|ps1|sh)$/i.test(t.path)).map((t) => t.path).slice(0, 200);
      const guess = (tree.tree || []).some((t) => /^(dist|out|build|release)\//i.test(t.path)) ? 'dist/**/*.exe, dist/**/*.msi' : '**/*.exe, **/*.msi';
      const wfPaths = (tree.tree || []).filter((t) => t.type === 'blob' && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(t.path)).map((t) => t.path).slice(0, 30);
      const workflows = [];
      for (const path of wfPaths) {
        try {
          const raw = await gh.getContents(o, r, path, ref);
          const text = Buffer.from(raw.content || '', 'base64').toString('utf8');
          const t = transformWorkflow(text, { mode: url.searchParams.get('mode') || 'encrypted-public', file: path });
          workflows.push({ path, name: workflowName(text, path), dispatchable: t.dispatchable, warnings: t.warnings });
        } catch (err) {
          workflows.push({ path, name: path.split('/').pop(), dispatchable: false, warnings: [err.message] });
        }
      }
      return json(res, 200, { repo, ref, defaultBranch: info.default_branch, private: info.private, scripts, workflows, outputsGuess: guess, truncated: Boolean(tree.truncated) });
    }
    if (pathname === '/api/recovery' && req.method === 'GET') return json(res, 200, jobs.recoveryView());
    if (pathname === '/api/recovery/dismiss' && req.method === 'POST') { jobs.dismissRecovery(); return json(res, 200, { ok: true }); }
    if (pathname === '/api/auth' && req.method === 'GET') return json(res, 200, await authInfo());
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { mode } = await body(req);
      if (!(await ghAuth.available())) return json(res, 400, { error: 'GitHub CLI (gh) is not installed on the server.' });
      return json(res, 202, ghAuth.start(mode === 'refresh' ? 'refresh' : 'login'));
    }
    if (pathname === '/api/auth/cancel' && req.method === 'POST') return json(res, 200, ghAuth.cancel());
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      await ghAuth.logout();
      return json(res, 200, await authInfo());
    }
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ builds: jobs.list(), auth: ghAuth.status(), recovery: jobs.recoveryView() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (pathname === '/api/builds' && req.method === 'GET') return json(res, 200, jobs.list());
    if (pathname === '/api/builds' && req.method === 'POST') {
      const request = validateRequest(await body(req));
      await getClient(); // fail fast when signed out
      return json(res, 202, jobs.create(request));
    }
    if (pathname === '/api/extensions' && req.method === 'GET') {
      await extensionsReady;
      return json(res, 200, { ...extensions.list(), userDir: join(dataDir, 'extensions') });
    }
    if (pathname === '/api/extensions/rescan' && req.method === 'POST') {
      await extensions.scan();
      return json(res, 200, { ...extensions.list(), userDir: join(dataDir, 'extensions') });
    }
    const x = pathname.match(/^\/api\/extensions\/([a-z0-9-]{2,40})(\/run)?$/);
    if (x && req.method === 'POST') {
      await extensionsReady;
      const b = await body(req);
      if (!x[2]) return json(res, 200, await extensions.configure(x[1], { enabled: b.enabled, grant: b.grant }));
      const hook = b.hook === 'workflow.lint' ? 'workflow.lint' : b.hook === 'build.finished' ? 'build.finished' : 'command';
      const ctx = { input: typeof b.input === 'string' ? b.input : '', yaml: typeof b.yaml === 'string' ? b.yaml.slice(0, 500_000) : undefined };
      if (b.buildId) {
        const job = jobs.get(String(b.buildId));
        if (!job) return json(res, 404, { error: 'Build not found.' });
        ctx.build = job;
        ctx.outputs = (job.outputs || []).map((o, i) => ({ name: o.name, size: o.size, path: jobs.filePath(job.id, i) })).filter((o) => o.path);
      }
      return json(res, 200, await extensions.run(x[1], hook, ctx));
    }
    if (pathname === '/api/sweep' && req.method === 'POST') return json(res, 200, { deleted: await jobs.sweep() });
    if (m && !m[2] && req.method === 'GET') {
      const job = jobs.get(m[1]);
      return job ? json(res, 200, job) : json(res, 404, { error: 'Build not found.' });
    }
    if (m && !m[2] && req.method === 'DELETE') {
      return (await jobs.remove(m[1])) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'Build is running or missing.' });
    }
    if (m && m[2] && req.method === 'GET') {
      const index = m[3] ? Number(m[3]) : 0;
      const job = jobs.get(m[1]);
      const file = jobs.filePath(m[1], index);
      if (!job || !file) return json(res, 404, { error: 'Download not available.' });
      const name = jobs.fileName(m[1], index).replace(/["\\\r\n]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': job.outputs[index].size,
        'X-Content-Type-Options': 'nosniff',
      });
      createReadStream(file).pipe(res);
      return;
    }
    return json(res, 404, { error: 'Not found.' });
  }

  async function staticFile(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = normalize(join(PUBLIC_DIR, rel));
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    } catch {
      const data = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await staticFile(res, url.pathname);
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 500;
      if (!res.headersSent) json(res, status, { error: err.message });
      else res.end();
    }
  });
  return { server, jobs, ghAuth, extensions };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8080);
  const { server, jobs } = createApp();
  const recovery = await jobs.load();
  if (recovery) console.log(`Resumed ${recovery.jobs.length} build(s) after ${Math.round(recovery.offlineMs / 1000)}s offline`);
  jobs.startHeartbeat();
  server.listen(port, () => console.log(`material-actions-creator listening on http://0.0.0.0:${port}`));
  if (process.env.SWEEP_ON_START !== 'false') {
    jobs.sweep().then((d) => d.length && console.log(`Swept ${d.length} leftover repos`)).catch(() => {});
  }
  const shutdown = async (sig) => {
    console.log(`${sig}: saving the journal; running builds resume on next start`);
    await jobs.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

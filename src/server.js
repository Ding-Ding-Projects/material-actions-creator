import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { GitHubClient } from './github.js';
import { GhAuth, missingScopes, REQUIRED_SCOPES } from './ghauth.js';
import { JobManager } from './jobs.js';
import { validateRequest, PLATFORMS, ValidationError } from './workflow.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

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

  const jobs = opts.jobs || new JobManager({
    getClient,
    owner: env.GITHUB_OWNER || '',
    dataDir: env.DATA_DIR || join(ROOT, 'data'),
    pollMs: Number(env.POLL_INTERVAL_MS || 5000),
    ttlMs: Number(env.DOWNLOAD_TTL_MINUTES || 60) * 60 * 1000,
    keepRepoOnFailure: env.KEEP_REPO_ON_FAILURE === 'true',
  });

  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  jobs.on('update', (job) => broadcast('build', job));
  jobs.on('remove', (id) => broadcast('remove', { id }));
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
    const m = pathname.match(/^\/api\/builds\/([a-f0-9]+)(\/download)?$/);

    if (pathname === '/api/health') return json(res, 200, { ok: true });
    if (!authorized(req, url)) return json(res, 401, { error: 'Access key required.', accessKeyRequired: true });

    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { platforms: PLATFORMS, owner: env.GITHUB_OWNER || null, ttlMinutes: Number(env.DOWNLOAD_TTL_MINUTES || 60) });
    }
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
      res.write(`event: hello\ndata: ${JSON.stringify({ builds: jobs.list(), auth: ghAuth.status() })}\n\n`);
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
    if (pathname === '/api/sweep' && req.method === 'POST') return json(res, 200, { deleted: await jobs.sweep() });
    if (m && !m[2] && req.method === 'GET') {
      const job = jobs.get(m[1]);
      return job ? json(res, 200, job) : json(res, 404, { error: 'Build not found.' });
    }
    if (m && !m[2] && req.method === 'DELETE') {
      return (await jobs.remove(m[1])) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'Build is running or missing.' });
    }
    if (m && m[2] && req.method === 'GET') {
      const job = jobs.get(m[1]);
      const file = jobs.filePath(m[1]);
      if (!job || !file) return json(res, 404, { error: 'Download not available.' });
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${job.fileName}"`,
        ...(job.size ? { 'Content-Length': job.size } : {}),
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
  return { server, jobs, ghAuth };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8080);
  const { server, jobs } = createApp();
  server.listen(port, () => console.log(`material-actions-creator listening on http://0.0.0.0:${port}`));
  if (process.env.SWEEP_ON_START !== 'false') {
    jobs.sweep().then((d) => d.length && console.log(`Swept ${d.length} leftover repos`)).catch(() => {});
  }
}

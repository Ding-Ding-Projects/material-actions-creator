import { deflateRawSync, crc32 } from 'node:zlib';

// Builds a zip buffer (stored or deflated entries) for exercising the extractor.
export function makeZip(entries, { method = 8 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// In-memory fake of the GitHub REST endpoints the app uses.
export function fakeGitHub({ conclusion = 'success', artifactZip, ownerType = 'Organization', failDelete = false, scopes = 'repo, workflow, delete_repo' } = {}) {
  const state = { repos: new Map(), calls: [], runPolls: 0 };
  const reply = (status, data, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const path = u.pathname;
    state.calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if (method === 'GET' && path === '/user') return reply(200, { login: 'swiftie', avatar_url: 'https://x/a.png' }, { 'x-oauth-scopes': scopes });
    if (method === 'GET' && (m = path.match(/^\/users\/([^/]+)$/))) return reply(200, { login: m[1], type: ownerType });
    if (method === 'POST' && (path.match(/^\/orgs\/[^/]+\/repos$/) || path === '/user/repos')) {
      state.repos.set(body.name, { name: body.name, files: {}, private: body.private, created_at: new Date().toISOString() });
      return reply(201, { name: body.name, default_branch: 'main', private: true });
    }
    if (method === 'GET' && (path.match(/^\/orgs\/[^/]+\/repos$/) || path === '/user/repos')) return reply(200, [...state.repos.values()]);
    if ((m = path.match(/^\/repos\/[^/]+\/([^/]+)(\/.*)?$/))) {
      const repo = state.repos.get(m[1]);
      const rest = m[2] || '';
      if (!repo) return reply(404, { message: 'Not Found' });
      if (method === 'DELETE' && rest === '') {
        if (failDelete) return reply(403, { message: 'Must have admin rights' });
        state.repos.delete(m[1]);
        return reply(204);
      }
      if (method === 'PUT' && rest.startsWith('/contents/')) {
        repo.files[decodeURIComponent(rest.slice(10))] = Buffer.from(body.content, 'base64').toString('utf8');
        return reply(201, {});
      }
      if (method === 'PUT' && rest === '/topics') return reply(200, { names: body.names });
      if (method === 'POST' && rest.endsWith('/dispatches')) { repo.dispatched = true; return reply(204); }
      if (method === 'GET' && rest.includes('/workflows/') && rest.endsWith('/runs')) {
        return reply(200, { workflow_runs: repo.dispatched ? [{ id: 77, run_number: 1, status: 'queued', html_url: 'https://github.com/run/77' }] : [] });
      }
      if (method === 'GET' && rest === '/actions/runs/77') {
        state.runPolls++;
        const done = state.runPolls >= 2;
        return reply(200, { id: 77, run_number: 1, status: done ? 'completed' : 'in_progress', conclusion: done ? conclusion : null, html_url: 'https://github.com/run/77' });
      }
      if (method === 'GET' && rest === '/actions/runs/77/jobs') return reply(200, { jobs: [{ steps: [{ name: 'Build image', conclusion: 'failure' }] }] });
      if (method === 'GET' && rest === '/actions/runs/77/artifacts') return reply(200, { artifacts: [{ id: 5, name: 'docker-image' }] });
      if (method === 'GET' && rest === '/actions/artifacts/5/zip') return new Response(artifactZip, { status: 200 });
    }
    return reply(500, { message: `unhandled ${method} ${path}` });
  };
  return { state, fetchImpl };
}

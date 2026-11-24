import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import nacl from 'tweetnacl';
import { sealedBoxOpen } from '../src/sealedbox.js';
import { open, seal } from '../src/mac-crypt.mjs';

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

export const SOURCE_TARBALL_BYTES = Buffer.from('pretend source tarball of map-editor');

// In-memory fake of the GitHub REST API. When a workflow is dispatched it
// "runs" it: for encrypted runs it opens the sealed MAC_KEY secret with the
// repository's key pair, decrypts src.mac, builds fake outputs and seals them,
// exactly like the generated workflow does on a real runner.
export function fakeGitHub({
  conclusion = 'success', ownerType = 'Organization', failDelete = false,
  scopes = 'repo, workflow, delete_repo', pollsUntilDone = 2, legacyArtifact = null,
} = {}) {
  const repoKeys = nacl.box.keyPair();
  const state = { repos: new Map(), calls: [], runPolls: 0, revoked: 0, deleted: [], seen: {} };
  const reply = (status, data, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

  async function runWorkflow(repo) {
    const dir = await mkdtemp(join(tmpdir(), 'fake-runner-'));
    try {
      const enc = Boolean(repo.files['src.mac']);
      const isScripts = (repo.files['.github/workflows/build.yml'] || '').includes('Run script');
      let key = null;
      if (enc) {
        key = sealedBoxOpen(repo.secrets.MAC_KEY, repoKeys.publicKey, repoKeys.secretKey)?.toString();
        await writeFile(join(dir, 'src.mac'), repo.filesRaw['src.mac']);
        state.seen.opened = await open(join(dir, 'src.mac'), join(dir, 'in'), key);
      }
      let outputs;
      if (isScripts) {
        const tarball = enc ? await readFile(join(dir, 'in', 'src.tar.gz')) : repo.filesRaw['src.tar.gz'];
        state.seen.tarball = tarball.toString();
        outputs = [
          { name: 'Setup-1.0.exe', data: Buffer.from(`EXE built from ${tarball}`) },
          { name: 'msi/Setup-1.0.msi', data: Buffer.from('MSI') },
        ];
      } else {
        const dockerfile = enc ? await readFile(join(dir, 'in', 'Dockerfile'), 'utf8') : repo.files['context/Dockerfile'];
        state.seen.dockerfile = dockerfile;
        outputs = [{ name: 'image.tar.gz', data: Buffer.from(`IMAGE:${dockerfile}`) }];
      }
      state.seen.outputs = outputs;
      if (legacyArtifact) return makeZip([{ name: 'image.tar.gz', data: legacyArtifact }]);
      if (!enc) return makeZip(outputs);
      const outDir = join(dir, 'out');
      for (const o of outputs) {
        await mkdir(dirname(join(outDir, o.name)), { recursive: true });
        await writeFile(join(outDir, o.name), o.data);
      }
      await seal(join(dir, 'out.mac'), outDir, ['**/*'], key);
      return makeZip([{ name: 'out.mac', data: await readFile(join(dir, 'out.mac')) }], { method: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const path = u.pathname;
    state.calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if (method === 'GET' && path === '/user') return reply(200, { login: 'swiftie', avatar_url: 'https://x/a.png' }, { 'x-oauth-scopes': scopes });
    if (method === 'GET' && (m = path.match(/^\/users\/([^/]+)$/))) return reply(200, { login: m[1], type: ownerType });
    if (method === 'DELETE' && path === '/installation/token') { state.revoked++; return reply(204); }
    if (method === 'POST' && (path.match(/^\/orgs\/[^/]+\/repos$/) || path === '/user/repos')) {
      state.repos.set(body.name, { name: body.name, files: {}, filesRaw: {}, secrets: {}, private: body.private, created_at: new Date().toISOString(), auth: init.headers?.Authorization });
      return reply(201, { name: body.name, default_branch: 'main', private: body.private });
    }
    if (method === 'GET' && (path.match(/^\/orgs\/[^/]+\/repos$/) || path === '/user/repos')) return reply(200, [...state.repos.values()]);
    if (method === 'GET' && path === '/repos/Ding-Ding-Projects/map-editor') return reply(200, { default_branch: 'main', private: true });
    if (method === 'GET' && path.startsWith('/repos/Ding-Ding-Projects/map-editor/git/trees/')) {
      return reply(200, { tree: [
        { path: 'build/installer.bat', type: 'blob' }, { path: 'tools/clean.cmd', type: 'blob' },
        { path: 'README.md', type: 'blob' }, { path: 'dist/.keep', type: 'blob' },
      ] });
    }
    if (method === 'GET' && path.startsWith('/repos/Ding-Ding-Projects/map-editor/tarball/')) return new Response(SOURCE_TARBALL_BYTES, { status: 200 });
    if ((m = path.match(/^\/repos\/[^/]+\/([^/]+)(\/.*)?$/))) {
      const repo = state.repos.get(m[1]);
      const rest = m[2] || '';
      if (!repo) return reply(404, { message: 'Not Found' });
      if (method === 'DELETE' && rest === '') {
        if (failDelete) return reply(403, { message: 'Must have admin rights' });
        state.repos.delete(m[1]);
        state.deleted.push(m[1]);
        return reply(204);
      }
      if (method === 'PUT' && rest.startsWith('/contents/')) {
        const p = decodeURIComponent(rest.slice(10));
        repo.filesRaw[p] = Buffer.from(body.content, 'base64');
        repo.files[p] = repo.filesRaw[p].toString('utf8');
        return reply(201, {});
      }
      if (method === 'PUT' && rest === '/topics') return reply(200, { names: body.names });
      if (method === 'GET' && rest === '/actions/secrets/public-key') return reply(200, { key_id: 'kid-1', key: Buffer.from(repoKeys.publicKey).toString('base64') });
      if (method === 'PUT' && rest.startsWith('/actions/secrets/')) {
        if (body.key_id !== 'kid-1') return reply(422, { message: 'bad key id' });
        repo.secrets[rest.split('/').pop()] = body.encrypted_value;
        return reply(201, {});
      }
      if (method === 'POST' && rest.endsWith('/dispatches')) {
        repo.dispatched = true;
        repo.artifact = await runWorkflow(repo);
        return reply(204);
      }
      if (method === 'GET' && rest.includes('/workflows/') && rest.endsWith('/runs')) {
        return reply(200, { workflow_runs: repo.dispatched ? [{ id: 77, run_number: 1, status: 'queued', html_url: 'https://github.com/run/77' }] : [] });
      }
      if (method === 'GET' && rest === '/actions/runs/77') {
        state.runPolls++;
        const done = state.runPolls >= pollsUntilDone;
        return reply(200, { id: 77, run_number: 1, status: done ? 'completed' : 'in_progress', conclusion: done ? conclusion : null, html_url: 'https://github.com/run/77' });
      }
      if (method === 'GET' && rest === '/actions/runs/77/jobs') return reply(200, { jobs: [{ steps: [{ name: 'Run script 1', conclusion: 'failure' }] }] });
      if (method === 'GET' && rest === '/actions/runs/77/artifacts') return reply(200, { artifacts: [{ id: 5, name: 'lap-sap' }] });
      if (method === 'GET' && rest === '/actions/artifacts/5/zip') return new Response(repo.artifact, { status: 200 });
    }
    return reply(500, { message: `unhandled ${method} ${path}` });
  };
  return { state, fetchImpl, repoKeys };
}

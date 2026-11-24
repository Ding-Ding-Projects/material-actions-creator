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
export const SOURCE_SHA = 'abc1234def5678900000000000000000000000ff';
export const SOURCE_WORKFLOWS = {
  '.github/workflows/release.yml': `name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - run: build\\installer.bat
        shell: cmd
      - uses: actions/upload-artifact@v4
        with:
          name: installers
          path: dist/*.exe
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/*.exe
`,
  '.github/workflows/lint.yml': `name: Lint
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo lint
`,
  '.github/workflows/reusable.yml': `on:
  workflow_call:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo called
`,
};

// In-memory fake of the GitHub REST API. When a workflow is dispatched it
// "runs" it: for encrypted runs it opens the sealed MAC_KEY secret with the
// repository's key pair, decrypts src.mac, builds fake outputs and seals them,
// exactly like the generated workflow does on a real runner.
export function fakeGitHub({
  conclusion = 'success', ownerType = 'Organization', failDelete = false,
  scopes = 'repo, workflow, delete_repo', pollsUntilDone = 2, legacyArtifact = null,
} = {}) {
  const repoKeys = nacl.box.keyPair();
  const state = { repos: new Map(), calls: [], runPolls: 0, revoked: 0, deleted: [], seen: {}, runs: new Map(), nextRun: 77, failFiles: new Set() };
  const reply = (status, data, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

  async function runWorkflow(repo, file) {
    const dir = await mkdtemp(join(tmpdir(), 'fake-runner-'));
    try {
      const enc = Boolean(repo.files['src.mac']);
      const wfText = repo.files[`.github/workflows/${file}`] || '';
      const isSource = file !== 'mac-build.yml';
      const isScripts = isSource || wfText.includes('Run script');
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
        outputs = isSource
          ? [{ name: 'dist/App-from-workflow.exe', data: Buffer.from(`${file} built from ${tarball}`) }]
          : [
            { name: 'Setup-1.0.exe', data: Buffer.from(`EXE built from ${tarball}`) },
            { name: 'msi/Setup-1.0.msi', data: Buffer.from('MSI') },
          ];
      } else {
        const dockerfile = enc ? await readFile(join(dir, 'in', 'Dockerfile'), 'utf8') : repo.files['context/Dockerfile'];
        state.seen.dockerfile = dockerfile;
        outputs = [{ name: 'image.tar.gz', data: Buffer.from(`IMAGE:${dockerfile}`) }];
      }
      state.seen.outputs = outputs;
      const artName = isSource ? 'installers' : 'lap-sap';
      if (legacyArtifact) return [{ name: 'docker-image', zip: makeZip([{ name: 'image.tar.gz', data: legacyArtifact }]) }];
      if (!enc) return [{ name: artName, zip: makeZip(outputs) }];
      const outDir = join(dir, 'out');
      for (const o of outputs) {
        await mkdir(dirname(join(outDir, o.name)), { recursive: true });
        await writeFile(join(outDir, o.name), o.data);
      }
      await seal(join(dir, 'out.mac'), outDir, ['**/*'], key);
      const zip = makeZip([{ name: isSource ? 'mac-out-0.mac' : 'out.mac', data: await readFile(join(dir, 'out.mac')) }], { method: 0 });
      return [{ name: isSource ? `lap-sap-${artName}` : 'lap-sap', zip }];
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
        ...Object.keys(SOURCE_WORKFLOWS).map((p) => ({ path: p, type: 'blob' })),
      ] });
    }
    if (method === 'GET' && path.startsWith('/repos/Ding-Ding-Projects/map-editor/commits/')) return reply(200, { sha: SOURCE_SHA });
    if (method === 'GET' && path === '/repos/Ding-Ding-Projects/map-editor/contents/.github/workflows') {
      state.seen.contentsRef = u.searchParams.get('ref');
      return reply(200, Object.keys(SOURCE_WORKFLOWS).map((p) => ({ type: 'file', path: p, name: p.split('/').pop() })));
    }
    if (method === 'GET' && path.startsWith('/repos/Ding-Ding-Projects/map-editor/contents/.github/workflows/')) {
      const p = decodeURIComponent(path.slice('/repos/Ding-Ding-Projects/map-editor/contents/'.length));
      return SOURCE_WORKFLOWS[p] ? reply(200, { content: Buffer.from(SOURCE_WORKFLOWS[p]).toString('base64'), encoding: 'base64' }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path.startsWith('/repos/Ding-Ding-Projects/map-editor/tarball/')) {
      state.seen.tarballRef = decodeURIComponent(path.split('/').pop());
      return new Response(SOURCE_TARBALL_BYTES, { status: 200 });
    }
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
      let wm;
      if (method === 'POST' && (wm = rest.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/))) {
        const file = wm[1];
        if (!repo.files[`.github/workflows/${file}`]) return reply(404, { message: 'workflow not found' });
        const id = state.nextRun++;
        const artifacts = (await runWorkflow(repo, file)).map((a, i) => ({ ...a, id: id * 10 + i }));
        state.runs.set(id, { id, file, repo: repo.name, artifacts, number: 1 });
        return reply(204);
      }
      if (method === 'GET' && (wm = rest.match(/^\/actions\/workflows\/([^/]+)\/runs$/))) {
        const runs = [...state.runs.values()].filter((r) => r.repo === repo.name && r.file === wm[1]).reverse();
        return reply(200, { workflow_runs: runs.map((r) => ({ id: r.id, run_number: 1, status: 'queued', html_url: `https://github.com/run/${r.id}` })) });
      }
      if (method === 'GET' && (wm = rest.match(/^\/actions\/runs\/(\d+)$/))) {
        const r = state.runs.get(Number(wm[1]));
        state.runPolls++;
        const done = state.runPolls >= pollsUntilDone;
        const c = state.failFiles.has(r.file) ? 'failure' : conclusion;
        return reply(200, { id: r.id, run_number: 1, status: done ? 'completed' : 'in_progress', conclusion: done ? c : null, html_url: `https://github.com/run/${r.id}` });
      }
      if (method === 'GET' && (wm = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/))) return reply(200, { jobs: [{ steps: [{ name: 'Run script 1', conclusion: 'failure' }] }] });
      if (method === 'GET' && (wm = rest.match(/^\/actions\/runs\/(\d+)\/artifacts$/))) {
        const r = state.runs.get(Number(wm[1]));
        return reply(200, { artifacts: r.artifacts.map((a) => ({ id: a.id, name: a.name })) });
      }
      if (method === 'GET' && (wm = rest.match(/^\/actions\/artifacts\/(\d+)\/zip$/))) {
        const a = [...state.runs.values()].flatMap((r) => r.artifacts).find((x) => x.id === Number(wm[1]));
        return new Response(a.zip, { status: 200 });
      }
    }
    return reply(500, { message: `unhandled ${method} ${path}` });
  };
  return { state, fetchImpl, repoKeys };
}

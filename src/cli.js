#!/usr/bin/env node
// mac: command-line interface for Material Actions Creator.
//
// Every command works against a running server (--server URL, or MAC_SERVER)
// or, by default, against a private in-process engine that keeps its builds and
// run journal in ~/.material-actions-creator. Both paths use the same HTTP API,
// so the CLI and the web app behave identically.
import { parseArgs } from 'node:util';
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const lime = c('38;5;191'); const violet = c('38;5;147'); const coral = c('38;5;210'); const dim = c('2'); const bold = c('1');

const HELP = `mac ${VERSION} — Material Actions Creator CLI

Sign in
  mac login [--refresh]            Assisted GitHub CLI sign-in (device code) with the
                                   repo, workflow and delete_repo scopes
  mac whoami                       Who is signed in and which scopes are missing
  mac logout

Build a repository
  mac scan <owner/repo> [--ref R]  List build scripts and workflows (with warnings)
  mac build <owner/repo> [options]
      --ref <branch|tag|sha>       Default: the repository's default branch
      --script <path>              A build script to run (repeatable, in order)
      --all-scripts                Run every script the scan finds
      --workflow <path>            Run one of the repository's own workflows (repeatable)
      --all-workflows              Run every workflow that can be started manually
      --runner <label>             Default: windows-latest
      --outputs <globs>            Output globs for scripts, e.g. "dist/**/*.exe"
      --encrypted                  Encrypted public builder (default: private temp repo)
      --local                      Run on this computer; the repository may be a folder path
      --name <title>
  mac preview <owner/repo> [same options]    Print the generated workflow, do nothing

Build a Dockerfile
  mac docker [-f Dockerfile] [--file path]... [--image name:tag] [--platform linux/arm64]
             [--build-arg K=V]... [--encrypted]

Runs
  mac runs                         List builds
  mac watch <id>                   Follow a build (resumes it if the engine had stopped)
  mac download <id> [--out dir]    Save every output (decrypted)
  mac rm <id>                      Dismiss a finished build and delete its files
  mac local                        What this computer can run locally
  mac local install                Download the pinned local runner program now
  mac recipes                      List saved recipes
  mac recipe save <name> owner/repo [build options] [--every <hours> | --daily HH:MM]
  mac recipe run <name>            Start a recipe and follow it
  mac recipe rm <name>             Delete a recipe
  mac sweep                        Delete leftover temporary repositories

Other
  mac serve [--port 8080]          Start the web app
  mac crypt <seal|open|encrypt|decrypt|keygen> ...   The mac-crypt skill
  mac --version

Common options
  --server <url>   Use a running server (or MAC_SERVER). --key <key> (or MAC_ACCESS_KEY)
  --owner <name>   Where temporary repositories go (or GITHUB_OWNER)
  --out <dir>      Where build/docker/download save outputs (default ./outputs/<id>)
  --detach         Start a build and return its id without waiting
  --json           Machine-readable output
`;

const OPTIONS = {
  server: { type: 'string' }, key: { type: 'string' }, owner: { type: 'string' }, every: { type: 'string' }, daily: { type: 'string' },
  ref: { type: 'string' }, script: { type: 'string', multiple: true }, 'all-scripts': { type: 'boolean' },
  workflow: { type: 'string', multiple: true }, 'all-workflows': { type: 'boolean' },
  runner: { type: 'string' }, outputs: { type: 'string' }, encrypted: { type: 'boolean' }, local: { type: 'boolean' }, name: { type: 'string' },
  dockerfile: { type: 'string', short: 'f' }, file: { type: 'string', multiple: true }, image: { type: 'string' },
  platform: { type: 'string' }, 'build-arg': { type: 'string', multiple: true },
  out: { type: 'string', short: 'o' }, detach: { type: 'boolean' }, json: { type: 'boolean' },
  refresh: { type: 'boolean' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
};

class CliError extends Error {}

// ---------- backends ----------

async function remoteBackend(base, key) {
  const url = base.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(key ? { 'x-access-key': key } : {}) };
  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new CliError(`Cannot reach ${url}: ${err.cause?.code || err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new CliError(data.error || `HTTP ${res.status}`);
    return data;
  }
  async function download(path, dest) {
    const res = await fetch(url + path, { headers });
    if (!res.ok) throw new CliError(`Download failed (${res.status})`);
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  }
  return { url, call, download, close: async () => {} };
}

async function localBackend(opts) {
  const dataRoot = process.env.MAC_HOME || join(homedir(), '.material-actions-creator');
  const env = {
    ...process.env,
    DATA_DIR: process.env.DATA_DIR || join(dataRoot, 'builds'),
    ...(opts.owner ? { GITHUB_OWNER: opts.owner } : {}),
  };
  delete env.APP_ACCESS_KEY; // the in-process engine is loopback-only
  const { createApp } = await import('./server.js');
  const app = createApp({ env });
  await app.jobs.load({ resume: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const be = await remoteBackend(`http://127.0.0.1:${app.server.address().port}`, '');
  return {
    ...be,
    local: true,
    app,
    async close() {
      await app.jobs.stop();
      await new Promise((r) => app.server.close(r));
      app.server.closeAllConnections?.();
    },
  };
}

// ---------- output helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB']; let v = n; let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}
const STATE = { done: lime('●'), active: violet('◐'), failed: coral('✕'), skipped: dim('·'), pending: dim('○') };
const STATUS = { running: violet, ready: lime, failed: coral, expired: dim };

function printJob(job) {
  console.log(`${bold(job.title || job.imageName)}  ${(STATUS[job.status] || ((s) => s))(job.status.toUpperCase())}  ${dim(job.id)}`);
  console.log(dim(`  ${job.subtitle || ''}${job.mode === 'encrypted-public' ? ' · encrypted public' : job.mode === 'local' ? ' · this computer' : ' · private'}`));
}

function stageLine(s) {
  return `  ${STATE[s.state] || '?'} ${s.label}${s.detail ? dim(`  ${s.detail}`) : ''}`;
}

async function follow(be, id, { json }) {
  const seen = new Map();
  let job;
  let warned = false;
  while (true) {
    job = await be.call(`/api/builds/${id}`);
    if (!json) {
      for (const s of job.stages) {
        const sig = `${s.state}|${s.detail || ''}`;
        if (seen.get(s.id) !== sig && s.state !== 'pending') { console.log(stageLine(s)); seen.set(s.id, sig); }
      }
      if (!warned && job.warnings?.length) {
        warned = true;
        for (const w of job.warnings) console.log(coral(`  ! ${w}`));
      }
    }
    if (job.status !== 'running') break;
    await sleep(1500);
  }
  return job;
}

async function saveOutputs(be, job, outDir, { json }) {
  const dir = resolve(outDir || join('outputs', job.id));
  const saved = [];
  for (const o of job.outputs || []) {
    const dest = join(dir, ...o.name.split('/'));
    await be.download(o.url, dest);
    saved.push({ name: o.name, size: o.size, path: dest });
    if (!json) console.log(`  ${lime('↓')} ${o.name} ${dim(fmtBytes(o.size))}`);
  }
  if (!json && saved.length) console.log(dim(`  saved to ${dir}`));
  return saved;
}

async function finishBuild(be, created, opts) {
  if (opts.detach) {
    if (opts.json) console.log(JSON.stringify(created));
    else console.log(`${created.id}  ${dim('started; follow with')} mac watch ${created.id}`);
    return 0;
  }
  if (!opts.json) printJob(created);
  const job = await follow(be, created.id, opts);
  let saved = [];
  if (job.status === 'ready') saved = await saveOutputs(be, job, opts.out, opts);
  if (job.error && !opts.json) console.log(coral(`  ${job.error}`));
  if (opts.json) console.log(JSON.stringify({ ...job, saved }, null, 2));
  return job.status === 'ready' ? 0 : 1;
}

function buildArgsFrom(list = []) {
  const out = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 1) throw new CliError(`--build-arg needs KEY=VALUE, got "${kv}"`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

const modeOf = (opts) => (opts.local ? 'local' : opts.encrypted ? 'encrypted-public' : 'private');
// A local build may name a folder instead of a repository: "mac build ./project --local".
const folderOf = (repo, opts) => (opts.local && repo && (/^[.~/\\]|^[A-Za-z]:/.test(repo) || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) ? resolve(repo.replace(/^~(?=$|\/)/, homedir())) : null);

async function repoRequest(be, repo, opts) {
  if (!repo) throw new CliError('Which repository? e.g. mac build owner/name --all-scripts (or a folder with --local)');
  let scripts = opts.script || [];
  let workflows = opts.workflow || [];
  const folder = folderOf(repo, opts);
  if (opts['all-scripts'] || opts['all-workflows']) {
    const q = new URLSearchParams({ repo, mode: modeOf(opts) });
    if (opts.ref) q.set('ref', opts.ref);
    const scan = folder ? await be.call(`/api/local/scan?${new URLSearchParams({ path: folder })}`) : await be.call(`/api/scripts?${q}`);
    if (opts['all-scripts']) scripts = scan.scripts;
    if (opts['all-workflows']) workflows = scan.workflows.filter((w) => w.dispatchable).map((w) => w.path);
    if (!opts.outputs && scripts.length) opts.outputs = scan.outputsGuess;
  }
  return {
    kind: 'scripts',
    ...(folder ? { localPath: folder } : { repo }),
    ref: opts.ref || '',
    scripts,
    workflows,
    runner: opts.runner || 'windows-latest',
    outputs: opts.outputs || '',
    mode: modeOf(opts),
    ...(opts.name ? { name: opts.name } : {}),
  };
}

// ---------- commands ----------

const COMMANDS = {
  async login(be, args, opts) {
    const info = await be.call('/api/auth');
    if (!info.ghAvailable) throw new CliError('GitHub CLI (gh) is not installed. Install it, or set GITHUB_TOKEN.');
    const mode = opts.refresh || (info.signedIn && info.missing.length) ? 'refresh' : 'login';
    if (info.signedIn && !info.missing.length && !opts.refresh) {
      console.log(`${lime('✓')} Already signed in as ${bold(info.login)} with every scope.`);
      return 0;
    }
    let flow = await be.call('/api/auth/login', { method: 'POST', body: { mode } });
    let shown = false;
    while (['starting', 'waiting'].includes(flow.state)) {
      if (flow.code && !shown) {
        shown = true;
        console.log(`\n  ${dim('1.')} Open ${bold(flow.url)}`);
        console.log(`  ${dim('2.')} Enter the code ${lime(bold(flow.code))}`);
        console.log(`  ${dim('3.')} Approve ${['repo', 'workflow', 'delete_repo', 'read:org'].join(', ')}\n`);
        console.log(dim('  Waiting for GitHub…'));
      }
      await sleep(1500);
      flow = (await be.call('/api/auth')).flow;
    }
    if (flow.state !== 'done') throw new CliError(flow.error || `Sign-in ${flow.state}.`);
    const after = await be.call('/api/auth');
    console.log(`${lime('✓')} Signed in as ${bold(after.login)}${after.missing.length ? coral(` (still missing: ${after.missing.join(', ')})`) : ''}`);
    return after.missing.length ? 1 : 0;
  },

  async whoami(be, args, opts) {
    const a = await be.call('/api/auth');
    if (opts.json) { console.log(JSON.stringify(a, null, 2)); return a.signedIn ? 0 : 1; }
    if (!a.signedIn) { console.log(`${coral('✕')} Not signed in${a.error ? `: ${a.error}` : ''}. Run ${bold('mac login')}.`); return 1; }
    console.log(`${lime('✓')} ${bold(a.login)} via ${a.source === 'env' ? 'GITHUB_TOKEN' : 'GitHub CLI'}`);
    console.log(`  scopes: ${a.required.map((s) => (a.missing.includes(s) ? coral(s) : lime(s))).join(' ')}`);
    if (a.missing.length) console.log(`  run ${bold('mac login --refresh')} to add the missing scopes`);
    return a.missing.length ? 1 : 0;
  },

  async logout(be) {
    await be.call('/api/auth/logout', { method: 'POST' });
    console.log('Signed out of GitHub CLI.');
    return 0;
  },

  async scan(be, [repo], opts) {
    if (!repo) throw new CliError('mac scan owner/name');
    const q = new URLSearchParams({ repo, mode: opts.encrypted ? 'encrypted-public' : 'private' });
    if (opts.ref) q.set('ref', opts.ref);
    const r = await be.call(`/api/scripts?${q}`);
    if (opts.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`${bold(r.repo)} @ ${r.ref}${r.private ? dim(' · private') : ''}`);
    console.log(`\n${bold('Build scripts')} ${dim(`(${r.scripts.length})`)}`);
    for (const s of r.scripts) console.log(`  ${s}`);
    console.log(`\n${bold('Workflows')} ${dim(`(${r.workflows.length})`)}`);
    for (const w of r.workflows) {
      console.log(`  ${w.dispatchable ? lime('▶') : dim('·')} ${w.path}  ${dim(w.name)}${w.dispatchable ? '' : dim('  (callable only)')}`);
      for (const x of w.warnings) console.log(dim(`      ${x}`));
    }
    console.log(`\n${dim('Suggested outputs:')} ${r.outputsGuess}`);
    return 0;
  },

  async preview(be, [repo], opts) {
    const req = await repoRequest(be, repo, opts);
    const { yaml } = await be.call('/api/preview', { method: 'POST', body: req });
    console.log(yaml.trimEnd());
    return 0;
  },

  async build(be, [repo], opts) {
    const req = await repoRequest(be, repo, opts);
    const created = await be.call('/api/builds', { method: 'POST', body: req });
    return finishBuild(be, created, opts);
  },

  async docker(be, args, opts) {
    const dockerfile = await readFile(opts.dockerfile || 'Dockerfile', 'utf8').catch(() => { throw new CliError(`Cannot read ${opts.dockerfile || 'Dockerfile'}`); });
    const files = [];
    for (const f of opts.file || []) files.push({ path: f.replace(/\\/g, '/'), content: await readFile(f, 'utf8') });
    const created = await be.call('/api/builds', {
      method: 'POST',
      body: {
        kind: 'dockerfile', dockerfile, files, imageName: opts.image || 'custom-image:latest',
        platform: opts.platform || 'linux/amd64', buildArgs: buildArgsFrom(opts['build-arg']),
        mode: modeOf(opts),
      },
    });
    return finishBuild(be, created, opts);
  },

  async runs(be, args, opts) {
    const list = await be.call('/api/builds');
    if (opts.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { console.log(dim('No builds yet.')); return 0; }
    for (const j of list) {
      const done = j.stages.filter((s) => s.state === 'done').length;
      console.log(`${dim(j.id)}  ${(STATUS[j.status] || ((s) => s))(j.status.padEnd(7))}  ${j.title}  ${dim(`${done}/${j.stages.length}${j.outputs?.length ? ` · ${j.outputs.length} output${j.outputs.length === 1 ? '' : 's'}` : ''}${j.recovered ? ' · resumed' : ''}`)}`);
    }
    return 0;
  },

  async watch(be, [id], opts) {
    if (!id) throw new CliError('mac watch <id>');
    if (be.local) be.app.jobs.resumeOne(id);
    const job0 = await be.call(`/api/builds/${id}`);
    return finishBuild(be, job0, { ...opts, detach: false, out: opts.out });
  },

  async download(be, [id], opts) {
    if (!id) throw new CliError('mac download <id>');
    const job = await be.call(`/api/builds/${id}`);
    if (job.status !== 'ready') throw new CliError(`Build ${id} is ${job.status}; nothing to download.`);
    const saved = await saveOutputs(be, job, opts.out, opts);
    if (opts.json) console.log(JSON.stringify(saved, null, 2));
    return 0;
  },

  async rm(be, [id]) {
    if (!id) throw new CliError('mac rm <id>');
    await be.call(`/api/builds/${id}`, { method: 'DELETE' });
    console.log(`Removed ${id}.`);
    return 0;
  },

  async local(be, [action], opts) {
    const caps = action === 'install' ? await be.call('/api/local/install', { method: 'POST' }) : await be.call('/api/local');
    if (opts.json) { console.log(JSON.stringify(caps, null, 2)); return 0; }
    const yes = (v, why) => (v ? `${lime('✓')} ${v === true ? 'yes' : v}` : `${dim('–')} ${why}`);
    console.log(`${bold('This computer')}  ${caps.host} ${caps.arch}`);
    console.log(`  Runner program   ${caps.act.installed ? `${lime('✓')} act ${caps.act.version} (${caps.act.source})` : caps.act.installable ? `${dim('·')} act ${caps.act.version} is downloaded on first use (or: mac local install)` : `${coral('✕')} install "act" yourself`}`);
    console.log(`  Containers       ${caps.containers ? `${lime('✓')} ${caps.containers.engine} ${caps.containers.version}` : `${dim('–')} none`}`);
    console.log(`  Linux jobs       ${yes(caps.canRun.linux === 'container' ? 'in containers' : caps.canRun.linux === 'host' ? 'directly on this computer' : false, 'need Docker, or a Linux computer')}`);
    console.log(`  Windows jobs     ${yes(Boolean(caps.canRun.windows), 'need a Windows computer')}`);
    console.log(`  macOS jobs       ${yes(Boolean(caps.canRun.macos), 'need a Mac')}`);
    console.log(`  Docker images    ${yes(Boolean(caps.containers), 'need Docker')}`);
    return 0;
  },

  async recipes(be, args, opts) {
    const { recipes } = await be.call('/api/recipes');
    if (opts.json) { console.log(JSON.stringify(recipes, null, 2)); return 0; }
    if (!recipes.length) { console.log('No recipes. Save one with: mac recipe save <name> owner/repo --all-scripts'); return 0; }
    for (const r of recipes) {
      const when = r.schedule.type === 'daily' ? `daily at ${r.schedule.time}` : r.schedule.type === 'interval' ? `every ${r.schedule.hours} h` : 'manual';
      const last = r.lastRun ? `${r.lastRun.error ? 'not started' : r.lastRun.status || 'started'} ${new Date(r.lastRun.at).toLocaleString()}` : 'never run';
      console.log(`${bold(r.name)}  ${dim(r.request.repo || r.request.imageName || '')}  ${violet(when)}  ${dim(last)}`);
    }
    return 0;
  },

  async recipe(be, [action, name, repo], opts) {
    if (action === 'run') {
      if (!name) throw new CliError('mac recipe run <name>');
      const { build } = await be.call(`/api/recipes/${encodeURIComponent(name)}/run`, { method: 'POST' });
      return finishBuild(be, build, opts);
    }
    if (action === 'save') {
      if (!name || !repo) throw new CliError('mac recipe save <name> owner/repo [build options] [--every <hours> | --daily HH:MM]');
      const request = await repoRequest(be, repo, opts);
      const schedule = opts.daily ? { type: 'daily', time: opts.daily } : opts.every ? { type: 'interval', hours: Number(opts.every) } : { type: 'manual' };
      const { recipes } = await be.call('/api/recipes');
      const existing = recipes.find((r) => r.name.toLowerCase() === name.toLowerCase());
      const saved = await be.call(existing ? `/api/recipes/${existing.id}` : '/api/recipes', { method: existing ? 'PUT' : 'POST', body: { name, request, schedule } });
      if (opts.json) console.log(JSON.stringify(saved, null, 2));
      else console.log(`${existing ? 'Updated' : 'Saved'} recipe ${bold(saved.name)}.${schedule.type === 'manual' ? '' : ' Schedules run while the app server is running.'}`);
      return 0;
    }
    if (action === 'rm') {
      const { recipes } = await be.call('/api/recipes');
      const r = recipes.find((x) => x.id === name || x.name.toLowerCase() === String(name).toLowerCase());
      if (!r) throw new CliError(`No recipe called "${name}".`);
      await be.call(`/api/recipes/${r.id}`, { method: 'DELETE' });
      console.log(`Removed recipe ${r.name}.`);
      return 0;
    }
    throw new CliError('mac recipe <run|save|rm> <name>');
  },

  async sweep(be, args, opts) {
    const { deleted } = await be.call('/api/sweep', { method: 'POST' });
    if (opts.json) console.log(JSON.stringify(deleted));
    else console.log(deleted.length ? `Deleted ${deleted.join(', ')}` : 'No leftovers.');
    return 0;
  },
};

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP.trimEnd()); return 0; }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') { console.log(VERSION); return 0; }
  if (cmd === 'crypt') {
    const crypt = fileURLToPath(new URL('./mac-crypt.mjs', import.meta.url));
    const { spawnSync } = await import('node:child_process');
    return spawnSync(process.execPath, [crypt, ...rest], { stdio: 'inherit' }).status ?? 1;
  }
  if (cmd === 'serve') {
    const { values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
    if (values.port) process.env.PORT = values.port;
    const server = fileURLToPath(new URL('./server.js', import.meta.url));
    const { spawnSync } = await import('node:child_process');
    return spawnSync(process.execPath, [server], { stdio: 'inherit', env: process.env }).status ?? 1;
  }
  const command = COMMANDS[cmd];
  if (!command) throw new CliError(`Unknown command "${cmd}". Run mac --help.`);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new CliError(err.message);
  }
  const { values: opts, positionals } = parsed;
  if (opts.help) { console.log(HELP.trimEnd()); return 0; }
  const server = opts.server || process.env.MAC_SERVER;
  const be = server ? await remoteBackend(server, opts.key || process.env.MAC_ACCESS_KEY) : await localBackend(opts);
  const onInt = async () => {
    console.error(dim('\nStopping. Builds keep running on GitHub; pick one up again with mac watch <id>.'));
    await be.close().catch(() => {});
    process.exit(130);
  };
  process.once('SIGINT', onInt);
  try {
    return await command(be, positionals, opts);
  } finally {
    process.off('SIGINT', onInt);
    await be.close();
  }
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && isMain()) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => {
    console.error(`${coral('mac:')} ${err instanceof CliError ? err.message : err.stack || err.message}`);
    process.exit(2);
  });
}

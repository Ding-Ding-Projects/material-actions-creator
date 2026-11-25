#!/usr/bin/env node
// Drives the real web app in headless Chrome and checks the things a person
// would notice: every tab opens, nothing throws, the palette, personal
// wording, the tools and the extension consent flow all work.
//
//   node scripts/browser-check.mjs [--shots <dir>]
//
// Needs Chrome or Chromium (set CHROME_BIN to choose one). Starts its own
// server on a spare port with throwaway data, so it never touches real data.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const shotsAt = process.argv.indexOf('--shots');
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const chromeBin = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean)
  .find((b) => spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0);
if (!chromeBin) { console.error('Chrome or Chromium was not found. Install one or set CHROME_BIN.'); process.exit(2); }

const tmp = await mkdtemp(join(tmpdir(), 'mac-browser-'));
await mkdir(join(tmp, 'data', 'extensions'), { recursive: true });
await cp(join(ROOT, 'extension-samples', 'hello-shell'), join(tmp, 'data', 'extensions', 'hello-shell'), { recursive: true });
if (shots) await mkdir(shots, { recursive: true });

const appPort = await freePort();
const cdpPort = await freePort();
const base = `http://127.0.0.1:${appPort}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DATA_DIR: join(tmp, 'data'), SWEEP_ON_START: 'false', GITHUB_TOKEN: '', GH_TOKEN: '', APP_ACCESS_KEY: '' } });
const chrome = spawn(chromeBin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--remote-debugging-port=${cdpPort}`, '--window-size=1400,900', `--user-data-dir=${join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const cleanup = async () => { server.kill(); chrome.kill(); await sleep(200); await rm(tmp, { recursive: true, force: true }).catch(() => {}); };

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

try {
  await until(async () => (await fetch(`${base}/api/health`)).ok, 10_000, 'the app');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page'), 15_000, 'Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') problems.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') problems.push(`${d.params.entry.text} ${d.params.entry.url || ''}`);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const run = async (body) => {
    const res = await send('Runtime.evaluate', { expression: `(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));const $=(s)=>document.querySelector(s);${body}})()`, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };
  const shot = async (name) => { if (!shots) return; const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64')); };
  const check = async (name, body, expect = (v) => v === true) => {
    try {
      const v = await run(body);
      const good = expect(v);
      if (!good) failed++;
      console.log(`  ${good ? 'ok   ' : 'FAIL '} ${name}${good ? '' : `  → ${JSON.stringify(v)}`}`);
    } catch (err) { failed++; console.log(`  FAIL  ${name}  → ${err.message.split('\n')[0]}`); }
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `${base}/` });
  await until(() => run("return document.querySelectorAll('.tab2').length > 0"), 10_000, 'the tab strip');
  await sleep(800);

  console.log(`\n  ${chromeBin} · ${base}\n`);
  await check('First run opens the setup wizard', "return !!$('dialog.onboarding[open]')");
  await shot('01-setup-wizard');
  await check('Setup wizard: Next, Back and finish', `
    const d = $('dialog.onboarding'); const step = () => d.querySelector('[role=progressbar]').getAttribute('aria-valuenow');
    d.querySelector('[data-ob=next]').click(); await wait(300); const two = step();
    d.querySelector('[data-ob=back]').click(); await wait(300); const one = step();
    for (let i = 0; i < 5; i++) { $('dialog.onboarding [data-ob=next]')?.click(); await wait(250); }
    return [one, two, !$('dialog.onboarding')].join()`, (v) => v === '1,2,true');
  await check('Tour starts after setup and can be skipped', "const p = $('.tour-pop'); if (!p) return false; p.querySelector('[data-tour=skip]').click(); await wait(200); return !$('.tour-pop')");
  await check('Every page is open as a tab', "return [...document.querySelectorAll('.tab2')].length", (n) => n >= 10);
  await check('Every tab mounts with content', `
    const empty = [];
    for (const id of [...document.querySelectorAll('.tab2-main')].map((b) => b.id.replace('tab-', ''))) { $('#tab-' + id).click(); await wait(450); const v = $('#view-' + id); if (!v || v.hidden || v.innerText.trim().length < 20) empty.push(id); }
    return empty`, (v) => Array.isArray(v) && v.length === 0);
  await check('Front screen shows version and update time', "return /\\d+\\.\\d+\\.\\d+/.test($('[data-provenance]').textContent)");
  await check('Ctrl+Shift+F opens the palette and finds a setting', `
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, bubbles: true })); await wait(300);
    const d = $('dialog.palette[open]'); if (!d) return 'no palette';
    const i = d.querySelector('input'); i.value = 'motion'; i.dispatchEvent(new Event('input', { bubbles: true })); await wait(300);
    const n = d.querySelectorAll('.pal-list li').length; d.close(); return n`, (n) => n > 0);
  await shot('02-tabs');
  await check('Personal wording rewrites failure text and stays out of history', `
    const vocab = await import('/js/core/vocab.js'); const i18n = await import('/js/core/i18n.js'); const store = await import('/js/core/store.js');
    const r = vocab.load(JSON.stringify({ schemaVersion: 1, name: 'check', entries: { 'the workflow run failed': 'my build broke', 'the build failed': 'my build broke' } }));
    const a = i18n.t('runs.failedSentence'); const b = i18n.v('Error: The build failed on step 3');
    const leaked = JSON.stringify(store.history()).includes('my build broke');
    vocab.clear();
    return [a.startsWith('My build broke'), b, leaked, i18n.t('runs.failedSentence').startsWith('The workflow run failed')].join('|')`, (v) => v === 'true|Error: My build broke on step 3|false|true');
  await check('Cantonese mode translates the tab strip', `
    const store = await import('/js/core/store.js'); store.set('lang', 'yue'); await wait(300);
    const t = $('#tab-settings .tab2-label').textContent; store.set('lang', 'en'); await wait(300);
    return t !== $('#tab-settings .tab2-label').textContent`);
  await check('Tools: Base64 encodes as you type', `
    $('#tab-tools').click(); await wait(600);
    const [a, b] = $('#view-tools').querySelectorAll('textarea'); a.value = 'hello'; a.dispatchEvent(new Event('input', { bubbles: true })); await wait(400);
    return b.value`, (v) => v === 'aGVsbG8=');
  await check('Extensions: built-ins listed and on', `
    $('#tab-extensions').click(); await wait(900);
    return [...document.querySelectorAll('.ext-card.on')].map((c) => c.dataset.ext).sort().join()`, (v) => v === 'build-summary,checksums,workflow-lint');
  await check('Extensions: a new extension asks before it runs', `
    $('[data-ext="hello-shell"] [data-ext-toggle]').click(); await wait(400);
    const d = $('dialog.ext-consent[open]'); if (!d) return 'no consent dialog';
    d.querySelector('[data-deny]').click(); await wait(600);
    const stillOff = !$('[data-ext="hello-shell"]').classList.contains('on');
    $('[data-ext="hello-shell"] [data-ext-toggle]').click(); await wait(400);
    $('dialog.ext-consent [data-allow]').click(); await wait(900);
    return stillOff && $('[data-ext="hello-shell"]').classList.contains('on')`);
  await check('Extensions: gallery adds a sample, and it starts off', `
    const b = $('[data-sample="size-budget"] [data-ext-add]'); if (!b) return 'no gallery';
    b.click(); await wait(1200);
    const card = $('[data-ext="size-budget"]');
    return !!card && !card.classList.contains('on') && $('[data-sample="size-budget"] [data-ext-add]').disabled && !!$('.ext-iso-title')`);
  await shot('03-extensions');
  if (process.platform !== 'win32') {
    await check('Extensions: the sh sample runs and shows its reply', `
      $('[data-ext="hello-shell"] [data-ext-run]').requestSubmit(); await wait(1500);
      return $('[data-ext="hello-shell"] .ext-summary')?.textContent || ''`, (v) => /Extension id: hello-shell/.test(v));
  }
  if (process.platform !== 'win32') {
    await mkdir(join(tmp, 'project'), { recursive: true });
    await writeFile(join(tmp, 'project', 'build.sh'), 'mkdir -p dist\necho building\necho ok > dist/out.txt\n');
    await check('Local run: pick This computer, scan a folder, build, download', `
      $('#tab-workflows').click(); await wait(500);
      $('[data-mode="local"]').click(); await wait(900);
      const caps = document.querySelectorAll('.cap-list li').length;
      const p = $('#wfLocalPath'); p.value = ${JSON.stringify(join(tmp, 'project'))}; p.dispatchEvent(new Event('input', { bubbles: true }));
      $('#wfScan').click(); await wait(1200);
      $('#wfAllScripts').click(); await wait(200);
      const o = $('#wfOutputs'); o.value = 'dist/**'; o.dispatchEvent(new Event('input', { bubbles: true })); await wait(400);
      $('#wfRun').click();
      let job;
      for (let i = 0; i < 60; i++) { await wait(250); job = (await (await fetch('/api/builds')).json())[0]; if (job && job.status !== 'running') break; }
      const text = job?.outputs?.[0] ? await (await fetch(job.outputs[0].url)).text() : '';
      $('[data-mode="private"]').click(); await wait(300);
      return [caps, job?.mode, job?.status, text.trim(), !!job?.logUrl].join()`, (v) => v === '7,local,ready,ok,true');
  }
  await check('Recipes: save the Workflows form, set a schedule, delete', `
    localStorage.setItem('mac-wf', JSON.stringify({ repo: 'owner/repo', ref: 'main', runner: 'ubuntu-latest', mode: 'private', outputs: 'dist/**', scripts: [{ path: 'build.sh', on: true }], workflows: [] }));
    const r = await fetch('/api/recipes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Check recipe', request: { kind: 'scripts', repo: 'owner/repo', scripts: ['build.sh'], outputs: 'dist/**', runner: 'ubuntu-latest' } }) });
    if (r.status !== 201) return 'save ' + r.status;
    $('#tab-recipes').click(); await wait(900);
    const card = $('.rec-card'); if (!card) return 'no card';
    const sel = card.querySelector('[data-rec-type]'); sel.value = 'interval'; sel.dispatchEvent(new Event('change', { bubbles: true })); await wait(900);
    const next = /next:/.test($('.rec-card .rec-status').textContent);
    const id = $('.rec-card').dataset.rec; await fetch('/api/recipes/' + id, { method: 'DELETE' }); await wait(700);
    return [next, !$('.rec-card')].join()`, (v) => v === 'true,true');
  await check('Workspace: dock panels, timing chart and saved layout', `
    const runs = await import('/js/views/runs.js'); const now = Date.now();
    runs.upsert({ id: 'check1', title: 'owner/repo', platform: 'ubuntu-latest', mode: 'private', status: 'running', createdAt: now - 60000, updatedAt: now, stages: [], outputs: [], steps: [
      { name: 'Set up job', status: 'completed', conclusion: 'success', startedAt: now - 50000, completedAt: now - 47000 },
      { name: 'Run build.sh', status: 'in_progress', conclusion: null, startedAt: now - 47000, completedAt: null }] });
    $('#tab-workspace').click(); await wait(2500);
    $('[data-run="check1"]').click(); await wait(400);
    const panels = document.querySelectorAll('.ws-panel').length; const bars = document.querySelectorAll('.ws-bar-row').length;
    const saved = !!JSON.parse(localStorage.getItem('mac.workspace.v1') || 'null')?.panels;
    runs.removeBuild('check1');
    return [panels, bars, saved].join()`, (v) => v === '5,2,true');
  await shot('05-workspace');
  await check('Workflow check runs through an extension', `
    const { lintWorkflow } = await import('/js/views/extensions.js');
    const r = await lintWorkflow('jobs:\\n  a:\\n    steps:\\n      - uses: actions/checkout@v4\\n');
    return r.length === 1 && r[0].run.ok && r[0].run.result.findings.length`, (v) => v === 2);
  await check('Reduced motion switches animation off', `
    const store = await import('/js/core/store.js'); store.set('motion', 'reduced'); await wait(200);
    const d = getComputedStyle($('.tab2')).transitionDuration; store.set('motion', 'full');
    return parseFloat(d) < 0.001`);
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  await check('Narrow screen: page fits 360 px', "$('#tab-workflows').click(); await wait(500); return document.documentElement.scrollWidth", (w) => w <= 362);
  await shot('04-narrow');
  await check('No errors in the browser console', `return ${JSON.stringify(problems)}`, () => problems.length === 0);
  if (problems.length) for (const p of problems.slice(0, 10)) console.log(`        ${p.split('\n')[0]}`);
  ws.close();
} catch (err) {
  failed++;
  console.error(`  FAIL  ${err.message}`);
} finally {
  await cleanup();
}
console.log(failed ? `\n  ${failed} check(s) failed.` : '\n  Browser check passed.');
process.exit(failed ? 1 : 0);

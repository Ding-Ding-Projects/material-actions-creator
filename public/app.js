const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const TEMPLATES = {
  Node: `FROM node:22-alpine\nWORKDIR /app\nCOPY server.js .\nEXPOSE 3000\nCMD ["node", "server.js"]\n`,
  Python: `FROM python:3.13-slim\nWORKDIR /app\nRUN pip install --no-cache-dir flask\nCOPY app.py .\nCMD ["python", "app.py"]\n`,
  Nginx: `FROM nginx:alpine\nCOPY index.html /usr/share/nginx/html/index.html\n`,
  Alpine: `FROM alpine:3.20\nRUN apk add --no-cache curl jq\nCMD ["sh"]\n`,
};
const TEMPLATE_FILES = {
  Node: [{ path: 'server.js', content: "require('http').createServer((q, r) => r.end('hello')).listen(3000);\n" }],
  Python: [{ path: 'app.py', content: "from flask import Flask\napp = Flask(__name__)\n\n@app.get('/')\ndef hi():\n    return 'hello'\n\napp.run(host='0.0.0.0')\n" }],
  Nginx: [{ path: 'index.html', content: '<h1>hello</h1>\n' }],
  Alpine: [],
};
const MODE_COPY = {
  private: { title: 'Private temp repo', body: 'Throwaway private repository. Code stays private; uses your account’s Actions minutes.' },
  'encrypted-public': { title: 'Encrypted public builder', body: 'Throwaway public repository. Sources and outputs are encrypted with a per-run key that only lives in an Actions secret.' },
};

const savedWf = store.get('mac-wf', {});
const state = {
  tab: store.get('mac-tab', 'workflows'),
  files: [{ path: 'Dockerfile', content: TEMPLATES.Alpine, fixed: true }],
  active: 0,
  platform: 'linux/amd64',
  platforms: ['linux/amd64'],
  runners: ['windows-latest'],
  args: [],
  dockerMode: 'private',
  wf: {
    repo: savedWf.repo || '',
    ref: savedWf.ref || '',
    scripts: savedWf.scripts || [],
    workflows: savedWf.workflows || [],
    runner: savedWf.runner || 'windows-latest',
    outputs: savedWf.outputs || 'dist/**/*.exe, dist/**/*.msi',
    mode: savedWf.mode || 'private',
  },
  builds: new Map(),
  auth: null,
  config: {},
  key: sessionStorage.getItem('mac-key') || '',
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(state.key ? { 'x-access-key': state.key } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.accessKeyRequired) { $('#keyDialog').showModal(); throw new Error('Access key required'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n; let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}

/* ---------- Tabs ---------- */
function setTab(tab) {
  state.tab = tab;
  store.set('mac-tab', tab);
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== tab; });
}
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ---------- Mode cards ---------- */
function renderModes() {
  for (const group of $$('[data-mode-group]')) {
    const g = group.dataset.modeGroup;
    const current = g === 'wf' ? state.wf.mode : state.dockerMode;
    group.innerHTML = Object.entries(MODE_COPY).map(([id, m]) => `
      <button type="button" class="mode ${id === 'encrypted-public' ? 'enc' : ''}" aria-pressed="${id === current}" data-mode="${id}">
        <span class="mode-title">${id === 'encrypted-public' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>' : ''}${m.title}</span>
        <span class="mode-body">${m.body}</span>
        ${id === 'encrypted-public' ? `<span class="mode-key">${state.config.githubApp ? 'Temporary key: GitHub App token, 1 hour, revoked after the run' : 'Temporary key: your signed-in session (add a GitHub App for 1-hour keys)'}</span>` : ''}
      </button>`).join('');
  }
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  const g = btn.closest('[data-mode-group]').dataset.modeGroup;
  if (g === 'wf') { state.wf.mode = btn.dataset.mode; saveWf(); schedulePreview(); }
  else { state.dockerMode = btn.dataset.mode; renderDockerSummary(); }
  renderModes();
});

/* ---------- Workflow creator ---------- */
function saveWf() { store.set('mac-wf', state.wf); }

function renderScripts() {
  const list = $('#wfScripts');
  if (!state.wf.scripts.length) { list.innerHTML = ''; return; }
  list.innerHTML = state.wf.scripts.map((s, i) => `
    <li class="script ${s.on ? 'on' : ''}">
      <label><input type="checkbox" data-sc-toggle="${i}" ${s.on ? 'checked' : ''}> <span class="n">${String(i + 1).padStart(2, '0')}</span> <span class="path">${esc(s.path)}</span></label>
      <span class="order">
        <button type="button" class="icon-btn" data-sc-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-sc-down="${i}" aria-label="Move down" ${i === state.wf.scripts.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
    </li>`).join('');
}
function renderWorkflows() {
  const list = $('#wfWorkflows');
  list.innerHTML = state.wf.workflows.map((w, i) => `
    <li class="script ${w.on ? 'on' : ''} ${w.dispatchable ? '' : 'disabled'}">
      <label><input type="checkbox" data-wf-toggle="${i}" ${w.on ? 'checked' : ''} ${w.dispatchable ? '' : 'disabled'}>
        <span class="wf-text"><span class="path">${esc(w.name)}</span><span class="wf-path">${esc(w.path)}${w.dispatchable ? '' : ' · callable only'}</span></span></label>
      ${w.warnings?.length ? `<details class="wf-warn"><summary>${w.warnings.length} change${w.warnings.length === 1 ? '' : 's'}</summary><ul>${w.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    </li>`).join('');
}
$('#wfWorkflows').addEventListener('change', (e) => {
  const t = e.target.closest('[data-wf-toggle]');
  if (!t) return;
  state.wf.workflows[+t.dataset.wfToggle].on = t.checked;
  saveWf(); renderWorkflows(); schedulePreview();
});
$('#wfAllWorkflows').addEventListener('click', () => { state.wf.workflows.forEach((w) => { w.on = w.dispatchable; }); saveWf(); renderWorkflows(); schedulePreview(); });
$('#wfNoWorkflows').addEventListener('click', () => { state.wf.workflows.forEach((w) => { w.on = false; }); saveWf(); renderWorkflows(); schedulePreview(); });
$('#wfAllScripts').addEventListener('click', () => { state.wf.scripts.forEach((s) => { s.on = true; }); saveWf(); renderScripts(); schedulePreview(); });
$('#wfNoScripts').addEventListener('click', () => { state.wf.scripts.forEach((s) => { s.on = false; }); saveWf(); renderScripts(); schedulePreview(); });

$('#wfScripts').addEventListener('click', (e) => {
  const s = state.wf.scripts;
  const up = e.target.closest('[data-sc-up]'); const down = e.target.closest('[data-sc-down]');
  if (up) { const i = +up.dataset.scUp; [s[i - 1], s[i]] = [s[i], s[i - 1]]; }
  else if (down) { const i = +down.dataset.scDown; [s[i + 1], s[i]] = [s[i], s[i + 1]]; }
  else return;
  saveWf(); renderScripts(); schedulePreview();
});
$('#wfScripts').addEventListener('change', (e) => {
  const t = e.target.closest('[data-sc-toggle]');
  if (!t) return;
  state.wf.scripts[+t.dataset.scToggle].on = t.checked;
  saveWf(); renderScripts(); schedulePreview();
});
function addScript() {
  const v = $('#wfAddScript').value.trim();
  if (!v) return;
  if (!state.wf.scripts.some((s) => s.path === v)) state.wf.scripts.push({ path: v, on: true });
  $('#wfAddScript').value = '';
  saveWf(); renderScripts(); schedulePreview();
}
$('#wfAddScriptBtn').addEventListener('click', addScript);
$('#wfAddScript').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addScript(); } });

$('#wfScan').addEventListener('click', async () => {
  const btn = $('#wfScan');
  btn.disabled = true;
  $('#wfScriptHint').textContent = 'Scanning…';
  try {
    const q = new URLSearchParams({ repo: $('#wfRepo').value.trim(), mode: state.wf.mode });
    if ($('#wfRef').value.trim()) q.set('ref', $('#wfRef').value.trim());
    const r = await api(`/api/scripts?${q}`);
    state.wf.repo = r.repo;
    state.wf.ref = r.ref;
    $('#wfRepo').value = r.repo; $('#wfRef').value = r.ref;
    const keep = new Map(state.wf.scripts.map((s) => [s.path, s.on]));
    state.wf.scripts = r.scripts.map((p) => ({ path: p, on: keep.has(p) ? keep.get(p) : /install|build|setup|package|release/i.test(p) }));
    if (!state.wf.scripts.some((s) => s.on) && state.wf.scripts[0]) state.wf.scripts[0].on = true;
    if (!savedWf.outputs) { state.wf.outputs = r.outputsGuess; $('#wfOutputs').value = r.outputsGuess; }
    $('#wfScriptHint').textContent = r.scripts.length ? `Found ${r.scripts.length} script${r.scripts.length === 1 ? '' : 's'} · tick and order them` : 'No scripts found — add a path below';
    const keepWf = new Map(state.wf.workflows.map((w) => [w.path, w.on]));
    state.wf.workflows = r.workflows.map((w) => ({ ...w, on: w.dispatchable && (keepWf.get(w.path) ?? false) }));
    $('#wfWorkflowHint').textContent = r.workflows.length ? `Found ${r.workflows.length} workflow${r.workflows.length === 1 ? '' : 's'}` : 'This repository has no workflows';
    saveWf(); renderScripts(); renderWorkflows(); schedulePreview();
  } catch (err) {
    $('#wfScriptHint').textContent = err.message;
  } finally { btn.disabled = false; }
});

for (const [id, key] of [['#wfRepo', 'repo'], ['#wfRef', 'ref'], ['#wfOutputs', 'outputs']]) {
  $(id).value = state.wf[key];
  $(id).addEventListener('input', (e) => { state.wf[key] = e.target.value; saveWf(); schedulePreview(); });
}

function renderRunners() {
  $('#wfRunners').innerHTML = state.runners.map((r) => `<button type="button" role="radio" class="chip-btn" aria-checked="${r === state.wf.runner}" data-runner="${r}">${r}</button>`).join('');
}
$('#wfRunners').addEventListener('click', (e) => {
  const b = e.target.closest('[data-runner]');
  if (!b) return;
  state.wf.runner = b.dataset.runner; saveWf(); renderRunners(); schedulePreview();
});

function wfRequest() {
  return {
    kind: 'scripts',
    repo: state.wf.repo,
    ref: state.wf.ref,
    runner: state.wf.runner,
    scripts: state.wf.scripts.filter((s) => s.on).map((s) => s.path),
    workflows: state.wf.workflows.filter((w) => w.on).map((w) => w.path),
    outputs: state.wf.outputs,
    mode: state.wf.mode,
  };
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
  const r = wfRequest();
  $('#wfSummary').textContent = `${r.scripts.length} script${r.scripts.length === 1 ? '' : 's'} · ${r.workflows.length} workflow${r.workflows.length === 1 ? '' : 's'} · ${MODE_COPY[r.mode].title.toLowerCase()}`;
}
async function renderPreview() {
  try {
    const req = wfRequest();
    if (!req.scripts.length && req.workflows.length) {
      $('#wfYaml').innerHTML = esc(`# No generated script workflow.\n# These repository workflows will run, rewritten:\n${req.workflows.map((w) => `#   ${w}`).join('\n')}\n`);
      $('#wfYamlState').textContent = 'workflows only';
      $('#wfYamlState').className = 'ok';
      $('#wfYaml').dataset.yaml = '';
      return;
    }
    const { yaml } = await api('/api/preview', { method: 'POST', body: req });
    $('#wfYaml').innerHTML = highlightYaml(yaml);
    $('#wfYamlState').textContent = 'live preview';
    $('#wfYamlState').className = 'ok';
    $('#wfYaml').dataset.yaml = yaml;
  } catch (err) {
    $('#wfYamlState').textContent = err.message;
    $('#wfYamlState').className = 'warn';
  }
}
function highlightYaml(src) {
  return src.split('\n').map((line) => {
    let out = esc(line);
    out = out.replace(/^(\s*-?\s*)([A-Za-z_][\w-]*)(:)/, '$1<span class="tk-key">$2</span>$3');
    out = out.replace(/(\$\{\{.*?\}\})/g, '<span class="tk-var">$1</span>');
    out = out.replace(/(&quot;.*?&quot;)/g, '<span class="tk-str">$1</span>');
    out = out.replace(/(crypt\.mjs (?:open|seal))/g, '<span class="tk-flag">$1</span>');
    return out;
  }).join('\n');
}

$('#wfExport').addEventListener('click', () => {
  const yaml = $('#wfYaml').dataset.yaml;
  if (!yaml) return toast('Fix the form first — nothing to export yet');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
  a.download = 'build.yml';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#wfRun').addEventListener('click', async () => {
  $('#wfHint').textContent = '';
  if (!state.auth?.signedIn) { openAuth(); return; }
  const btn = $('#wfRun');
  btn.disabled = true;
  try {
    const job = await api('/api/builds', { method: 'POST', body: wfRequest() });
    upsertBuild(job);
    setTab('runs');
    toast(job.mode === 'encrypted-public' ? 'Encrypting sources for a public builder…' : 'Spinning up a temporary repository…');
  } catch (err) { $('#wfHint').textContent = err.message; }
  finally { btn.disabled = false; }
});

/* ---------- Dockerfile editor ---------- */
const KW = /^(\s*)(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i;
function highlightDockerfile(src) {
  return src.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return `<span class="tk-com">${esc(line)}</span>`;
    let out = esc(line);
    out = out.replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="tk-str">$1</span>');
    out = out.replace(/(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/g, '<span class="tk-var">$1</span>');
    out = out.replace(/(^|\s)(--[a-z-]+)/g, '$1<span class="tk-flag">$2</span>');
    out = out.replace(KW, '$1<span class="tk-kw">$2</span>');
    out = out.replace(/\b(AS)\b/g, '<span class="tk-kw">$1</span>');
    return out;
  }).join('\n');
}

function renderEditor() {
  const f = state.files[state.active];
  const code = $('#code');
  if (code.value !== f.content) code.value = f.content;
  $('#highlight').innerHTML = (f.path === 'Dockerfile' ? highlightDockerfile(f.content) : esc(f.content)) + '\n';
  $('#gutter').textContent = Array.from({ length: f.content.split('\n').length }, (_, i) => i + 1).join('\n');
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = state.files.map((f, i) => `
    <button class="tab" role="tab" type="button" data-i="${i}" aria-selected="${i === state.active}">
      ${f.editing ? `<input data-rename="${i}" value="${esc(f.path)}">` : esc(f.path)}
      ${f.fixed ? '' : `<span class="x" data-del="${i}" title="Remove file">×</span>`}
    </button>`).join('') + '<button class="tab add" type="button" id="addFile">+ file</button>';
  const input = tabs.querySelector('input');
  if (input) { input.focus(); input.select(); }
}

$('#tabs').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { state.files.splice(Number(del.dataset.del), 1); state.active = 0; return renderAll(); }
  if (e.target.closest('#addFile')) {
    state.files.push({ path: `file${state.files.length}.txt`, content: '', editing: true });
    state.active = state.files.length - 1;
    return renderAll();
  }
  const tab = e.target.closest('.tab[data-i]');
  if (tab && !e.target.matches('input')) {
    const i = Number(tab.dataset.i);
    if (i === state.active && !state.files[i].fixed) state.files[i].editing = true;
    state.active = i;
    renderAll();
  }
});
$('#tabs').addEventListener('keydown', (e) => {
  if (e.target.matches('[data-rename]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});
$('#tabs').addEventListener('focusout', (e) => {
  if (!e.target.matches('[data-rename]')) return;
  const f = state.files[Number(e.target.dataset.rename)];
  f.path = e.target.value.trim() || f.path;
  f.editing = false;
  renderTabs();
});
$('#code').addEventListener('input', (e) => { state.files[state.active].content = e.target.value; renderEditor(); });
$('#code').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
    e.target.dispatchEvent(new Event('input'));
  }
});

$('#templates').innerHTML = Object.keys(TEMPLATES).map((k) => `<button class="chip" type="button" data-t="${k}">${k}</button>`).join('');
$('#templates').addEventListener('click', (e) => {
  const k = e.target.dataset.t;
  if (!k) return;
  state.files = [{ path: 'Dockerfile', content: TEMPLATES[k], fixed: true }, ...TEMPLATE_FILES[k].map((f) => ({ ...f }))];
  state.active = 0;
  $('#imageName').value = `${k.toLowerCase()}-app:latest`;
  renderAll();
});

function renderPlatforms() {
  $('#platforms').innerHTML = state.platforms.map((p) => `<button type="button" role="radio" aria-checked="${p === state.platform}" data-p="${p}">${p.replace('linux/', '')}</button>`).join('');
  renderDockerSummary();
}
$('#platforms').addEventListener('click', (e) => {
  if (!e.target.dataset.p) return;
  state.platform = e.target.dataset.p;
  renderPlatforms();
});
function renderDockerSummary() {
  $('#dockerSummary').textContent = `${state.platform} · ${MODE_COPY[state.dockerMode].title.toLowerCase()}`;
}

function renderArgs() {
  $('#argList').innerHTML = state.args.map((a, i) => `
    <div class="arg-row">
      <input placeholder="NAME" value="${esc(a.k)}" data-ak="${i}" spellcheck="false" aria-label="Argument name">
      <input placeholder="value" value="${esc(a.v)}" data-av="${i}" spellcheck="false" aria-label="Argument value">
      <button class="icon-btn" type="button" data-adel="${i}" aria-label="Remove">×</button>
    </div>`).join('');
  $('#argCount').textContent = state.args.length;
}
$('#addArg').addEventListener('click', () => { state.args.push({ k: '', v: '' }); renderArgs(); });
$('#argList').addEventListener('input', (e) => {
  if (e.target.dataset.ak) state.args[e.target.dataset.ak].k = e.target.value;
  if (e.target.dataset.av) state.args[e.target.dataset.av].v = e.target.value;
});
$('#argList').addEventListener('click', (e) => {
  if (e.target.dataset.adel) { state.args.splice(Number(e.target.dataset.adel), 1); renderArgs(); }
});
function renderAll() { renderTabs(); renderEditor(); }

$('#buildBtn').addEventListener('click', async () => {
  $('#formHint').textContent = '';
  if (!state.auth?.signedIn) { openAuth(); return; }
  const btn = $('#buildBtn');
  btn.disabled = true;
  try {
    const [docker, ...rest] = state.files;
    const buildArgs = Object.fromEntries(state.args.filter((a) => a.k).map((a) => [a.k, a.v]));
    const job = await api('/api/builds', {
      method: 'POST',
      body: { kind: 'dockerfile', mode: state.dockerMode, dockerfile: docker.content, files: rest.map(({ path, content }) => ({ path, content })), imageName: $('#imageName').value, platform: state.platform, buildArgs },
    });
    upsertBuild(job);
    setTab('runs');
    toast('Build queued');
  } catch (err) { $('#formHint').textContent = err.message; }
  finally { btn.disabled = false; }
});

/* ---------- Runs ---------- */
function elapsed(job) {
  const end = job.status === 'running' ? Date.now() : job.updatedAt;
  const s = Math.max(0, Math.round((end - job.createdAt) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
function countdown(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function buildCard(job) {
  const key = state.key ? `?key=${encodeURIComponent(state.key)}` : '';
  const enc = job.mode === 'encrypted-public';
  const expires = job.expiresAt && job.status === 'ready' ? ` · links expire ${new Date(job.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  const showKey = enc && job.status === 'running' && job.keyExpiresAt;
  return `
    <div class="run-top">
      <div class="run-id">
        <div class="run-name">${esc(job.title || job.imageName)}</div>
        <div class="run-meta">${esc(job.subtitle || job.platform)} · <span data-elapsed>${elapsed(job)}</span>${expires}</div>
        <div class="badges">
          ${enc ? '<span class="badge enc">encrypted public</span>' : '<span class="badge">private</span>'}
          ${job.recovered ? '<span class="badge warn">resumed after restart</span>' : ''}
          ${showKey ? `<span class="badge key">key expires <b data-key-exp="${job.keyExpiresAt}">${countdown(job.keyExpiresAt)}</b></span>` : ''}
        </div>
      </div>
      <span class="status ${job.status}">${job.status}</span>
    </div>
    <div class="track" style="grid-template-columns: repeat(${job.stages.length}, 1fr)">${job.stages.map((s) => `<i class="${s.state}" title="${esc(s.label)}"></i>`).join('')}</div>
    <ol class="stages">${job.stages.map((s) => `
      <li class="${s.state}"><span class="dot"></span><span>${esc(s.label)}</span><span class="detail" title="${esc(s.detail)}">${esc(s.detail || '')}</span></li>`).join('')}
    </ol>
    ${job.runs?.length > 1 ? `<div class="subruns">${job.runs.map((r) => `<a class="subrun ${r.conclusion || r.status}" ${r.url && job.status === 'running' ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''}><span class="dot"></span>${esc(r.name)}<span class="muted">${esc(r.conclusion || r.status)}</span></a>`).join('')}</div>` : ''}
    ${job.warnings?.length ? `<details class="wf-warn run-warn"><summary>${job.warnings.length} workflow change${job.warnings.length === 1 ? '' : 's'}</summary><ul>${job.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    ${job.error ? `<p class="run-error">${esc(job.error)}</p>` : ''}
    ${job.outputs?.length && job.status === 'ready' ? `
      <div class="laps">
        <div class="laps-head"><span>Outputs</span>${enc ? '<span class="ok">✓ decrypted</span>' : ''}</div>
        ${job.outputs.map((o) => `
          <div class="lap">
            <span class="lap-name" title="${esc(o.name)}">${esc(o.name)}</span>
            <span class="lap-size">${formatBytes(o.size)}</span>
            <a class="btn primary small" href="${o.url}${key}" download>↓ Download</a>
          </div>`).join('')}
        ${job.kind === 'dockerfile' ? `<div class="load-cmd">docker load -i ${esc(job.outputs[0].name.split('/').pop())}</div>` : ''}
      </div>` : ''}
    <div class="run-actions">
      ${job.runUrl && job.status === 'running' ? `<a class="btn" href="${esc(job.runUrl)}" target="_blank" rel="noopener">Watch run ↗</a>` : ''}
      ${job.status !== 'running' ? `<button class="btn quiet" type="button" data-remove="${job.id}">Dismiss</button>` : ''}
    </div>`;
}

function upsertBuild(job) {
  state.builds.set(job.id, job);
  let el = document.getElementById(`run-${job.id}`);
  if (!el) {
    el = document.createElement('article');
    el.id = `run-${job.id}`;
    $('#runList').prepend(el);
  }
  el.className = `run ${job.status}${job.mode === 'encrypted-public' ? ' enc' : ''}`;
  el.innerHTML = buildCard(job);
  updateCounts();
}
function updateCounts() {
  $('#emptyRuns').hidden = state.builds.size > 0;
  const live = [...state.builds.values()].filter((j) => j.status === 'running').length;
  $('#liveCount').hidden = live === 0;
  $('#liveCount').textContent = live;
}

$('#runList').addEventListener('click', async (e) => {
  const id = e.target.dataset.remove;
  if (!id) return;
  try {
    await api(`/api/builds/${id}`, { method: 'DELETE' });
    state.builds.delete(id);
    document.getElementById(`run-${id}`)?.remove();
    updateCounts();
  } catch (err) { toast(err.message); }
});

$('#sweepBtn').addEventListener('click', async () => {
  try {
    const { deleted } = await api('/api/sweep', { method: 'POST' });
    toast(deleted.length ? `Deleted ${deleted.length} leftover repositories` : 'No leftovers — all clean');
  } catch (err) { toast(err.message); }
});

setInterval(() => {
  for (const job of state.builds.values()) {
    if (job.status !== 'running') continue;
    const el = document.querySelector(`#run-${job.id} [data-elapsed]`);
    if (el) el.textContent = elapsed(job);
    const k = document.querySelector(`#run-${job.id} [data-key-exp]`);
    if (k) k.textContent = countdown(Number(k.dataset.keyExp));
  }
}, 1000);

/* ---------- Recovery ---------- */
function renderRecovery(r) {
  const box = $('#recovery');
  if (!r || !r.builds?.length) { box.hidden = true; return; }
  const mins = Math.max(1, Math.round(r.offlineMs / 60000));
  const n = r.builds.length;
  $('#recoveryTitle').textContent = `The app was offline for about ${mins} minute${mins === 1 ? '' : 's'}`;
  $('#recoveryBody').textContent = `${n} build${n === 1 ? '' : 's'} kept going on GitHub and ${n === 1 ? 'was' : 'were'} picked up again from the run journal.`;
  box.hidden = false;
}
$('#recoveryView').addEventListener('click', () => setTab('runs'));
$('#recoveryDismiss').addEventListener('click', async () => {
  $('#recovery').hidden = true;
  try { await api('/api/recovery/dismiss', { method: 'POST' }); } catch { /* ignore */ }
});

/* ---------- Auth ---------- */
function renderAccount() {
  const a = state.auth;
  $('#accountName').textContent = a?.signedIn ? a.login : 'Sign in';
  $('#avatar').style.backgroundImage = a?.avatarUrl ? `url("${a.avatarUrl}")` : '';
  $('#scopeDots').innerHTML = (a?.required || []).map((s) => `<i class="${a.signedIn && !a.missing.includes(s) ? 'ok' : 'miss'}" title="${s}"></i>`).join('');
}
function scopesHtml(a) {
  return `<div class="scopes">${a.required.map((s) => `<span class="scope ${a.signedIn && !a.missing.includes(s) ? 'ok' : 'miss'}">${s}</span>`).join('')}</div>`;
}
function renderAuthDialog() {
  const a = state.auth || { required: [], missing: [] };
  const flow = a.flow || { state: 'idle' };
  const body = $('#authBody');
  if (['starting', 'waiting'].includes(flow.state)) {
    $('#authTitle').textContent = flow.mode === 'refresh' ? 'Add scopes' : 'Sign in';
    body.innerHTML = flow.code ? `
      <p class="muted">Open GitHub, paste this one-time code, and approve the <b>repo</b>, <b>workflow</b> and <b>delete_repo</b> scopes.</p>
      <div class="device-code"><strong>${esc(flow.code)}</strong><button class="btn" type="button" id="copyCode">Copy</button></div>
      <div class="stack">
        <a class="fab small" href="${esc(flow.url)}" target="_blank" rel="noopener">Open ${esc(flow.url.replace('https://', ''))} ↗</a>
        <button class="btn quiet" type="button" id="cancelLogin">Cancel</button>
      </div>
      <p class="waiting" style="margin-top:20px"><i></i><i></i><i></i> Waiting for GitHub to confirm…</p>`
      : '<p class="waiting"><i></i><i></i><i></i> Asking GitHub CLI for a device code…</p>';
    return;
  }
  if (a.signedIn) {
    $('#authTitle').textContent = a.login;
    const missing = a.missing.length > 0;
    body.innerHTML = `
      <p class="muted">Signed in via ${a.source === 'env' ? 'a token from the environment' : 'GitHub CLI'}${a.owner ? `, temporary repositories go to <b>${esc(a.owner)}</b>` : ''}.</p>
      ${scopesHtml(a)}
      ${missing ? '<p class="hint">Missing scopes — builds can fail until you add them.</p>' : ''}
      <div class="stack">
        ${a.source === 'gh' && missing ? '<button class="fab small" type="button" data-login="refresh">Add missing scopes</button>' : ''}
        ${a.source === 'gh' ? '<button class="btn" type="button" data-login="login">Switch account</button><button class="btn quiet" type="button" id="logout">Sign out</button>' : ''}
      </div>`;
    return;
  }
  $('#authTitle').textContent = 'Sign in';
  body.innerHTML = `
    <p class="muted">The server signs in with GitHub CLI using a device code. It asks for exactly the scopes it needs:</p>
    ${scopesHtml(a)}
    ${flow.state === 'error' ? `<p class="run-error">${esc(flow.error)}</p>` : ''}
    ${a.error ? `<p class="run-error">${esc(a.error)}</p>` : ''}
    <div class="stack">
      ${a.ghAvailable ? '<button class="fab small" type="button" data-login="login">Sign in with GitHub CLI</button>' : '<p class="hint">GitHub CLI is not installed on this server. Set GITHUB_TOKEN instead.</p>'}
    </div>`;
}
function openAuth() { renderAuthDialog(); $('#authDialog').showModal(); }
$('#accountBtn').addEventListener('click', openAuth);
$('#authBody').addEventListener('click', async (e) => {
  const mode = e.target.dataset.login;
  try {
    if (mode) {
      e.preventDefault();
      state.auth.flow = await api('/api/auth/login', { method: 'POST', body: { mode } });
      renderAuthDialog();
    } else if (e.target.id === 'cancelLogin') {
      e.preventDefault();
      state.auth.flow = await api('/api/auth/cancel', { method: 'POST' });
      renderAuthDialog();
    } else if (e.target.id === 'logout') {
      e.preventDefault();
      state.auth = await api('/api/auth/logout', { method: 'POST' });
      renderAccount(); renderAuthDialog();
    } else if (e.target.id === 'copyCode') {
      e.preventDefault();
      await navigator.clipboard.writeText(state.auth.flow.code);
      toast('Code copied');
    }
  } catch (err) { toast(err.message); }
});
async function refreshAuth() {
  state.auth = await api('/api/auth');
  renderAccount();
  if ($('#authDialog').open) renderAuthDialog();
}

/* ---------- Live events ---------- */
function connectEvents() {
  const es = new EventSource(`/api/events${state.key ? `?key=${encodeURIComponent(state.key)}` : ''}`);
  es.addEventListener('hello', (e) => {
    const { builds, recovery } = JSON.parse(e.data);
    builds.reverse().forEach(upsertBuild);
    renderRecovery(recovery);
  });
  es.addEventListener('build', (e) => upsertBuild(JSON.parse(e.data)));
  es.addEventListener('recovery', (e) => renderRecovery(JSON.parse(e.data)));
  es.addEventListener('remove', (e) => {
    const { id } = JSON.parse(e.data);
    state.builds.delete(id);
    document.getElementById(`run-${id}`)?.remove();
    updateCounts();
  });
  es.addEventListener('auth', async (e) => {
    const flow = JSON.parse(e.data);
    if (state.auth) state.auth.flow = flow;
    if (flow.state === 'done') { await refreshAuth(); toast('Signed in to GitHub'); }
    else if ($('#authDialog').open) renderAuthDialog();
  });
  es.onerror = () => { es.close(); setTimeout(connectEvents, 3000); };
}

$('#keyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.key = $('#keyInput').value;
  sessionStorage.setItem('mac-key', state.key);
  $('#keyDialog').close();
  boot();
});

async function boot() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    state.platforms = cfg.platforms;
    state.runners = cfg.runners;
    renderPlatforms();
    renderRunners();
    renderModes();
    schedulePreview();
    await refreshAuth();
    connectEvents();
  } catch { /* key dialog shown */ }
}

setTab(state.tab);
renderModes();
renderScripts();
renderWorkflows();
renderRunners();
renderPlatforms();
renderArgs();
renderAll();
schedulePreview();
boot();

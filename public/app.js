const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const state = {
  files: [{ path: 'Dockerfile', content: TEMPLATES.Alpine, fixed: true }],
  active: 0,
  platform: 'linux/amd64',
  platforms: ['linux/amd64'],
  args: [],
  builds: new Map(),
  auth: null,
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

/* ---------- Editor ---------- */
const KW = /^(\s*)(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\b/i;
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
  const isDocker = f.path === 'Dockerfile';
  $('#highlight').innerHTML = (isDocker ? highlightDockerfile(f.content) : esc(f.content)) + '\n';
  const lines = f.content.split('\n').length;
  $('#gutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
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
  if (del) {
    state.files.splice(Number(del.dataset.del), 1);
    state.active = 0;
    return renderAll();
  }
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

$('#code').addEventListener('input', (e) => {
  state.files[state.active].content = e.target.value;
  renderEditor();
});
$('#code').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target;
    t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input'));
  }
});

function renderTemplates() {
  $('#templates').innerHTML = Object.keys(TEMPLATES).map((k) => `<button class="chip" type="button" data-t="${k}">${k}</button>`).join('');
}
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
}
$('#platforms').addEventListener('click', (e) => {
  if (!e.target.dataset.p) return;
  state.platform = e.target.dataset.p;
  renderPlatforms();
});

function renderArgs() {
  $('#argList').innerHTML = state.args.map((a, i) => `
    <div class="arg-row">
      <input placeholder="NAME" value="${esc(a.k)}" data-ak="${i}" spellcheck="false">
      <input placeholder="value" value="${esc(a.v)}" data-av="${i}" spellcheck="false">
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

/* ---------- Builds ---------- */
$('#buildBtn').addEventListener('click', async () => {
  const btn = $('#buildBtn');
  $('#formHint').textContent = '';
  if (!state.auth?.signedIn) { openAuth(); return; }
  btn.disabled = true;
  try {
    const [docker, ...rest] = state.files;
    const buildArgs = Object.fromEntries(state.args.filter((a) => a.k).map((a) => [a.k, a.v]));
    const job = await api('/api/builds', {
      method: 'POST',
      body: { dockerfile: docker.content, files: rest.map(({ path, content }) => ({ path, content })), imageName: $('#imageName').value, platform: state.platform, buildArgs },
    });
    upsertBuild(job);
    toast('Build queued — spinning up a temporary repository');
  } catch (err) {
    $('#formHint').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function elapsed(job) {
  const end = job.status === 'running' ? Date.now() : job.updatedAt;
  const s = Math.max(0, Math.round((end - job.createdAt) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function buildCard(job) {
  const key = state.key ? `?key=${encodeURIComponent(state.key)}` : '';
  const expires = job.expiresAt ? `· link expires ${new Date(job.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  return `
    <div class="run-top">
      <div>
        <div class="run-name">${esc(job.imageName)}</div>
        <div class="run-meta">${esc(job.platform)} · <span data-elapsed>${elapsed(job)}</span> ${expires}</div>
      </div>
      <span class="status ${job.status}">${job.status}</span>
    </div>
    <div class="track">${job.stages.map((s) => `<i class="${s.state}" title="${esc(s.label)}"></i>`).join('')}</div>
    <ol class="stages">${job.stages.map((s) => `
      <li class="${s.state}"><span class="dot"></span><span>${esc(s.label)}</span><span class="detail" title="${esc(s.detail)}">${esc(s.detail || '')}</span></li>`).join('')}
    </ol>
    ${job.error ? `<p class="run-error">${esc(job.error)}</p>` : ''}
    <div class="run-actions">
      ${job.downloadUrl ? `<a class="btn primary" href="${job.downloadUrl}${key}" download>↓ Download ${esc(job.fileName)}</a>` : ''}
      ${job.runUrl && job.status === 'running' ? `<a class="btn" href="${esc(job.runUrl)}" target="_blank" rel="noopener">Watch run ↗</a>` : ''}
      ${job.status !== 'running' ? `<button class="btn quiet" type="button" data-remove="${job.id}">Dismiss</button>` : ''}
      ${job.downloadUrl ? `<div class="load-cmd">docker load -i ${esc(job.fileName)}</div>` : ''}
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
  el.className = `run ${job.status}`;
  el.innerHTML = buildCard(job);
  $('#emptyRuns').hidden = state.builds.size > 0;
}

$('#runList').addEventListener('click', async (e) => {
  const id = e.target.dataset.remove;
  if (!id) return;
  try {
    await api(`/api/builds/${id}`, { method: 'DELETE' });
    state.builds.delete(id);
    document.getElementById(`run-${id}`)?.remove();
    $('#emptyRuns').hidden = state.builds.size > 0;
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
  }
}, 1000);

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
    const { builds } = JSON.parse(e.data);
    builds.reverse().forEach(upsertBuild);
  });
  es.addEventListener('build', (e) => upsertBuild(JSON.parse(e.data)));
  es.addEventListener('remove', (e) => {
    const { id } = JSON.parse(e.data);
    state.builds.delete(id);
    document.getElementById(`run-${id}`)?.remove();
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
    state.platforms = cfg.platforms;
    renderPlatforms();
    await refreshAuth();
    connectEvents();
  } catch { /* key dialog shown */ }
}

renderTemplates();
renderPlatforms();
renderArgs();
renderAll();
boot();

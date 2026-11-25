// Dockerfile tab: instructions in, image out.
import * as registry from '../core/registry.js';
import { api } from '../core/api.js';
import { t, h, v, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import { modeCards } from '../ui/modes.js';
import { requireSignIn } from '../ui/auth.js';

const TEMPLATES = {
  Node: [`FROM node:22-alpine\nWORKDIR /app\nCOPY server.js .\nEXPOSE 3000\nCMD ["node", "server.js"]\n`, [{ path: 'server.js', content: "require('http').createServer((q, r) => r.end('hello')).listen(3000);\n" }]],
  Python: [`FROM python:3.13-slim\nWORKDIR /app\nRUN pip install --no-cache-dir flask\nCOPY app.py .\nCMD ["python", "app.py"]\n`, [{ path: 'app.py', content: "from flask import Flask\napp = Flask(__name__)\n\n@app.get('/')\ndef hi():\n    return 'hello'\n\napp.run(host='0.0.0.0')\n" }]],
  Nginx: [`FROM nginx:alpine\nCOPY index.html /usr/share/nginx/html/index.html\n`, [{ path: 'index.html', content: '<h1>hello</h1>\n' }]],
  Alpine: [`FROM alpine:3.20\nRUN apk add --no-cache curl jq\nCMD ["sh"]\n`, []],
};
const s = { files: [{ path: 'Dockerfile', content: TEMPLATES.Alpine[0], fixed: true }], active: 0, platform: 'linux/amd64', platforms: ['linux/amd64'], args: [], mode: 'private' };
let root;
const $ = (q) => root.querySelector(q);

export function setPlatforms(list) { s.platforms = list; if (root) renderPlatforms(); }

const KW = /^(\s*)(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i;
function highlight(src) {
  return src.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return `<span class="tk-com">${esc(line)}</span>`;
    let out = esc(line);
    out = out.replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="tk-str">$1</span>');
    out = out.replace(/(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/g, '<span class="tk-var">$1</span>');
    out = out.replace(/(^|\s)(--[a-z-]+)/g, '$1<span class="tk-flag">$2</span>');
    return out.replace(KW, '$1<span class="tk-kw">$2</span>').replace(/\b(AS)\b/g, '<span class="tk-kw">$1</span>');
  }).join('\n');
}

function renderEditor() {
  const f = s.files[s.active];
  if ($('#code').value !== f.content) $('#code').value = f.content;
  $('#highlight').innerHTML = `${f.path === 'Dockerfile' ? highlight(f.content) : esc(f.content)}\n`;
  $('#gutter').textContent = Array.from({ length: f.content.split('\n').length }, (_, i) => i + 1).join('\n');
}
function renderTabs() {
  $('#tabs').innerHTML = s.files.map((f, i) => `
    <button class="tab" role="tab" type="button" data-i="${i}" aria-selected="${i === s.active}">
      ${f.editing ? `<input data-rename="${i}" value="${esc(f.path)}" aria-label="${esc(f.path)}">` : esc(f.path)}
      ${f.fixed ? '' : `<span class="x" data-del="${i}" role="button" aria-label="${esc(t('tabs.close'))}: ${esc(f.path)}">×</span>`}
    </button>`).join('') + `<button class="tab add" type="button" id="addFile">${h('docker.addFile')}</button>`;
  $('#tabs input')?.focus();
}
function renderAll() { renderTabs(); renderEditor(); }
function renderPlatforms() {
  $('#platforms').innerHTML = s.platforms.map((p) => `<button type="button" role="radio" aria-checked="${p === s.platform}" data-p="${p}">${p.replace('linux/', '')}</button>`).join('');
}
function renderArgs() {
  $('#argList').innerHTML = s.args.map((a, i) => `<div class="arg-row"><input placeholder="NAME" value="${esc(a.k)}" data-ak="${i}" aria-label="NAME"><input placeholder="value" value="${esc(a.v)}" data-av="${i}" aria-label="value"><button class="icon-btn" type="button" data-adel="${i}" aria-label="${esc(t('common.close'))}">×</button></div>`).join('');
  $('#argCount').textContent = s.args.length;
}

function mount(el) {
  root = el;
  el.classList.add('layout');
  el.innerHTML = `
    <section class="compose card-xl" data-ui="docker-compose">
      <p class="eyebrow">${h('docker.eyebrow')}</p>
      <h1>${h('docker.title1')}<br><em>${h('docker.title2')}</em></h1>
      <p class="lede">${h('docker.lede')}</p>
      <div class="field-row">
        <label class="field grow"><span>${h('docker.image')}</span><input id="imageName" value="my-app:latest" spellcheck="false" autocomplete="off"></label>
        <div class="field"><span>${h('docker.platform')}</span><div class="segmented" id="platforms" role="radiogroup" aria-label="${esc(t('docker.platform'))}"></div></div>
      </div>
      <div class="templates">${Object.keys(TEMPLATES).map((k) => `<button class="chip" type="button" data-t="${k}">${k}</button>`).join('')}</div>
      <div class="editor-shell" data-ui="docker-editor">
        <div class="tabs" id="tabs" role="tablist"></div>
        <div class="editor"><div class="gutter" id="gutter" aria-hidden="true"></div>
          <div class="code-wrap"><pre class="highlight" id="highlight" aria-hidden="true"></pre><textarea id="code" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Dockerfile"></textarea></div></div>
      </div>
      <details class="args"><summary>${h('docker.args')} <span id="argCount" class="pill">0</span></summary><div id="argList"></div><button class="text-btn" id="addArg" type="button">${h('docker.addArg')}</button></details>
    </section>
    <aside class="stack-col sticky">
      <div class="panel"><p class="step">${h('wf.where')}</p><div id="dockerModes"></div></div>
      <div class="run-bar"><span class="muted" id="dockerSummary"></span>
        <button class="fab" id="buildBtn" type="button" data-ui="docker-build">${h('docker.build')} <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12m-5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <p class="hint" id="formHint" role="alert"></p>
    </aside>`;
  const modes = () => { $('#dockerModes').innerHTML = modeCards(s.mode, { stacked: true }); $('#dockerSummary').textContent = `${s.platform} · ${t(s.mode === 'encrypted-public' ? 'mode.enc.title' : 'mode.private.title')}`; };
  el.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { s.files.splice(+del.dataset.del, 1); s.active = 0; renderAll(); return; }
    if (e.target.closest('#addFile')) { s.files.push({ path: `file${s.files.length}.txt`, content: '', editing: true }); s.active = s.files.length - 1; renderAll(); return; }
    const tab = e.target.closest('.tab[data-i]');
    if (tab && !e.target.matches('input')) { const i = +tab.dataset.i; if (i === s.active && !s.files[i].fixed) s.files[i].editing = true; s.active = i; renderAll(); return; }
    const tpl = e.target.closest('[data-t]');
    if (tpl) { const [df, files] = TEMPLATES[tpl.dataset.t]; s.files = [{ path: 'Dockerfile', content: df, fixed: true }, ...files.map((f) => ({ ...f }))]; s.active = 0; $('#imageName').value = `${tpl.dataset.t.toLowerCase()}-app:latest`; renderAll(); return; }
    const p = e.target.closest('[data-p]');
    if (p) { s.platform = p.dataset.p; renderPlatforms(); modes(); return; }
    const m = e.target.closest('[data-mode]');
    if (m) { s.mode = m.dataset.mode; modes(); return; }
    if (e.target.closest('#addArg')) { s.args.push({ k: '', v: '' }); renderArgs(); return; }
    const ad = e.target.closest('[data-adel]');
    if (ad) { s.args.splice(+ad.dataset.adel, 1); renderArgs(); return; }
    if (e.target.closest('#buildBtn')) build();
  });
  el.addEventListener('focusout', (e) => {
    if (!e.target.matches('[data-rename]')) return;
    const f = s.files[+e.target.dataset.rename];
    f.path = e.target.value.trim() || f.path; f.editing = false; renderTabs();
  });
  el.addEventListener('keydown', (e) => { if (e.target.matches('[data-rename]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'code') { s.files[s.active].content = e.target.value; renderEditor(); }
    if (e.target.dataset.ak) s.args[e.target.dataset.ak].k = e.target.value;
    if (e.target.dataset.av) s.args[e.target.dataset.av].v = e.target.value;
  });
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end'); e.target.dispatchEvent(new Event('input', { bubbles: true })); } });
  renderAll(); renderPlatforms(); renderArgs(); modes();
}

async function build() {
  $('#formHint').textContent = '';
  if (s.mode !== 'local' && !(await requireSignIn())) return;
  const btn = $('#buildBtn');
  btn.disabled = true;
  try {
    const [docker, ...rest] = s.files;
    const job = await api('/api/builds', { method: 'POST', body: { kind: 'dockerfile', mode: s.mode, dockerfile: docker.content, files: rest.map(({ path, content }) => ({ path, content })), imageName: $('#imageName').value, platform: s.platform, buildArgs: Object.fromEntries(s.args.filter((a) => a.k).map((a) => [a.k, a.v])) } });
    document.dispatchEvent(new CustomEvent('mac:build', { detail: job }));
    await registry.teleport({ tab: 'runs' });
    notify(t('toast.queued'), { kind: 'progress' });
  } catch (err) { $('#formHint').textContent = v(err.message); }
  finally { btn.disabled = false; }
}

export function register() {
  registry.destination({ id: 'dockerfile', titleKey: 'tab.dockerfile', icon: '▣', order: 20, mount });
  registry.command({ id: 'docker.build', titleKey: 'docker.build', run: () => registry.teleport({ tab: 'dockerfile', target: '#buildBtn' }) });
}

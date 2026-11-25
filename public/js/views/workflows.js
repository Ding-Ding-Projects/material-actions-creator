// Workflows tab: a repository's build scripts and its own workflows in, outputs out.
import * as registry from '../core/registry.js';
import * as store from '../core/store.js';
import { api } from '../core/api.js';
import { t, h, v, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import { modeCards } from '../ui/modes.js';
import { requireSignIn } from '../ui/auth.js';

const saved = (() => { try { return JSON.parse(localStorage.getItem('mac-wf')) || {}; } catch { return {}; } })();
const wf = {
  repo: saved.repo || '', ref: saved.ref || '', scripts: saved.scripts || [], workflows: saved.workflows || [],
  runner: saved.runner || 'windows-latest', outputs: saved.outputs || 'dist/**/*.exe, dist/**/*.msi', mode: saved.mode || store.get('defaultMode') || 'private',
};
let runners = ['windows-latest'];
let root;
const save = () => { try { localStorage.setItem('mac-wf', JSON.stringify(wf)); } catch { /* ignore */ } };
const $ = (s) => root.querySelector(s);

export function setRunners(list) { runners = list; if (root) renderRunners(); }

function request() {
  return { kind: 'scripts', repo: wf.repo, ref: wf.ref, runner: wf.runner, scripts: wf.scripts.filter((s) => s.on).map((s) => s.path), workflows: wf.workflows.filter((w) => w.on).map((w) => w.path), outputs: wf.outputs, mode: wf.mode };
}

function renderScripts() {
  $('#wfScripts').innerHTML = wf.scripts.map((s, i) => `
    <li class="script ${s.on ? 'on' : ''}">
      <label><input type="checkbox" data-sc-toggle="${i}" ${s.on ? 'checked' : ''}> <span class="n">${String(i + 1).padStart(2, '0')}</span> <span class="path">${esc(s.path)}</span></label>
      <span class="order">
        <button type="button" class="icon-btn" data-sc-up="${i}" aria-label="↑ ${esc(s.path)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-sc-down="${i}" aria-label="↓ ${esc(s.path)}" ${i === wf.scripts.length - 1 ? 'disabled' : ''}>↓</button>
      </span>
    </li>`).join('');
}

function renderWorkflows() {
  $('#wfWorkflows').innerHTML = wf.workflows.map((w, i) => `
    <li class="script ${w.on ? 'on' : ''} ${w.dispatchable ? '' : 'disabled'}">
      <label><input type="checkbox" data-wf-toggle="${i}" ${w.on ? 'checked' : ''} ${w.dispatchable ? '' : 'disabled'}>
        <span class="wf-text"><span class="path">${esc(w.name)}</span><span class="wf-path">${esc(w.path)}${w.dispatchable ? '' : ` · ${h('wf.callableOnly')}`}</span></span></label>
      ${w.warnings?.length ? `<details class="wf-warn"><summary>${w.warnings.length} ${h('runs.changes')}</summary><ul>${w.warnings.map((x) => `<li>${esc(v(x))}</li>`).join('')}</ul></details>` : ''}
    </li>`).join('');
}

function renderRunners() {
  $('#wfRunners').innerHTML = runners.map((r) => `<button type="button" role="radio" class="chip-btn" aria-checked="${r === wf.runner}" data-runner="${r}">${r}</button>`).join('');
}

function renderModes() { $('#wfModes').innerHTML = modeCards(wf.mode); }

let timer;
function schedule() {
  const r = request();
  $('#wfSummary').textContent = `${r.scripts.length} · ${r.workflows.length} · ${t(wf.mode === 'encrypted-public' ? 'mode.enc.title' : 'mode.private.title')}`;
  clearTimeout(timer);
  timer = setTimeout(preview, 250);
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

async function preview() {
  const req = request();
  const state = $('#wfYamlState');
  if (!req.scripts.length && req.workflows.length) {
    $('#wfYaml').innerHTML = esc(`# ${req.workflows.join('\n# ')}\n`);
    $('#wfYaml').dataset.yaml = '';
    state.innerHTML = h('wf.workflowsOnly'); state.className = 'ok';
    return;
  }
  try {
    const { yaml } = await api('/api/preview', { method: 'POST', body: req });
    $('#wfYaml').innerHTML = highlightYaml(yaml);
    $('#wfYaml').dataset.yaml = yaml;
    state.innerHTML = h('wf.preview'); state.className = 'ok';
  } catch (err) {
    state.textContent = v(err.message); state.className = 'warn';
  }
}

async function scan() {
  const btn = $('#wfScan');
  btn.disabled = true;
  $('#wfScriptHint').innerHTML = h('wf.scanning');
  try {
    const q = new URLSearchParams({ repo: $('#wfRepo').value.trim(), mode: wf.mode });
    if ($('#wfRef').value.trim()) q.set('ref', $('#wfRef').value.trim());
    const r = await api(`/api/scripts?${q}`);
    Object.assign(wf, { repo: r.repo, ref: r.ref });
    $('#wfRepo').value = r.repo; $('#wfRef').value = r.ref;
    const keep = new Map(wf.scripts.map((s) => [s.path, s.on]));
    wf.scripts = r.scripts.map((p) => ({ path: p, on: keep.has(p) ? keep.get(p) : /install|build|setup|package|release/i.test(p) }));
    const keepWf = new Map(wf.workflows.map((w) => [w.path, w.on]));
    wf.workflows = r.workflows.map((w) => ({ ...w, on: w.dispatchable && (keepWf.get(w.path) ?? false) }));
    if (!saved.outputs) { wf.outputs = r.outputsGuess; $('#wfOutputs').value = r.outputsGuess; }
    $('#wfScriptHint').textContent = `${r.scripts.length} · ${r.workflows.length}`;
    save(); renderScripts(); renderWorkflows(); schedule();
  } catch (err) {
    $('#wfScriptHint').textContent = v(err.message);
  } finally { btn.disabled = false; }
}

function mount(el) {
  root = el;
  el.classList.add('layout');
  el.innerHTML = `
    <section class="stack-col">
      <div class="hero-head"><p class="eyebrow">${h('wf.eyebrow')}</p><h1>${h('wf.title1')}<br><em>${h('wf.title2')}</em></h1></div>
      <div class="panel" data-ui="wf-source">
        <p class="step">${h('wf.source')}</p>
        <div class="field-row">
          <label class="field grow"><span>${h('wf.repo')}</span><input id="wfRepo" placeholder="owner/name" spellcheck="false" autocomplete="off"></label>
          <label class="field"><span>${h('wf.ref')}</span><input id="wfRef" spellcheck="false" autocomplete="off"></label>
          <button class="btn scan" type="button" id="wfScan">${h('wf.scan')}</button>
        </div>
      </div>
      <div class="panel" data-ui="wf-scripts">
        <div class="panel-head"><p class="step">${h('wf.scripts')}</p><span class="muted small" id="wfScriptHint">${h('wf.scriptsHint')}</span></div>
        <div class="select-all"><button class="text-btn" type="button" id="wfAllScripts">${h('wf.allScripts')}</button><button class="text-btn quiet-link" type="button" id="wfNoScripts">${h('wf.none')}</button></div>
        <ol class="script-list" id="wfScripts"></ol>
        <div class="add-script"><input id="wfAddScript" spellcheck="false" placeholder="${esc(t('wf.addScriptPh'))}" aria-label="${esc(t('wf.addScriptPh'))}"><button class="btn" type="button" id="wfAddScriptBtn">${h('wf.addScript')}</button></div>
      </div>
      <div class="panel" data-ui="wf-repo-workflows">
        <div class="panel-head"><p class="step">${h('wf.repoWorkflows')}</p><span class="muted small">${h('wf.repoWorkflowsHint')}</span></div>
        <p class="muted small explain">${h('wf.repoWorkflowsExplain')}</p>
        <div class="select-all"><button class="text-btn" type="button" id="wfAllWorkflows">${h('wf.allWorkflows')}</button><button class="text-btn quiet-link" type="button" id="wfNoWorkflows">${h('wf.none')}</button></div>
        <ol class="script-list" id="wfWorkflows"></ol>
      </div>
      <div class="split">
        <div class="panel" data-ui="wf-runner"><p class="step">${h('wf.runner')}</p><div class="chips" id="wfRunners" role="radiogroup" aria-label="${esc(t('wf.runner'))}"></div></div>
        <div class="panel" data-ui="wf-outputs"><p class="step">${h('wf.outputs')}</p><label class="field"><span>${h('wf.outputsLabel')}</span><input id="wfOutputs" spellcheck="false"></label></div>
      </div>
      <div class="panel" data-ui="wf-where"><p class="step">${h('wf.where')}</p><div id="wfModes"></div></div>
    </section>
    <aside class="stack-col sticky">
      <div class="yaml-card" data-ui="wf-yaml"><div class="yaml-head"><span>.github/workflows/mac-build.yml</span><span class="ok" id="wfYamlState"></span></div><pre id="wfYaml" class="yaml" tabindex="0"></pre></div>
      <div class="run-bar"><span id="wfSummary" class="muted"></span>
        <button class="fab" id="wfRun" type="button" data-ui="wf-run">${h('wf.run')} <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12m-5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <p class="hint" id="wfHint" role="alert"></p>
      <button class="text-btn center" type="button" id="wfExport">${h('wf.export')}</button>
    </aside>`;
  $('#wfRepo').value = wf.repo; $('#wfRef').value = wf.ref; $('#wfOutputs').value = wf.outputs;
  for (const [sel, k] of [['#wfRepo', 'repo'], ['#wfRef', 'ref'], ['#wfOutputs', 'outputs']]) $(sel).addEventListener('input', (e) => { wf[k] = e.target.value; save(); schedule(); });
  el.addEventListener('click', async (e) => {
    const s = wf.scripts;
    const up = e.target.closest('[data-sc-up]'); const down = e.target.closest('[data-sc-down]');
    if (up) { const i = +up.dataset.scUp; [s[i - 1], s[i]] = [s[i], s[i - 1]]; save(); renderScripts(); schedule(); return; }
    if (down) { const i = +down.dataset.scDown; [s[i + 1], s[i]] = [s[i], s[i + 1]]; save(); renderScripts(); schedule(); return; }
    const runner = e.target.closest('[data-runner]');
    if (runner) { wf.runner = runner.dataset.runner; save(); renderRunners(); schedule(); return; }
    const mode = e.target.closest('[data-mode]');
    if (mode) { wf.mode = mode.dataset.mode; save(); renderModes(); schedule(); return; }
    const id = e.target.closest('button')?.id;
    if (id === 'wfScan') scan();
    if (id === 'wfAllScripts' || id === 'wfNoScripts') { s.forEach((x) => { x.on = id === 'wfAllScripts'; }); save(); renderScripts(); schedule(); }
    if (id === 'wfAllWorkflows' || id === 'wfNoWorkflows') { wf.workflows.forEach((w) => { w.on = id === 'wfAllWorkflows' && w.dispatchable; }); save(); renderWorkflows(); schedule(); }
    if (id === 'wfAddScriptBtn') addScript();
    if (id === 'wfExport') {
      const yaml = $('#wfYaml').dataset.yaml;
      if (!yaml) return;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' })), download: 'mac-build.yml' });
      a.click(); URL.revokeObjectURL(a.href);
    }
    if (id === 'wfRun') run();
  });
  el.addEventListener('change', (e) => {
    const sc = e.target.closest('[data-sc-toggle]');
    if (sc) { wf.scripts[+sc.dataset.scToggle].on = sc.checked; save(); renderScripts(); schedule(); }
    const w = e.target.closest('[data-wf-toggle]');
    if (w) { wf.workflows[+w.dataset.wfToggle].on = w.checked; save(); renderWorkflows(); schedule(); }
  });
  $('#wfAddScript').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addScript(); } });
  renderScripts(); renderWorkflows(); renderRunners(); renderModes(); schedule();
}

function addScript() {
  const val = $('#wfAddScript').value.trim();
  if (!val) return;
  if (!wf.scripts.some((s) => s.path === val)) wf.scripts.push({ path: val, on: true });
  $('#wfAddScript').value = '';
  save(); renderScripts(); schedule();
}

async function run() {
  $('#wfHint').textContent = '';
  if (!(await requireSignIn())) return;
  const btn = $('#wfRun');
  btn.disabled = true;
  try {
    const job = await api('/api/builds', { method: 'POST', body: request() });
    document.dispatchEvent(new CustomEvent('mac:build', { detail: job }));
    await registry.teleport({ tab: 'runs' });
    notify(t(job.mode === 'encrypted-public' ? 'toast.encQueued' : 'toast.queued'), { kind: 'progress' });
  } catch (err) { $('#wfHint').textContent = v(err.message); }
  finally { btn.disabled = false; }
}

export function register() {
  registry.destination({ id: 'workflows', titleKey: 'tab.workflows', icon: '⚙', order: 10, mount });
  registry.command({ id: 'wf.scan', titleKey: 'wf.scan', tab: 'workflows', run: () => registry.teleport({ tab: 'workflows', target: '#wfRepo' }) });
  registry.command({ id: 'wf.run', titleKey: 'wf.run', tab: 'workflows', run: () => registry.teleport({ tab: 'workflows', target: '#wfRun' }) });
  registry.command({ id: 'wf.allScripts', titleKey: 'wf.allScripts', run: () => registry.teleport({ tab: 'workflows', target: '#wfAllScripts' }) });
  registry.command({ id: 'wf.allWorkflows', titleKey: 'wf.allWorkflows', run: () => registry.teleport({ tab: 'workflows', target: '#wfAllWorkflows' }) });
  registry.command({ id: 'wf.export', titleKey: 'wf.export', run: () => registry.teleport({ tab: 'workflows', target: '#wfExport' }) });
}

// Workspace tab: dockable panels (dockview) for runs, the step log, a timing
// chart, outputs and extension results. Panels can be dragged, split, stacked
// and floated; the layout is remembered in this browser.
import * as registry from '../core/registry.js';
import * as store from '../core/store.js';
import { STRINGS } from '../core/strings.js';
import { t, h, v, esc } from '../core/i18n.js';
import { api, on, withKey } from '../core/api.js';
import { notify } from '../core/feedback.js';
import { searchField } from '../ui/regex-builder.js';
import { builds } from './runs.js';

Object.assign(STRINGS, {
  'tab.workspace': { en: 'Workspace', yue: '工作區' },
  'ws.runs': { en: 'Runs', yue: '執行' },
  'ws.log': { en: 'Log', yue: '記錄' },
  'ws.timing': { en: 'Where the time went', yue: '時間用咗喺邊' },
  'ws.outputs': { en: 'Outputs', yue: '輸出' },
  'ws.ext': { en: 'Extension results', yue: '擴充功能結果' },
  'ws.reset': { en: 'Reset layout', yue: '重設版面' },
  'ws.panels': { en: 'Reopen a panel', yue: '重新開啟面板' },
  'ws.hint': { en: 'Drag a tab to split, stack or float a panel. The layout is remembered in this browser.', yue: '拖動分頁就可以分割、疊埋或者浮動面板。版面會記喺呢個瀏覽器。' },
  'ws.noRuns': { en: 'No builds yet. Start one from Workflows or Dockerfile.', yue: '未有建置。去「工作流程」或者「Dockerfile」開始一個。' },
  'ws.pick': { en: 'Pick a run to see it here.', yue: '揀一個執行，就會喺度見到。' },
  'ws.log.live': { en: 'GitHub only releases the full log when a job ends. Until then this shows each step as it changes.', yue: 'GitHub 要等工作完結先至畀完整記錄。之前呢度會顯示每個步驟嘅變化。' },
  'ws.log.none': { en: 'No log was saved for this build.', yue: '呢個建置冇儲存到記錄。' },
  'ws.log.truncated': { en: 'The log was longer than 2 MB and was cut.', yue: '記錄超過 2 MB，已經截短。' },
  'ws.log.search': { en: 'Search the log', yue: '搵記錄' },
  'ws.log.matches': { en: '{n} matching lines of {total}', yue: '{total} 行入面有 {n} 行符合' },
  'ws.log.times': { en: 'Timestamps', yue: '時間戳' },
  'ws.log.download': { en: 'Download log', yue: '下載記錄' },
  'ws.log.failed': { en: 'The log could not be loaded.', yue: '載入唔到記錄。' },
  'ws.timing.none': { en: 'Step timings appear once the run starts.', yue: '執行開始之後就會見到步驟時間。' },
  'ws.timing.total': { en: 'Total {total} · longest: {name} ({time})', yue: '總共 {total} · 最耐：{name}（{time}）' },
  'ws.outputs.none': { en: 'No outputs. They appear here when the build is ready.', yue: '未有輸出。建置完成就會喺度出現。' },
  'ws.ext.run': { en: 'Run extension', yue: '執行擴充功能' },
  'ws.ext.none': { en: 'No extension that handles finished builds is turned on.', yue: '未開啟任何處理建置完成嘅擴充功能。' },
  'ws.ext.empty': { en: 'Run an extension on this build to see its result here.', yue: '喺呢個建置行一個擴充功能，結果就會喺度出現。' },
  'ws.failed': { en: 'The workspace could not load its panel library.', yue: '工作區載入唔到面板程式庫。' },
});

const LAYOUT_KEY = 'mac.workspace.v1';
const PANELS = ['runs', 'log', 'timing', 'outputs', 'ext'];
const subs = new Set();
let selected = null;
const extResults = new Map(); // build id -> [{name, run}]
const current = () => (selected && builds.get(selected)) || null;
const changed = () => { for (const fn of subs) { try { fn(); } catch { /* panel closed */ } } };
function select(id) { selected = id; changed(); }

const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const bytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

let lib;
function loadLib() {
  lib ||= new Promise((resolve, reject) => {
    if (globalThis['dockview-core']) { resolve(globalThis['dockview-core']); return; }
    const s = document.createElement('script');
    s.src = '/vendor/dockview/dockview-core.min.js';
    s.onload = () => resolve(globalThis['dockview-core']);
    s.onerror = () => reject(new Error('dockview'));
    document.head.append(s);
  });
  return lib;
}

// ---------- Panels ----------
function panel(draw, { setup } = {}) {
  const element = document.createElement('div');
  element.className = 'ws-panel';
  let off;
  return {
    element,
    init() {
      const ctx = setup ? setup(element) : {};
      const fn = () => draw(element, ctx);
      subs.add(fn);
      off = () => subs.delete(fn);
      fn();
    },
    dispose() { off?.(); },
  };
}

function drawRuns(el) {
  const list = [...builds.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!selected && list.length) selected = list[0].id;
  el.innerHTML = list.length ? `<ul class="ws-runs">${list.map((b) => `<li><button type="button" class="ws-run ${b.id === selected ? 'on' : ''}" data-run="${esc(b.id)}" aria-pressed="${b.id === selected}">
    <span class="ws-run-title"><i class="dot ${esc(b.status)}"></i><strong>${esc(v(b.title || b.id))}</strong></span>
    <span class="muted small">${h(`status.${b.status}`)} · ${esc(b.platform || '')} · ${dur((b.status === 'running' ? Date.now() : b.updatedAt) - b.createdAt)}</span></button></li>`).join('')}</ul>` : `<p class="empty">${h('ws.noRuns')}</p>`;
}

const logCache = new Map();
const TS = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const ANSI = /\u001b\[[0-9;]*m/g;
function drawLog(el, ctx) {
  const b = current();
  const body = el.querySelector('.ws-log-body');
  const info = el.querySelector('.ws-log-info');
  const dl = el.querySelector('[data-log-dl]');
  dl.hidden = !b?.logUrl;
  if (b?.logUrl) dl.href = withKey(b.logUrl);
  if (!b) { body.innerHTML = `<p class="empty">${h('ws.pick')}</p>`; info.textContent = ''; return; }
  if (!b.logUrl) {
    const steps = b.steps || [];
    info.innerHTML = b.status === 'running' ? h('ws.log.live') : h('ws.log.none');
    body.innerHTML = steps.length ? `<ol class="ws-steps">${steps.map((s) => `<li class="${esc(s.conclusion || s.status)}"><i class="dot"></i><span>${esc(s.name)}</span><span class="muted small">${s.startedAt ? dur((s.completedAt || Date.now()) - s.startedAt) : esc(s.status)}</span></li>`).join('')}</ol>` : (b.stages || []).map((s) => `<p class="ws-stage ${esc(s.state)}"><i class="dot"></i>${esc(v(s.label || s.id))} <span class="muted small">${esc(v(s.detail || s.state))}</span></p>`).join('');
    return;
  }
  const show = (text) => {
    const all = text.replace(ANSI, '').split('\n');
    const lines = all.map((l) => (ctx.times ? l : l.replace(TS, ''))).filter((l) => !/##\[endgroup\]/.test(l));
    const hits = lines.filter((l) => ctx.matcher(l));
    info.textContent = `${t('ws.log.matches', { n: hits.length, total: lines.length })}${b.log?.truncated ? ` · ${t('ws.log.truncated')}` : ''}`;
    body.innerHTML = `<pre class="ws-log-pre">${hits.slice(0, 5000).map((l) => {
      const cls = /^=== .* ===$/.test(l) ? 'sec' : /##\[group\]/.test(l) ? 'grp' : /##\[error\]|\berror\b/i.test(l) ? 'err' : /##\[warning\]/.test(l) ? 'warn' : '';
      return `<span class="${cls}">${esc(l.replace(/##\[(group|error|warning|command|section)\]/, cls === 'grp' ? '▸ ' : ''))}</span>`;
    }).join('\n')}</pre>`;
  };
  if (logCache.has(b.id)) { show(logCache.get(b.id)); return; }
  body.innerHTML = `<p class="muted">${h('common.loading')}</p>`;
  fetch(withKey(b.logUrl)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((text) => { logCache.set(b.id, text); if (current()?.id === b.id) show(text); })
    .catch(() => { body.innerHTML = `<p class="run-error">${h('ws.log.failed')}</p>`; });
}
function setupLog(el) {
  const ctx = { matcher: () => true, times: false };
  el.classList.add('ws-log');
  el.innerHTML = `<div class="ws-log-bar"><div class="ws-log-search"></div><label class="ws-check"><input type="checkbox" data-log-times> ${h('ws.log.times')}</label><a class="btn quiet" data-log-dl download="run.log" hidden>${h('ws.log.download')}</a></div><p class="ws-log-info muted small" aria-live="polite"></p><div class="ws-log-body" tabindex="0"></div>`;
  el.querySelector('.ws-log-search').append(searchField({ placeholderKey: 'ws.log.search', ui: 'ws-log-search', onChange: (m) => { ctx.matcher = m; drawLog(el, ctx); } }));
  el.querySelector('[data-log-times]').addEventListener('change', (e) => { ctx.times = e.target.checked; drawLog(el, ctx); });
  return ctx;
}

function drawTiming(el) {
  const b = current();
  const steps = (b?.steps || []).filter((s) => s.startedAt);
  if (!b || !steps.length) { el.innerHTML = `<p class="empty">${h(b ? 'ws.timing.none' : 'ws.pick')}</p>`; return; }
  const now = Date.now();
  const start = Math.min(...steps.map((s) => s.startedAt));
  const end = Math.max(...steps.map((s) => s.completedAt || now));
  const span = Math.max(1000, end - start);
  const longest = steps.reduce((a, s) => ((s.completedAt || now) - s.startedAt > (a.completedAt || now) - a.startedAt ? s : a));
  el.innerHTML = `<p class="ws-timing-total">${esc(t('ws.timing.total', { total: dur(span), name: longest.name, time: dur((longest.completedAt || now) - longest.startedAt) }))}</p>
    <div class="ws-chart" role="img" aria-label="${esc(t('ws.timing'))}">${steps.map((s, i) => {
    const d = (s.completedAt || now) - s.startedAt;
    const state = s.conclusion || (s.completedAt ? 'success' : 'in_progress');
    return `<div class="ws-bar-row" style="--i:${i}"><span class="ws-bar-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="ws-bar-track"><i class="ws-bar ${esc(state)}" style="left:${((s.startedAt - start) / span * 100).toFixed(2)}%;width:${Math.max(0.8, d / span * 100).toFixed(2)}%"></i></span><span class="ws-bar-time">${dur(d)}</span></div>`;
  }).join('')}</div>
    <table class="sr-only"><caption>${h('ws.timing')}</caption>${steps.map((s) => `<tr><th>${esc(s.name)}</th><td>${dur((s.completedAt || now) - s.startedAt)}</td><td>${esc(s.conclusion || s.status)}</td></tr>`).join('')}</table>`;
}

function drawOutputs(el) {
  const b = current();
  if (!b) { el.innerHTML = `<p class="empty">${h('ws.pick')}</p>`; return; }
  const outs = b.outputs || [];
  el.innerHTML = `${b.status === 'failed' ? `<p class="run-sentence bad">${h('runs.failedSentence')}</p>${b.error ? `<p class="run-error">${esc(v(b.error))}</p>` : ''}` : ''}
    ${outs.length ? `<ul class="ws-outs">${outs.map((o) => `<li><div><strong>${esc(o.name)}</strong><span class="muted small">${bytes(o.size)}${b.mode === 'encrypted-public' ? ' · decrypted' : ''}</span></div>${o.url ? `<a class="btn primary small" href="${withKey(o.url)}" download>↓ ${h('runs.download')}</a>` : ''}</li>`).join('')}</ul>` : `<p class="empty">${h('ws.outputs.none')}</p>`}`;
}

async function runExt(id) {
  const b = current();
  if (!b) return;
  const { runExtension } = await import('./extensions.js');
  try {
    const run = await runExtension(id, { hook: 'build.finished', buildId: b.id });
    const data = await api('/api/extensions');
    const name = data.extensions.find((e) => e.id === id)?.name || id;
    extResults.set(b.id, [{ name, run }, ...(extResults.get(b.id) || []).filter((r) => r.name !== name)]);
  } catch (err) { notify(err.message, { kind: 'error' }); }
  changed();
}
function drawExt(el, ctx) {
  const b = current();
  if (!b) { el.innerHTML = `<p class="empty">${h('ws.pick')}</p>`; return; }
  const done = ['ready', 'failed'].includes(b.status);
  const results = extResults.get(b.id) || [];
  const opts = ctx.exts.filter((e) => e.enabled && e.hooks.includes('build.finished'));
  el.innerHTML = `<div class="ws-ext-bar">${opts.length ? opts.map((e) => `<button type="button" class="btn" data-ws-ext="${esc(e.id)}" ${done ? '' : 'disabled'}>⧉ ${esc(v(e.name))}</button>`).join('') : `<p class="muted small">${h('ws.ext.none')}</p>`}</div>
    <div class="ws-ext-results"></div>`;
  const box = el.querySelector('.ws-ext-results');
  if (!results.length) { box.innerHTML = `<p class="muted small">${h('ws.ext.empty')}</p>`; return; }
  import('./extensions.js').then(({ lintHtml }) => { box.innerHTML = lintHtml(results.map((r) => ({ ext: { name: r.name }, run: r.run }))); });
}
function setupExt(el) {
  const ctx = { exts: [] };
  const load = () => api('/api/extensions').then((d) => { ctx.exts = d.extensions; drawExt(el, ctx); }).catch(() => {});
  load();
  on('extensions', load);
  on('extension', (r) => {
    if (r.hook !== 'build.finished' || !r.buildId) return;
    extResults.set(r.buildId, [{ name: r.name, run: r }, ...(extResults.get(r.buildId) || []).filter((x) => x.name !== r.name)]);
    changed();
  });
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-ws-ext]'); if (b) runExt(b.dataset.wsExt); });
  return ctx;
}

const MAKE = {
  runs: () => panel(drawRuns, { setup: (el) => { el.addEventListener('click', (e) => { const b = e.target.closest('[data-run]'); if (b) select(b.dataset.run); }); return {}; } }),
  log: () => panel(drawLog, { setup: setupLog }),
  timing: () => panel(drawTiming),
  outputs: () => panel(drawOutputs),
  ext: () => panel(drawExt, { setup: setupExt }),
};

function defaultLayout(dock) {
  dock.clear();
  const add = (id, position) => dock.addPanel({ id, component: id, title: t(`ws.${id}`), position });
  add('runs');
  add('log', { referencePanel: 'runs', direction: 'right' });
  add('outputs', { referencePanel: 'log', direction: 'right' });
  add('timing', { referencePanel: 'log', direction: 'below' });
  add('ext', { referencePanel: 'outputs', direction: 'below' });
  try { dock.getPanel('runs').group.api.setSize({ width: 300 }); dock.getPanel('outputs').group.api.setSize({ width: 340 }); } catch { /* sizes are a nicety */ }
}

let dock;
async function mount(el) {
  el.innerHTML = `<div class="ws-top"><p class="muted small">${h('ws.hint')}</p><span class="spacer"></span><div class="ws-reopen" role="group" aria-label="${esc(t('ws.panels'))}"></div><button type="button" class="btn quiet" data-ws-reset>${h('ws.reset')}</button></div><div class="ws-dock"></div>`;
  const host = el.querySelector('.ws-dock');
  let dv;
  try { dv = await loadLib(); } catch { host.innerHTML = `<p class="run-error">${h('ws.failed')}</p>`; return; }
  const theme = () => (document.documentElement.dataset.theme === 'light' ? dv.themeLight : dv.themeAbyss);
  dock = dv.createDockview(host, { theme: theme(), createComponent: ({ name }) => (MAKE[name] || MAKE.runs)() });
  let restored = false;
  try { const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (saved) { dock.fromJSON(saved); restored = dock.panels.length > 0; } } catch { /* a layout from an older version */ }
  if (!restored) defaultLayout(dock);
  const reopen = el.querySelector('.ws-reopen');
  const sync = () => {
    const missing = PANELS.filter((id) => !dock.getPanel(id));
    reopen.innerHTML = missing.map((id) => `<button type="button" class="btn" data-ws-open="${id}">+ ${h(`ws.${id}`)}</button>`).join('');
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(dock.toJSON())); } catch { /* storage full or blocked */ }
  };
  dock.onDidLayoutChange(sync);
  sync();
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-ws-reset]')) { defaultLayout(dock); return; }
    const o = e.target.closest('[data-ws-open]');
    if (o) dock.addPanel({ id: o.dataset.wsOpen, component: o.dataset.wsOpen, title: t(`ws.${o.dataset.wsOpen}`) });
  });
  store.onChange(() => {
    try { dock.updateOptions({ theme: theme() }); } catch { /* older API */ }
    for (const id of PANELS) dock.getPanel(id)?.api.setTitle(t(`ws.${id}`));
    changed();
  });
  setInterval(() => { if (!el.hidden && current()?.status === 'running') changed(); }, 1000);
}

export function openRun(id) { selected = id; changed(); return registry.teleport({ tab: 'workspace' }); }

export function register() {
  registry.destination({ id: 'workspace', titleKey: 'tab.workspace', icon: '▦', order: 35, mount });
  registry.command({ id: 'workspace.reset', titleKey: 'ws.reset', tab: 'workspace', run: async () => { await registry.teleport({ tab: 'workspace' }); if (dock) defaultLayout(dock); } });
  on('build', () => queueMicrotask(changed));
  on('remove', () => queueMicrotask(changed));
  on('hello', () => queueMicrotask(changed));
}

// Runs tab: live builds, outputs, bulk actions, search and export.
import * as registry from '../core/registry.js';
import { api, on, withKey } from '../core/api.js';
import { t, h, v, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import * as exporter from '../core/exporter.js';
import { searchField } from '../ui/regex-builder.js';
import { superConfirm } from '../ui/confirm.js';

export const builds = new Map();
const selected = new Set();
let root;
let matcher = () => true;

function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let x = n; let i = -1;
  do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
  return `${x.toFixed(x >= 10 ? 0 : 1)} ${u[i]}`;
}
function elapsed(job) {
  const end = job.status === 'running' ? Date.now() : job.updatedAt;
  const s = Math.max(0, Math.round((end - job.createdAt) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
const countdown = (ts) => { const s = Math.max(0, Math.round((ts - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function card(job) {
  const enc = job.mode === 'encrypted-public';
  const showKey = enc && job.status === 'running' && job.keyExpiresAt;
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="run-top">
      <label class="run-check"><input type="checkbox" data-select="${job.id}" ${selected.has(job.id) ? 'checked' : ''} aria-label="${esc(t('runs.select'))}: ${esc(job.title)}"></label>
      <div class="run-id">
        <div class="run-name">${esc(job.title || job.imageName)}</div>
        <div class="run-meta">${esc(v(job.subtitle || job.platform || ''))} · <span data-elapsed>${elapsed(job)}</span>${job.expiresAt && job.status === 'ready' ? ` · ${h('runs.linksExpire')} ${time(job.expiresAt)}` : ''}</div>
        <div class="badges">
          <span class="badge ${enc ? 'enc' : ''}">${h(enc ? 'runs.encrypted' : 'runs.private')}</span>
          ${job.recovered ? `<span class="badge warn">${h('runs.resumed')}</span>` : ''}
          ${showKey ? `<span class="badge key">${h('runs.keyExpires')} <b data-key-exp="${job.keyExpiresAt}">${countdown(job.keyExpiresAt)}</b></span>` : ''}
        </div>
      </div>
      <span class="status ${job.status}">${h(`status.${job.status}`)}</span>
    </div>
    ${job.status === 'failed' ? `<p class="run-sentence bad" data-ui="run-failed">${h('runs.failedSentence')}</p>` : ''}
    ${job.status === 'ready' ? `<p class="run-sentence good">${h('runs.readySentence')}</p>` : ''}
    <div class="track" style="grid-template-columns: repeat(${job.stages.length}, 1fr)">${job.stages.map((s) => `<i class="${s.state}" title="${esc(v(s.label))}"></i>`).join('')}</div>
    <ol class="stages">${job.stages.map((s) => `<li class="${s.state}"><span class="dot"></span><span>${esc(v(s.label))}</span><span class="detail" title="${esc(v(s.detail || ''))}">${esc(v(s.detail || ''))}</span></li>`).join('')}</ol>
    ${job.runs?.length > 1 ? `<div class="subruns">${job.runs.map((r) => `<a class="subrun ${r.conclusion || r.status}" ${r.url && job.status === 'running' ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''}><span class="dot"></span>${esc(r.name)}<span class="muted">${esc(r.conclusion || r.status)}</span></a>`).join('')}</div>` : ''}
    ${job.warnings?.length ? `<details class="wf-warn run-warn"><summary>${job.warnings.length} ${h('runs.changes')}</summary><ul>${job.warnings.map((x) => `<li>${esc(v(x))}</li>`).join('')}</ul></details>` : ''}
    ${job.error ? `<p class="run-error">${esc(v(job.error))}</p>` : ''}
    ${job.outputs?.length && job.status === 'ready' ? `
      <div class="laps">
        <div class="laps-head"><span>${h('runs.outputs')}</span>${enc ? `<span class="ok">✓ ${h('runs.decrypted')}</span>` : ''}</div>
        ${job.outputs.map((o) => `<div class="lap"><span class="lap-name" title="${esc(o.name)}">${esc(o.name)}</span><span class="lap-size">${fmtBytes(o.size)}</span><a class="btn primary small" href="${withKey(o.url)}" download>↓ ${h('runs.download')}</a></div>`).join('')}
        ${job.kind === 'dockerfile' ? `<div class="load-cmd">docker load -i ${esc(job.outputs[0].name.split('/').pop())}</div>` : ''}
      </div>` : ''}
    <div class="run-actions">
      ${job.runUrl && job.status === 'running' ? `<a class="btn" href="${esc(job.runUrl)}" target="_blank" rel="noopener">${h('runs.watch')} ↗</a>` : ''}
      ${job.status !== 'running' ? `<button class="btn quiet" type="button" data-remove="${job.id}">${h('runs.dismiss')}</button>` : ''}
    </div>`;
}

function haystack(job) {
  return [job.title, job.subtitle, job.status, job.mode, job.error, ...(job.outputs || []).map((o) => o.name), ...(job.runs || []).map((r) => r.name)].join(' ');
}

export function upsert(job) {
  const prev = builds.get(job.id);
  builds.set(job.id, job);
  if (!root) return;
  let el = root.querySelector(`#run-${job.id}`);
  if (!el) {
    el = document.createElement('article');
    el.id = `run-${job.id}`;
    el.dataset.ui = 'run-card';
    root.querySelector('.run-list').prepend(el);
  }
  el.className = `run ${job.status}${job.mode === 'encrypted-public' ? ' enc' : ''}`;
  el.hidden = !matcher(haystack(job));
  el.innerHTML = card(job);
  if (prev && prev.status === 'running' && job.status !== 'running') {
    notify(job.status === 'ready' ? t('runs.readySentence') : t('runs.failedSentence'), { kind: job.status === 'ready' ? 'success' : 'error', detail: job.status === 'ready' ? job.title : `${job.title}: ${v(job.error || '')}` });
  }
  counts();
}

export function removeBuild(id) {
  builds.delete(id);
  selected.delete(id);
  root?.querySelector(`#run-${id}`)?.remove();
  counts();
}

function counts() {
  if (!root) return;
  root.querySelector('.empty').hidden = builds.size > 0;
  const live = [...builds.values()].filter((j) => j.status === 'running').length;
  for (const b of document.querySelectorAll('[data-badge="runs"]')) { b.textContent = live; b.hidden = live === 0; }
  const bar = root.querySelector('.bulk-bar');
  bar.querySelector('.bulk-count').textContent = t('runs.selected', { n: selected.size });
  bar.classList.toggle('has', selected.size > 0);
}

function refilter() {
  for (const job of builds.values()) {
    const el = root.querySelector(`#run-${job.id}`);
    if (el) el.hidden = !matcher(haystack(job));
  }
}

function mount(el) {
  root = el;
  el.classList.add('runs-view');
  el.innerHTML = `
    <div class="runs-head">
      <div><p class="eyebrow">${h('runs.eyebrow')}</p><h2>${h('runs.title')}</h2></div>
      <div class="runs-tools"></div>
      <button class="text-btn" type="button" data-sweep data-ui="sweep">${h('runs.sweep')}</button>
    </div>
    <div class="bulk-bar" data-ui="bulk-bar">
      <span class="bulk-count"></span>
      <button class="btn small" type="button" data-bulk="all">${h('runs.selectAll')}</button>
      <button class="btn small" type="button" data-bulk="none">${h('runs.selectNone')}</button>
      <button class="btn small" type="button" data-bulk="invert">${h('runs.invert')}</button>
      <span class="spacer"></span>
      <label class="bulk-export"><span class="sr-only">${h('export.format')}</span><select data-bulk-format>${exporter.FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</select></label>
      <button class="btn small" type="button" data-bulk="export">${h('runs.bulkExport')}</button>
      <button class="btn small danger" type="button" data-bulk="dismiss">${h('runs.bulkDismiss')}</button>
    </div>
    <div class="run-list"></div>
    <div class="empty"><div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div><p>${h('runs.empty')}</p></div>`;
  el.querySelector('.runs-tools').append(searchField({ placeholderKey: 'runs.search', ui: 'runs-search', onChange: (m) => { matcher = m; refilter(); } }));
  for (const job of [...builds.values()].sort((a, b) => a.createdAt - b.createdAt)) upsert(job);
  counts();

  el.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-select]');
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.select); else selected.delete(cb.dataset.select);
    counts();
  });
  el.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      try { await api(`/api/builds/${rm.dataset.remove}`, { method: 'DELETE' }); removeBuild(rm.dataset.remove); } catch (err) { notify(err.message, { kind: 'error' }); }
      return;
    }
    if (e.target.closest('[data-sweep]')) {
      if (!(await superConfirm({ messageKey: 'confirm.sweep' }))) return;
      try {
        const { deleted } = await api('/api/sweep', { method: 'POST' });
        notify(deleted.length ? t('toast.swept', { n: deleted.length }) : t('toast.clean'), { kind: 'success' });
      } catch (err) { notify(err.message, { kind: 'error' }); }
      return;
    }
    const bulk = e.target.closest('[data-bulk]');
    if (!bulk) return;
    const visible = [...builds.values()].filter((j) => !root.querySelector(`#run-${j.id}`)?.hidden);
    const op = bulk.dataset.bulk;
    if (op === 'all') visible.forEach((j) => selected.add(j.id));
    if (op === 'none') selected.clear();
    if (op === 'invert') visible.forEach((j) => (selected.has(j.id) ? selected.delete(j.id) : selected.add(j.id)));
    if (op === 'export') {
      const rows = [...selected].map((id) => builds.get(id)).filter(Boolean).map((j) => ({ id: j.id, title: j.title, status: j.status, mode: j.mode, created: new Date(j.createdAt).toISOString(), repo: j.repo, outputs: (j.outputs || []).map((o) => o.name), error: j.error || '' }));
      const fmt = root.querySelector('[data-bulk-format]').value;
      if (rows.length) notify(t('export.done', { name: exporter.download(rows, fmt, 'runs') }), { kind: 'success', speak: false });
    }
    if (op === 'dismiss') {
      const ids = [...selected].filter((id) => builds.get(id)?.status !== 'running');
      if (!ids.length) return;
      if (!(await superConfirm({ messageKey: 'confirm.dismissMany', vars: { n: ids.length } }))) return;
      const failures = [];
      for (const id of ids) { try { await api(`/api/builds/${id}`, { method: 'DELETE' }); removeBuild(id); } catch (err) { failures.push(`${id}: ${err.message}`); } }
      if (failures.length) notify(t('common.error'), { kind: 'error', detail: failures.join('; ') });
    }
    for (const cb of root.querySelectorAll('[data-select]')) cb.checked = selected.has(cb.dataset.select);
    counts();
  });
}

export function register() {
  registry.destination({ id: 'runs', titleKey: 'tab.runs', icon: '◉', order: 30, badge: true, mount });
  registry.command({ id: 'runs.sweep', titleKey: 'runs.sweep', tab: 'runs', run: () => registry.teleport({ tab: 'runs', target: '[data-sweep]' }) });
  on('hello', ({ builds: list }) => { for (const j of [...list].reverse()) upsert(j); });
  on('build', upsert);
  on('remove', ({ id }) => removeBuild(id));
  setInterval(() => {
    if (!root) return;
    for (const job of builds.values()) {
      if (job.status !== 'running') continue;
      const e = root.querySelector(`#run-${job.id} [data-elapsed]`);
      if (e) e.textContent = elapsed(job);
      const k = root.querySelector(`#run-${job.id} [data-key-exp]`);
      if (k) k.textContent = countdown(Number(k.dataset.keyExp));
    }
  }, 1000);
}

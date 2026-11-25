// Recipes tab: saved build requests that can be run again with one click or
// on a schedule. Recipes live on the server, so schedules run with the
// browser closed (while the app itself is running).
import * as registry from '../core/registry.js';
import { STRINGS } from '../core/strings.js';
import { t, h, v, esc } from '../core/i18n.js';
import { api, on } from '../core/api.js';
import { notify, play } from '../core/feedback.js';
import { searchField } from '../ui/regex-builder.js';
import { superConfirm } from '../ui/confirm.js';
import { currentRequest } from './workflows.js';

Object.assign(STRINGS, {
  'tab.recipes': { en: 'Recipes', yue: '食譜' },
  'rec.title': { en: ['Recipes', 'Recipes', 'Recipes', 'Build it again. One click.', 'Build it again. One click.'], yue: ['食譜', '食譜', '食譜', '再整一次，一撳搞掂。', '再整一次，一撳搞掂。'] },
  'rec.lede': { en: 'A recipe is a saved Workflows form. Run it again with one click, or let the app start it on a schedule.', yue: '食譜即係儲低咗嘅工作流程表格。一撳就再行，或者交畀個 app 按時間表自動開始。' },
  'rec.search': { en: 'Search recipes', yue: '搵食譜' },
  'rec.name': { en: 'Recipe name', yue: '食譜名' },
  'rec.save': { en: 'Save the current Workflows form', yue: '儲存而家嘅工作流程表格' },
  'rec.saveWhy': { en: 'Uses the repository, scripts, workflows, runner, outputs and mode chosen in the Workflows tab right now: {what}', yue: '用而家喺「工作流程」分頁揀咗嘅儲存庫、腳本、工作流程、runner、輸出同模式：{what}' },
  'rec.nothing': { en: 'nothing chosen yet', yue: '未揀任何嘢' },
  'rec.saved': { en: 'Recipe “{name}” saved.', yue: '已儲存食譜「{name}」。' },
  'rec.empty': { en: 'No recipes yet. Fill in the Workflows form once, then save it here.', yue: '未有食譜。填一次工作流程表格，再喺度儲存。' },
  'rec.noMatch': { en: 'No recipe matches. Try fewer words or switch off regex.', yue: '冇食譜符合，試吓少啲字或者閂咗 regex。' },
  'rec.run': { en: 'Run now', yue: '即刻行' },
  'rec.started': { en: '“{name}” started. Follow it in Runs.', yue: '「{name}」開始咗，可以喺「執行」跟進。' },
  'rec.delete': { en: 'Delete', yue: '刪除' },
  'rec.deleted': { en: 'Recipe deleted.', yue: '已刪除食譜。' },
  'confirm.recDelete': { en: 'Delete the recipe “{name}”? Builds it already started are kept.', yue: '刪除食譜「{name}」？佢已經開始咗嘅建置會保留。' },
  'rec.schedule': { en: 'Schedule', yue: '時間表' },
  'rec.sched.manual': { en: 'Only when you press Run', yue: '淨係你撳先行' },
  'rec.sched.interval': { en: 'Every few hours', yue: '每隔幾個鐘' },
  'rec.sched.daily': { en: 'Every day at a time', yue: '每日定時' },
  'rec.hours': { en: 'Hours between runs', yue: '相隔幾多個鐘' },
  'rec.time': { en: 'Time of day (server clock)', yue: '時間（伺服器時鐘）' },
  'rec.next': { en: 'next: {when}', yue: '下次：{when}' },
  'rec.schedNote': { en: 'Schedules run while the app is running, even with this page closed.', yue: '只要個 app 行緊，就算閂咗呢頁時間表都會照行。' },
  'rec.last.never': { en: 'Never run', yue: '未行過' },
  'rec.last.started': { en: 'last: started {when}', yue: '上次：{when} 開始' },
  'rec.last.ready': { en: 'last: ready in {took} · {when}', yue: '上次：{took} 完成 · {when}' },
  'rec.last.failed': { en: 'last: failed · {when}', yue: '上次：失敗 · {when}' },
  'rec.last.error': { en: 'last: could not start — {error}', yue: '上次：開始唔到 — {error}' },
  'rec.auto': { en: 'scheduled', yue: '自動' },
  'rec.enc': { en: 'encrypted', yue: '加密' },
  'rec.private': { en: 'private', yue: '私人' },
});

let recipes = [];
let redraw = () => {};
const when = (ms) => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)); } catch { return String(ms); } };
const took = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

async function refresh() {
  try { recipes = (await api('/api/recipes')).recipes; } catch { /* offline: keep the last list */ }
  redraw();
}

function describe(req) {
  if (!req?.repo) return t('rec.nothing');
  const n = (req.scripts?.length || 0) + (req.workflows?.length || 0);
  return n ? `${req.repo} · ${[...(req.scripts || []), ...(req.workflows || [])].slice(0, 3).join(', ')}${n > 3 ? ` +${n - 3}` : ''}` : `${req.repo} · ${t('rec.nothing')}`;
}

function lastLine(r) {
  const l = r.lastRun;
  if (!l) return h('rec.last.never');
  const auto = l.scheduled ? ` · ${t('rec.auto')}` : '';
  if (l.error) return esc(t('rec.last.error', { error: v(l.error) })) + auto;
  if (l.status === 'ready') return esc(t('rec.last.ready', { took: took(l.ms || 0), when: when(l.at) })) + auto;
  if (l.status === 'failed') return esc(t('rec.last.failed', { when: when(l.at) })) + auto;
  return esc(t('rec.last.started', { when: when(l.at) })) + auto;
}

function card(r, i) {
  const q = r.request;
  const chips = [...(q.scripts || []), ...(q.workflows || []).map((w) => w.split('/').pop()), q.runner, q.platform, ...(q.outputs || []).slice(0, 2)].filter(Boolean);
  const s = r.schedule;
  const state = r.lastRun?.error || r.lastRun?.status === 'failed' ? 'bad' : r.lastRun?.status === 'ready' ? 'good' : '';
  return `<li class="rec-card" style="--i:${i}" data-rec="${esc(r.id)}" data-search="${esc(r.name)}" data-ui="recipe">
    <div class="rec-head"><strong class="rec-name">${esc(v(r.name))}</strong><span class="ext-chip ${q.mode === 'encrypted-public' ? 'hook' : ''}">${h(q.mode === 'encrypted-public' ? 'rec.enc' : 'rec.private')}</span></div>
    <p class="muted small rec-repo">${esc(q.repo ? `${q.repo} @ ${q.ref}` : q.imageName || '')}</p>
    <div class="ext-chips">${chips.map((c) => `<span class="ext-chip">${esc(c)}</span>`).join('')}</div>
    <div class="rec-sched">
      <label class="field"><span>${h('rec.schedule')}</span><select data-rec-type>${['manual', 'interval', 'daily'].map((k) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${esc(t(`rec.sched.${k}`))}</option>`).join('')}</select></label>
      ${s.type === 'interval' ? `<label class="field"><span>${h('rec.hours')}</span><input type="number" min="1" max="168" step="1" value="${s.hours}" data-rec-hours></label>` : ''}
      ${s.type === 'daily' ? `<label class="field"><span>${h('rec.time')}</span><input type="time" value="${esc(s.time)}" data-rec-time></label>` : ''}
    </div>
    <p class="rec-status ${state}"><i class="dot"></i><span>${lastLine(r)}${r.nextAt ? ` · ${esc(t('rec.next', { when: when(r.nextAt) }))}` : ''}</span></p>
    <div class="rec-actions"><button type="button" class="fab small" data-rec-run>▶ ${h('rec.run')}</button><button type="button" class="text-btn danger" data-rec-del>${h('rec.delete')}</button></div>
  </li>`;
}

function mount(el) {
  el.innerHTML = `<header class="info-head"><div><p class="eyebrow">${h('tab.recipes')}</p><h1>${h('rec.title')}</h1><p class="muted ext-lede">${h('rec.lede')}</p></div></header>
    <form class="rec-new panel" data-rec-new><label class="field grow"><span>${h('rec.name')}</span><input name="name" maxlength="60" required autocomplete="off"></label><button type="submit" class="btn primary">${h('rec.save')}</button><p class="muted small rec-what"></p></form>
    <div class="info-filters"><div class="info-search"></div></div>
    <ul class="rec-list" aria-live="polite"></ul>
    <p class="muted small">${h('rec.schedNote')}</p>`;
  let matcher = () => true;
  const list = el.querySelector('.rec-list');
  redraw = () => {
    el.querySelector('.rec-what').textContent = t('rec.saveWhy', { what: describe(currentRequest()) });
    const hits = recipes.filter((r) => matcher(`${r.name} ${r.request.repo || ''} ${(r.request.scripts || []).join(' ')} ${(r.request.workflows || []).join(' ')}`));
    list.innerHTML = hits.length ? hits.map(card).join('') : `<li class="empty">${h(recipes.length ? 'rec.noMatch' : 'rec.empty')}</li>`;
  };
  el.querySelector('.info-search').append(searchField({ placeholderKey: 'rec.search', ui: 'rec-search', onChange: (m) => { matcher = m; redraw(); } }));
  const find = (node) => recipes.find((r) => r.id === node.closest('[data-rec]')?.dataset.rec);
  el.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-rec-new]')) return;
    e.preventDefault();
    const name = e.target.elements.name.value;
    try { const r = await api('/api/recipes', { method: 'POST', body: { name, request: currentRequest() } }); notify(t('rec.saved', { name: r.name }), { kind: 'success' }); play('confirm'); e.target.reset(); } catch (err) { notify(v(err.message), { kind: 'error' }); }
    refresh();
  });
  el.addEventListener('change', async (e) => {
    const r = e.target.closest('[data-rec]') && find(e.target);
    if (!r || !e.target.matches('[data-rec-type],[data-rec-hours],[data-rec-time]')) return;
    const c = e.target.closest('[data-rec]');
    const type = c.querySelector('[data-rec-type]').value;
    const schedule = type === 'interval' ? { type, hours: Number(c.querySelector('[data-rec-hours]')?.value || 24) } : type === 'daily' ? { type, time: c.querySelector('[data-rec-time]')?.value || '02:00' } : { type: 'manual' };
    try { await api(`/api/recipes/${r.id}`, { method: 'PUT', body: { name: r.name, schedule } }); } catch (err) { notify(v(err.message), { kind: 'error' }); }
    refresh();
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-rec-run]')) {
      const r = find(e.target);
      try {
        const { build } = await api(`/api/recipes/${r.id}/run`, { method: 'POST' });
        document.dispatchEvent(new CustomEvent('mac:build', { detail: build }));
        notify(t('rec.started', { name: r.name }), { kind: 'progress' });
        await registry.teleport({ tab: 'runs' });
      } catch (err) { notify(v(err.message), { kind: 'error' }); refresh(); }
      return;
    }
    if (e.target.closest('[data-rec-del]')) {
      const r = find(e.target);
      if (!(await superConfirm({ messageKey: 'confirm.recDelete', vars: { name: r.name } }))) return;
      try { await api(`/api/recipes/${r.id}`, { method: 'DELETE' }); notify(t('rec.deleted'), { kind: 'success' }); } catch (err) { notify(v(err.message), { kind: 'error' }); }
      refresh();
    }
  });
  new MutationObserver(() => { if (!el.hidden) redraw(); }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  refresh();
}

export function register() {
  registry.destination({ id: 'recipes', titleKey: 'tab.recipes', icon: '☰', order: 15, mount });
  on('recipes', refresh);
  on('hello', refresh);
}

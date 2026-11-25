// Docs, Changelog, History (notifications + settings changes) and Completeness tabs.
import * as registry from '../core/registry.js';
import * as store from '../core/store.js';
import { STRINGS } from '../core/strings.js';
import { t, h, v, esc } from '../core/i18n.js';
import * as feedback from '../core/feedback.js';
import * as exporter from '../core/exporter.js';
import { searchField } from '../ui/regex-builder.js';
import { superConfirm } from '../ui/confirm.js';
import { render as md } from '../ui/markdown.js';

Object.assign(STRINGS, {
  'docs.pages': { en: 'Pages', yue: '頁面' },
  'docs.noMatch': { en: 'No page matches. Try fewer words or switch off regex.', yue: '冇頁面符合，試吓少啲字或者閂咗 regex。' },
  'docs.failed': { en: 'The documentation bundle could not be read.', yue: '讀唔到說明書。' },
  'cl.added': { en: 'Added', yue: '新增' },
  'cl.fixed': { en: 'Fixed', yue: '修正' },
  'cl.changed': { en: 'Changed', yue: '改動' },
  'hist.notifications': { en: 'Notifications', yue: '通知' },
  'hist.settings': { en: 'Settings changes', yue: '設定改動' },
  'hist.export': { en: 'Export', yue: '匯出' },
  'hist.private': { en: 'Personal wording is never recorded here.', yue: '個人詞彙永遠唔會記錄喺度。' },
  'comp.summary': { en: '{done} done · {partial} partial · {missing} not built · {na} not applicable — of {total}', yue: '{done} 完成 · {partial} 部分 · {missing} 未做 · {na} 唔適用 — 共 {total}' },
  'comp.all': { en: 'All', yue: '全部' },
  'comp.proof': { en: 'Proof', yue: '證據' },
  'prov.version': { en: 'Version {version}', yue: '版本 {version}' },
  'prov.updated': { en: 'updated {date}', yue: '更新於 {date}' },
  'prov.unknown': { en: 'update time unknown', yue: '更新時間不明' },
});

const fmtDate = (d) => { try { return new Intl.DateTimeFormat(store.get('lang') === 'yue' ? 'zh-HK' : undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d)); } catch { return String(d); } };
const getJson = async (url) => { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

// ---------- Docs ----------
function mountDocs(el) {
  el.innerHTML = `<div class="info-layout">
    <aside class="info-side"><p class="eyebrow">${h('docs.pages')}</p><div class="info-search"></div><nav class="doc-nav" aria-label="${esc(t('docs.pages'))}"></nav><p class="muted small">${h('docs.offline')}</p></aside>
    <article class="doc-body prose" tabindex="-1" aria-live="polite"><p class="muted">${h('common.loading')}</p></article></div>`;
  const nav = el.querySelector('.doc-nav');
  const body = el.querySelector('.doc-body');
  const pages = [];
  let matcher = () => true;
  let current = null;
  function list() {
    const hits = pages.filter((p) => matcher(`${p.title}\n${p.text}`));
    nav.innerHTML = hits.length ? hits.map((p) => `<button type="button" class="doc-link" data-doc="${p.id}" aria-current="${p.id === current}">${esc(v(p.title))}</button>`).join('') : `<p class="muted small">${h('docs.noMatch')}</p>`;
  }
  function open(id) {
    const p = pages.find((x) => x.id === id);
    if (!p) return;
    current = id;
    body.innerHTML = md(v(p.text), { base: location.origin + '/docs/' });
    body.dataset.search = p.title;
    list();
    body.focus({ preventScroll: true });
  }
  el.querySelector('.info-search').append(searchField({ placeholderKey: 'docs.search', ui: 'docs-search', onChange: (m) => { matcher = m; list(); } }));
  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-doc]'); if (b) open(b.dataset.doc); });
  (async () => {
    try {
      const idx = await getJson('/docs/index.json');
      for (const p of idx.pages) pages.push({ ...p, text: await (await fetch(`/docs/${p.file}`)).text() });
      for (const p of pages) registry.command({ id: `docs.${p.id}`, title: `${t('docs.title')}: ${p.title}`, tab: 'docs', run: async () => { await registry.teleport({ tab: 'docs' }); open(p.id); } });
      open(pages[0]?.id);
    } catch (err) { body.innerHTML = `<p class="run-error">${h('docs.failed')} <code>${esc(err.message)}</code></p>`; }
  })();
}

// ---------- Changelog ----------
function mountChangelog(el) {
  el.innerHTML = `<header class="info-head"><div><p class="eyebrow">${h('tab.changelog')}</p><h1>${h('cl.title')}</h1></div>
    <div class="info-filters"><div class="info-search"></div>
    <label class="field"><span>${h('cl.from')}</span><input type="date" data-from></label>
    <label class="field"><span>${h('cl.to')}</span><input type="date" data-to></label></div></header>
    <ol class="cl-list" aria-live="polite"></ol>`;
  const list = el.querySelector('.cl-list');
  let data = [];
  let matcher = () => true;
  function draw() {
    const from = el.querySelector('[data-from]').value;
    const to = el.querySelector('[data-to]').value;
    const rel = data.filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
      .map((r) => ({ ...r, changes: r.changes.filter((c) => matcher(`${r.version} ${r.title} ${c.text}`)) }))
      .filter((r) => r.changes.length);
    list.innerHTML = rel.length ? rel.map((r, i) => `<li class="cl-rel" style="--i:${i}">
      <div class="cl-ver"><span class="pill">v${esc(r.version)}</span><time datetime="${r.date}">${esc(r.date)}</time></div>
      <div><h2>${esc(v(r.title))}</h2><ul>${r.changes.map((c) => `<li><span class="cl-type ${esc(c.type)}">${h(`cl.${c.type}`)}</span> ${esc(v(c.text))}</li>`).join('')}</ul></div></li>`).join('')
      : `<li class="empty">${h('cl.empty')}</li>`;
  }
  el.querySelector('.info-search').append(searchField({ placeholderKey: 'cl.search', ui: 'cl-search', onChange: (m) => { matcher = m; draw(); } }));
  el.addEventListener('input', (e) => { if (e.target.matches('[data-from],[data-to]')) draw(); });
  getJson('/changelog.json').then((j) => { data = j.releases; draw(); }).catch((err) => { list.innerHTML = `<li class="run-error">${esc(err.message)}</li>`; });
}

// ---------- History: notifications + settings changes ----------
function mountHistory(el) {
  el.innerHTML = `<header class="info-head"><div><p class="eyebrow">${h('tab.history')}</p><h1>${h('hist.title')}</h1><p class="muted small">${h('hist.private')}</p></div>
    <div class="info-filters"><div class="info-search"></div>
    <select data-hist-format aria-label="${esc(t('export.format'))}">${exporter.FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</select>
    <button type="button" class="btn" data-hist-export>${h('hist.export')}</button></div></header>
    <div class="split2">
      <section><div class="panel-head"><h2>${h('hist.notifications')}</h2><button type="button" class="text-btn" data-clear-notes>${h('notify.clear')}</button></div><ol class="note-list" aria-live="polite"></ol></section>
      <section><div class="panel-head"><h2>${h('hist.settings')}</h2></div><ol class="hist-list"></ol></section>
    </div>`;
  let matcher = () => true;
  const notes = el.querySelector('.note-list');
  const changes = el.querySelector('.hist-list');
  function draw() {
    const n = feedback.notifications().filter((x) => matcher(`${x.message} ${x.detail || ''}`));
    notes.innerHTML = n.length ? n.map((x) => `<li class="note ${esc(x.kind)}"><span class="dot"></span><div><p>${esc(x.message)}</p>${x.detail ? `<p class="muted small">${esc(x.detail)}</p>` : ''}<time class="muted small">${esc(fmtDate(x.at))}</time></div><button type="button" class="icon-btn" data-dismiss-note="${esc(x.id)}" aria-label="${esc(t('notify.dismiss'))}">×</button></li>`).join('') : `<li class="empty">${h('notify.empty')}</li>`;
    const c = store.history().slice().reverse().filter((x) => matcher(`${x.key} ${JSON.stringify(x.after)} ${x.source || ''}`));
    changes.innerHTML = c.length ? c.slice(0, 300).map((x) => `<li class="hist-change"><div><code>${esc(x.key)}</code> → <code>${esc(JSON.stringify(x.after)).slice(0, 80)}</code><p class="muted small">${esc(fmtDate(x.at))} · ${esc(x.source || 'user')}</p></div><button type="button" class="btn quiet" data-restore="${esc(x.id)}">${h('hist.restore')}</button></li>`).join('') : `<li class="empty">${h('hist.empty')}</li>`;
  }
  el.querySelector('.info-search').append(searchField({ placeholderKey: 'hist.filter', ui: 'hist-search', onChange: (m) => { matcher = m; draw(); } }));
  el.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-dismiss-note]');
    if (d) { feedback.dismissNotification(d.dataset.dismissNote); return; }
    const r = e.target.closest('[data-restore]');
    if (r) { store.restore(r.dataset.restore); feedback.notify(t('hist.restored'), { kind: 'success' }); return; }
    if (e.target.closest('[data-clear-notes]')) { if (await superConfirm({ messageKey: 'notify.clear' })) feedback.clearNotifications(); return; }
    if (e.target.closest('[data-hist-export]')) {
      const rows = [...feedback.notifications().map((x) => ({ type: 'notification', at: x.at, kind: x.kind, text: x.message })), ...store.history().map((x) => ({ type: 'setting', at: x.at, kind: x.key, text: JSON.stringify(x.after) }))];
      exporter.download(rows, el.querySelector('[data-hist-format]').value, 'history');
    }
  });
  feedback.onNotifications(draw);
  store.onChange(draw);
  draw();
}

// ---------- Completeness ----------
function mountCompleteness(el) {
  el.innerHTML = `<header class="info-head"><div><p class="eyebrow">${h('tab.completeness')}</p><h1>${h('comp.title')}</h1><p class="muted">${h('comp.lede')}</p></div></header>
    <div class="comp-meter" aria-hidden="true"></div><p class="comp-summary" aria-live="polite"></p>
    <div class="info-filters"><div class="info-search"></div><div class="segmented" role="radiogroup" data-comp-filter>${['all', 'done', 'partial', 'missing', 'na'].map((s, i) => `<button type="button" role="radio" aria-checked="${i === 0}" data-status="${s}">${h(s === 'all' ? 'comp.all' : `comp.${s}`)}</button>`).join('')}</div></div>
    <div class="comp-areas"></div>`;
  let data = [];
  let matcher = () => true;
  let status = 'all';
  function draw() {
    const c = (s) => data.filter((f) => f.status === s).length;
    const total = data.length || 1;
    el.querySelector('.comp-summary').innerHTML = h('comp.summary', { done: c('done'), partial: c('partial'), missing: c('missing'), na: c('na'), total: data.length });
    el.querySelector('.comp-meter').innerHTML = ['done', 'partial', 'missing', 'na'].map((s) => `<i class="${s}" style="flex:${c(s) / total}"></i>`).join('');
    const hits = data.filter((f) => (status === 'all' || f.status === status) && matcher(`${f.id} ${f.title} ${f.area} ${f.note}`));
    const areas = [...new Set(hits.map((f) => f.area))];
    el.querySelector('.comp-areas').innerHTML = areas.length ? areas.map((a) => `<section class="comp-area"><h2>${esc(v(a))}</h2><ul>${hits.filter((f) => f.area === a).map((f, i) => `<li class="comp-row ${f.status}" style="--i:${i}" data-search="${esc(f.title)}">
      <span class="comp-badge">${h(`comp.${f.status}`)}</span><div><strong>${esc(v(f.title))}</strong> <code class="small">${esc(f.id)}</code><p class="muted small">${esc(v(f.note))}${f.proof ? ` · ${h('comp.proof')}: <code>${esc(f.proof)}</code>` : ''}</p></div></li>`).join('')}</ul></section>`).join('') : `<p class="empty">${h('cl.empty')}</p>`;
  }
  el.querySelector('.info-search').append(searchField({ placeholderKey: 'comp.search', ui: 'comp-search', onChange: (m) => { matcher = m; draw(); } }));
  el.querySelector('[data-comp-filter]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    status = b.dataset.status;
    for (const x of el.querySelectorAll('[data-status]')) x.setAttribute('aria-checked', String(x === b));
    draw();
  });
  getJson('/completeness.json').then((j) => { data = j.features; draw(); }).catch((err) => { el.querySelector('.comp-areas').innerHTML = `<p class="run-error">${esc(err.message)}</p>`; });
}

// ---------- Front-screen provenance ----------
export async function provenance(target) {
  try {
    const p = await getJson('/api/provenance');
    target.innerHTML = `${h('prov.version', { version: esc(p.version) })}${p.commit ? ` · <code>${esc(p.commit)}</code>` : ''} · ${p.updatedAt ? h('prov.updated', { date: esc(fmtDate(p.updatedAt)) }) : h('prov.unknown')}`;
  } catch { target.innerHTML = h('prov.unknown'); }
}

export function register() {
  registry.destination({ id: 'docs', titleKey: 'tab.docs', icon: '❏', order: 55, mount: mountDocs });
  registry.destination({ id: 'changelog', titleKey: 'tab.changelog', icon: '✎', order: 60, mount: mountChangelog });
  registry.destination({ id: 'history', titleKey: 'tab.history', icon: '↺', order: 70, mount: mountHistory });
  registry.destination({ id: 'completeness', titleKey: 'tab.completeness', icon: '◔', order: 80, mount: mountCompleteness });
}

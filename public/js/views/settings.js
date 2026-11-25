// Settings: every preference with an explanation, an info button, search with
// the regex builder, live palette controls, history with restore, import/export.
import * as registry from '../core/registry.js';
import * as store from '../core/store.js';
import * as vocab from '../core/vocab.js';
import { t, h, esc } from '../core/i18n.js';
import { notify, play, say, voices } from '../core/feedback.js';
import * as exporter from '../core/exporter.js';
import { searchField } from '../ui/regex-builder.js';
import { superConfirm } from '../ui/confirm.js';

const SETTINGS = [
  { id: 'lang', key: 'lang', section: 'language', titleKey: 'set.language', whyKey: 'set.language.why', control: 'select', options: [['en', 'set.lang.en'], ['yue', 'set.lang.yue'], ['bi', 'set.lang.bi']] },
  { id: 'funnyEn', key: 'funnyEn', section: 'language', titleKey: 'set.funnyEn', whyKey: 'set.funny.why', control: 'range', min: 1, max: 5 },
  { id: 'funnyYue', key: 'funnyYue', section: 'language', titleKey: 'set.funnyYue', whyKey: 'set.funny.why', control: 'range', min: 1, max: 5 },
  { id: 'dialogEmoji', key: 'dialogEmoji', section: 'language', titleKey: 'set.emoji', whyKey: 'set.emoji.why', control: 'toggle' },
  { id: 'theme', key: 'theme', section: 'look', titleKey: 'set.theme', whyKey: 'set.theme.why', control: 'select', options: [['dark', 'set.theme.dark'], ['light', 'set.theme.light'], ['system', 'set.theme.system']] },
  { id: 'accent', key: 'accent', section: 'look', titleKey: 'set.accent', whyKey: 'set.accent.why', control: 'color' },
  { id: 'textScale', key: 'textScale', section: 'look', titleKey: 'set.textScale', whyKey: 'set.textScale.why', control: 'range', min: 80, max: 160, step: 10 },
  { id: 'density', key: 'density', section: 'look', titleKey: 'set.density', whyKey: 'set.density.why', control: 'select', options: [['comfortable', 'set.density.comfortable'], ['compact', 'set.density.compact']] },
  { id: 'motion', key: 'motion', section: 'look', titleKey: 'set.motion', whyKey: 'set.motion.why', control: 'select', options: [['full', 'set.motion.full'], ['reduced', 'set.motion.reduced']] },
  { id: 'sounds', key: 'sounds', section: 'sound', titleKey: 'set.sounds', whyKey: 'set.sounds.why', control: 'toggle' },
  { id: 'volume', key: 'volume', section: 'sound', titleKey: 'set.volume', whyKey: 'set.sounds.why', control: 'range', min: 0, max: 100, step: 5 },
  { id: 'narrate', key: 'narrate', section: 'sound', titleKey: 'set.narrate', whyKey: 'set.narrate.why', control: 'toggle' },
  { id: 'narrateRate', key: 'narrateRate', section: 'sound', titleKey: 'set.rate', whyKey: 'set.narrate.why', control: 'range', min: 0.5, max: 2, step: 0.1 },
  { id: 'schoolMode', key: 'schoolMode', section: 'modes', titleKey: 'set.school', whyKey: 'set.school.why', control: 'toggle' },
  { id: 'adhd', key: 'adhd', section: 'modes', titleKey: 'set.adhd', whyKey: 'set.adhd.why', control: 'select', options: [['off', 'set.adhd.off'], ['focus', 'set.adhd.focus'], ['calm', 'set.adhd.calm']] },
  { id: 'dimSum', key: 'dimSum', section: 'modes', titleKey: 'set.dimsum', whyKey: 'set.dimsum.why', control: 'toggle' },
  { id: 'displayName', key: 'displayName', section: 'identity', titleKey: 'set.displayName', whyKey: 'set.displayName.why', control: 'text' },
];
const SECTIONS = [['language', 'set.language'], ['look', 'set.theme'], ['sound', 'set.sounds'], ['modes', 'set.school'], ['identity', 'set.displayName'], ['vocab', 'set.vocab'], ['schedule', 'set.schedule'], ['history', 'set.history'], ['data', 'set.export']];

let root;
let matcher = () => true;

function control(s) {
  const val = store.get(s.key);
  const id = `set-${s.id}`;
  switch (s.control) {
    case 'toggle': return `<label class="switch"><input type="checkbox" id="${id}" data-key="${s.key}" ${val ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span><span class="sr-only">${h(s.titleKey)}</span></label>`;
    case 'range': return `<div class="range-row"><input type="range" id="${id}" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step || 1}" value="${esc(val)}" aria-label="${esc(t(s.titleKey))}"><output for="${id}">${esc(val)}</output></div>`;
    case 'select': return `<div class="segmented" role="radiogroup" aria-label="${esc(t(s.titleKey))}">${s.options.map(([v, k]) => `<button type="button" role="radio" aria-checked="${String(val) === v}" data-key="${s.key}" data-value="${v}">${h(k)}</button>`).join('')}</div>`;
    case 'color': return `<input type="color" id="${id}" data-key="${s.key}" value="${esc(val)}" aria-label="${esc(t(s.titleKey))}">`;
    case 'text': return `<input type="text" id="${id}" data-key="${s.key}" value="${esc(val)}" maxlength="60" aria-label="${esc(t(s.titleKey))}">`;
    default: return '';
  }
}

function row(s) {
  return `<div class="set-row" data-setting="${s.id}" data-search="${esc(`${t(s.titleKey)} ${t(s.whyKey)}`)}">
    <div class="set-text"><span class="set-title">${h(s.titleKey)}</span>
      <button type="button" class="info-btn" aria-expanded="false" aria-label="${esc(t('set.info'))}: ${esc(t(s.titleKey))}" data-info>i</button>
      <p class="set-why" hidden>${h(s.whyKey)}</p></div>
    <div class="set-ctl">${control(s)}</div></div>`;
}

function vocabPanel() {
  const st = vocab.status();
  return `<div class="set-row" data-setting="vocab" data-search="${esc(`${t('set.vocab')} ${t('set.vocab.why')} JSON`)}">
    <div class="set-text"><span class="set-title">${h('set.vocab')}</span>
      <button type="button" class="info-btn" aria-expanded="false" aria-label="${esc(t('set.info'))}" data-info>i</button>
      <p class="set-why" hidden>${h('set.vocab.why')}</p>
      <p class="set-state" aria-live="polite">${st.loaded ? h('set.vocab.loaded', { n: st.count }) : h('set.vocab.none')}</p></div>
    <div class="set-ctl stack-inline">
      <label class="btn"><input type="file" accept="application/json,.json" data-vocab-file hidden>${h(st.loaded ? 'set.vocab.replace' : 'set.vocab.upload')}</label>
      ${st.loaded ? `<button type="button" class="btn quiet" data-vocab-clear>${h('set.vocab.clear')}</button>` : ''}
    </div></div>`;
}

function voicePanel() {
  const list = voices();
  const cur = store.get('voice');
  return `<div class="set-row" data-setting="voice" data-search="${esc(t('set.voice'))}">
    <div class="set-text"><span class="set-title">${h('set.voice')}</span></div>
    <div class="set-ctl stack-inline"><select data-key="voice" aria-label="${esc(t('set.voice'))}"><option value="">${esc(t('set.voice.auto'))}</option>${list.map((v) => `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</select>
      <button type="button" class="btn" data-voice-test>${h('set.test')}</button></div></div>`;
}

function schedulePanel() {
  const rows = store.get('schedule') || [];
  return `<div class="set-row column" data-setting="schedule" data-search="${esc(`${t('set.schedule')} ${t('set.schedule.why')}`)}">
    <div class="set-text"><span class="set-title">${h('set.schedule')}</span><p class="set-why">${h('set.schedule.why')}</p></div>
    <ol class="sched-list">${rows.map((r, i) => `<li><input type="time" value="${esc(r.at)}" data-sched="${i}" data-f="at" aria-label="time">
      <select data-sched="${i}" data-f="key" aria-label="setting">${SETTINGS.filter((s) => s.control !== 'text').map((s) => `<option value="${s.key}" ${s.key === r.key ? 'selected' : ''}>${esc(t(s.titleKey))}</option>`).join('')}</select>
      <input value="${esc(r.value)}" data-sched="${i}" data-f="value" aria-label="value"><button type="button" class="icon-btn" data-sched-del="${i}" aria-label="${esc(t('common.close'))}">×</button></li>`).join('')}</ol>
    <div class="stack-inline"><button type="button" class="btn" data-sched-add>${h('set.schedule.add')}</button>
      <label class="field grow"><span>${h('set.schedule.url')}</span><input type="url" data-key="scheduleUrl" value="${esc(store.get('scheduleUrl'))}" placeholder="https://…/settings.json"></label>
      <button type="button" class="btn" data-sched-load>${h('set.schedule.load')}</button></div></div>`;
}

function historyPanel() {
  const hist = store.history().slice().reverse().slice(0, 80);
  return `<div class="set-row column" data-setting="history" data-search="${esc(`${t('set.history')} ${t('set.history.why')}`)}">
    <div class="set-text"><span class="set-title">${h('set.history')}</span><p class="set-why">${h('set.history.why')}</p></div>
    <div class="hist-filters"><label>${h('hist.from')} <input type="date" data-hist-from></label><label>${h('hist.to')} <input type="date" data-hist-to></label><div class="hist-search"></div></div>
    <ol class="hist-list">${hist.length ? hist.map((r) => `<li data-at="${esc(r.at)}" data-text="${esc(`${r.key} ${JSON.stringify(r.before)} ${JSON.stringify(r.after)} ${r.source}`)}">
      <time datetime="${esc(r.at)}">${new Date(r.at).toLocaleString()}</time><code>${esc(r.key)}</code>
      <span class="hist-change">${esc(JSON.stringify(r.before)?.slice(0, 40))} → ${esc(JSON.stringify(r.after)?.slice(0, 40))}</span>
      <span class="muted">${esc(r.source)}</span><button type="button" class="btn small" data-restore="${esc(r.id)}">${h('hist.restore')}</button></li>`).join('') : `<li class="muted">${h('hist.empty')}</li>`}</ol></div>`;
}

function dataPanel() {
  return `<div class="set-row column" data-setting="data" data-search="${esc(`${t('set.export')} ${t('set.import')} ${t('set.reset')}`)}">
    <div class="stack-inline">
      <select data-export-format aria-label="${esc(t('export.format'))}">${exporter.FORMATS.map((f) => `<option value="${f.id}">${f.label}</option>`).join('')}</select>
      <button type="button" class="btn" data-export>${h('set.export')}</button>
      <label class="btn"><input type="file" accept="application/json" data-import hidden>${h('set.import')}</label>
      <button type="button" class="btn" data-onboarding>${h('set.onboarding')}</button>
      <button type="button" class="btn" data-tour>${h('set.tour')}</button>
      <button type="button" class="btn danger" data-reset>${h('set.reset')}</button>
    </div>
    <p class="muted"><strong>${h('set.monetization')}:</strong> ${h('set.monetization.why')}</p></div>`;
}

function render() {
  const bySection = (id) => SETTINGS.filter((s) => s.section === id).map(row).join('');
  root.querySelector('.set-body').innerHTML = SECTIONS.map(([id, k]) => `
    <section class="panel set-section" data-section="${id}" data-ui="settings-${id}"><h3>${h(k)}</h3>
      ${bySection(id)}
      ${id === 'sound' ? voicePanel() : ''}
      ${id === 'identity' ? '<div class="logo-slot"></div>' : ''}
      ${id === 'vocab' ? vocabPanel() : ''}
      ${id === 'schedule' ? schedulePanel() : ''}
      ${id === 'history' ? historyPanel() : ''}
      ${id === 'data' ? dataPanel() : ''}
    </section>`).join('');
  import('../ui/logo.js').then((m) => { const slot = root.querySelector('.logo-slot'); if (slot && m.logoSettings) slot.replaceWith(m.logoSettings()); }).catch(() => {});
  const hs = root.querySelector('.hist-search');
  if (hs) hs.append(searchField({ placeholderKey: 'hist.filter', ui: 'history-search', onChange: (m) => { histMatcher = m; filterHistory(); } }));
  filter();
}

let histMatcher = () => true;
function filterHistory() {
  const from = root.querySelector('[data-hist-from]')?.value;
  const to = root.querySelector('[data-hist-to]')?.value;
  for (const li of root.querySelectorAll('.hist-list li[data-at]')) {
    const day = li.dataset.at.slice(0, 10);
    li.hidden = (from && day < from) || (to && day > to) || !histMatcher(li.dataset.text);
  }
}

function filter() {
  for (const r of root.querySelectorAll('.set-row')) r.hidden = !matcher(r.dataset.search);
  for (const s of root.querySelectorAll('.set-section')) s.hidden = ![...s.querySelectorAll('.set-row')].some((r) => !r.hidden);
}

export async function loadVocabFile(file) {
  const text = await file.text();
  try {
    const st = vocab.load(text);
    play('tada');
    celebrate(st.name || t('set.vocab.applied'));
    return true;
  } catch (err) {
    play('invalid');
    notify(t('set.vocab.invalid', { reason: err.message }), { kind: 'error', sound: false });
    return false;
  }
}

function celebrate(headline) {
  const el = document.createElement('div');
  el.className = 'levelup';
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="levelup-burst" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div><strong>${esc(headline)}</strong>`;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 3000);
  setTimeout(() => el.remove(), 3600);
}

function mount(el) {
  root = el;
  el.classList.add('settings-view');
  el.innerHTML = `<div class="set-head"><div><p class="eyebrow">${h('tab.settings')}</p><h2>${h('set.title')}</h2></div><div class="set-search"></div></div><div class="set-body"></div>`;
  el.querySelector('.set-search').append(searchField({ placeholderKey: 'set.search', ui: 'settings-search', onChange: (m) => { matcher = m; filter(); } }));
  render();
  el.addEventListener('click', async (e) => {
    const info = e.target.closest('[data-info]');
    if (info) { const why = info.parentElement.querySelector('.set-why'); why.hidden = !why.hidden; info.setAttribute('aria-expanded', String(!why.hidden)); return; }
    const seg = e.target.closest('[data-value][data-key]');
    if (seg) { store.set(seg.dataset.key, seg.dataset.value); return; }
    if (e.target.closest('[data-vocab-clear]')) { vocab.clear(); notify(t('set.vocab.cleared'), { kind: 'success' }); return; }
    if (e.target.closest('[data-voice-test]')) { say(t('runs.readySentence'), { force: true }); return; }
    if (e.target.closest('[data-sched-add]')) { store.set('schedule', [...(store.get('schedule') || []), { at: '22:00', key: 'theme', value: 'dark' }]); return; }
    const sd = e.target.closest('[data-sched-del]');
    if (sd) { const list = [...store.get('schedule')]; list.splice(+sd.dataset.schedDel, 1); store.set('schedule', list); return; }
    if (e.target.closest('[data-sched-load]')) { loadRemoteSettings(); return; }
    const rs = e.target.closest('[data-restore]');
    if (rs) { if (store.restore(rs.dataset.restore)) notify(t('hist.restored'), { kind: 'success' }); return; }
    if (e.target.closest('[data-export]')) {
      const fmt = root.querySelector('[data-export-format]').value;
      const all = store.get();
      const rows = Object.entries(all).map(([key, value]) => ({ key, value }));
      notify(t('export.done', { name: exporter.download(rows, fmt, 'settings') }), { kind: 'success', speak: false });
      return;
    }
    if (e.target.closest('[data-reset]')) { if (await superConfirm({ messageKey: 'confirm.reset' })) { store.clearAll(); location.reload(); } return; }
    if (e.target.closest('[data-tour]')) { (await import('../ui/onboarding.js')).startTour(); return; }
    if (e.target.closest('[data-onboarding]')) { (await import('../ui/onboarding.js')).startOnboarding(); }
  });
  el.addEventListener('input', (e) => {
    const c = e.target;
    if (c.dataset.sched !== undefined) {
      const list = [...store.get('schedule')];
      list[+c.dataset.sched] = { ...list[+c.dataset.sched], [c.dataset.f]: c.value };
      store.set('schedule', list, { silent: true });
      return;
    }
    if (c.matches('[data-hist-from], [data-hist-to]')) { filterHistory(); return; }
    if (!c.dataset.key || c.dataset.value) return;
    const value = c.type === 'checkbox' ? c.checked : c.type === 'range' ? Number(c.value) : c.value;
    if (c.type === 'range') c.nextElementSibling.textContent = c.value;
    store.set(c.dataset.key, value, { silent: c.type === 'text' || c.type === 'range' || c.type === 'url' });
    if (c.type === 'text' || c.type === 'range') document.dispatchEvent(new CustomEvent('mac:setting', { detail: c.dataset.key }));
  });
  el.addEventListener('change', async (e) => {
    if (e.target.matches('[data-vocab-file]') && e.target.files[0]) { await loadVocabFile(e.target.files[0]); e.target.value = ''; }
    if (e.target.matches('[data-key="voice"]')) store.set('voice', e.target.value);
    if (e.target.matches('[data-import]') && e.target.files[0]) {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        const rows = Array.isArray(data) ? data : Object.entries(data).map(([key, value]) => ({ key, value }));
        for (const { key, value } of rows) if (key in store.DEFAULTS) store.set(key, value, { source: 'import' });
        notify(t('set.saved'), { kind: 'success' });
      } catch (err) { notify(t('common.error'), { kind: 'error', detail: err.message }); }
    }
  });
  try { speechSynthesis.onvoiceschanged = () => { const slot = root.querySelector('[data-setting="voice"]'); if (slot) slot.outerHTML = voicePanel(); }; } catch { /* no speech */ }
  store.onChange((key) => { if (key !== 'tabs' && root.isConnected) { const scrollY = root.scrollTop; render(); root.scrollTop = scrollY; } });
  vocab.onChange(() => { if (root.isConnected) render(); });
}

export async function loadRemoteSettings() {
  const url = store.get('scheduleUrl');
  if (!url) return;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    for (const [key, value] of Object.entries(data)) if (key in store.DEFAULTS && key !== 'scheduleUrl') store.set(key, value, { source: 'url' });
    notify(t('set.saved'), { kind: 'success', speak: false });
  } catch (err) { notify(t('common.error'), { kind: 'error', detail: err.message }); }
}

export function register() {
  registry.destination({ id: 'settings', titleKey: 'tab.settings', icon: '⚙︎', order: 90, mount });
  for (const s of SETTINGS) registry.setting({ ...s, tab: 'settings' });
  registry.setting({ id: 'vocab', key: '__vocab', titleKey: 'set.vocab', whyKey: 'set.vocab.why', control: 'custom', tab: 'settings' });
  registry.setting({ id: 'schedule', key: '__schedule', titleKey: 'set.schedule', whyKey: 'set.schedule.why', control: 'custom', tab: 'settings' });
  registry.setting({ id: 'history', key: '__history', titleKey: 'set.history', whyKey: 'set.history.why', control: 'custom', tab: 'settings' });
  registry.command({ id: 'settings.reset', titleKey: 'set.reset', run: () => registry.teleport({ tab: 'settings', target: '[data-reset]' }) });
  registry.command({ id: 'settings.export', titleKey: 'set.export', run: () => registry.teleport({ tab: 'settings', target: '[data-export]' }) });
  registry.command({ id: 'vocab.clear', titleKey: 'set.vocab.clear', run: () => { vocab.clear(); notify(t('set.vocab.cleared'), { kind: 'success' }); } });
  // Scheduled settings: check every minute.
  let last = '';
  setInterval(() => {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hm === last) return;
    last = hm;
    for (const r of store.get('schedule') || []) {
      if (r.at !== hm) continue;
      const def = store.DEFAULTS[r.key];
      const value = typeof def === 'boolean' ? r.value === 'true' : typeof def === 'number' ? Number(r.value) : r.value;
      store.set(r.key, value, { source: 'schedule' });
    }
  }, 15000);
}

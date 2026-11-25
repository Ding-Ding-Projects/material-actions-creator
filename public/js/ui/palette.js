// Ctrl+Shift+F command palette: indexes every tab, command, setting and feature,
// shows live controls for settings, and teleports to the exact element.
import * as registry from '../core/registry.js';
import * as store from '../core/store.js';
import { t, h, esc } from '../core/i18n.js';
import { searchField } from './regex-builder.js';

let dlg;
let results = [];
let index = 0;
let matcher = () => true;

function entries() {
  const out = [];
  for (const d of registry.allDestinations()) out.push({ kind: 'tab', id: `tab:${d.id}`, title: t(d.titleKey), run: () => registry.teleport({ tab: d.id }) });
  for (const c of registry.allCommands()) out.push({ kind: 'command', id: `cmd:${c.id}`, title: c.titleKey ? t(c.titleKey) : c.title, keywords: c.keywords || '', shortcut: c.shortcut, run: c.run });
  for (const s of registry.allSettings()) out.push({ kind: 'setting', id: `set:${s.id}`, title: t(s.titleKey), keywords: s.whyKey ? t(s.whyKey) : '', setting: s, run: () => registry.teleport({ tab: s.tab || 'settings', target: s.target || `[data-setting="${s.id}"]` }) });
  return out;
}

function control(s) {
  const val = store.get(s.key);
  switch (s.control) {
    case 'toggle': return `<input type="checkbox" class="pal-ctl" data-key="${s.key}" ${val ? 'checked' : ''} aria-label="${esc(t(s.titleKey))}">`;
    case 'range': return `<input type="range" class="pal-ctl" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step || 1}" value="${esc(val)}" aria-label="${esc(t(s.titleKey))}"><output>${esc(val)}</output>`;
    case 'select': return `<select class="pal-ctl" data-key="${s.key}" aria-label="${esc(t(s.titleKey))}">${s.options.map(([v, k]) => `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>`;
    case 'color': return `<input type="color" class="pal-ctl" data-key="${s.key}" value="${esc(val)}" aria-label="${esc(t(s.titleKey))}">`;
    default: return '';
  }
}

function renderList() {
  results = entries().filter((e) => matcher(`${e.title} ${e.keywords || ''} ${e.kind}`)).slice(0, 60);
  index = Math.min(index, Math.max(0, results.length - 1));
  const list = dlg.querySelector('.pal-list');
  list.innerHTML = results.length ? results.map((e, i) => `
    <li role="option" id="pal-${i}" aria-selected="${i === index}" class="${i === index ? 'on' : ''}" data-i="${i}">
      <span class="pal-kind ${e.kind}">${h(`palette.kind.${e.kind}`)}</span>
      <span class="pal-title">${esc(e.title)}</span>
      ${e.setting ? `<span class="pal-live">${control(e.setting)}</span>` : ''}
      ${e.shortcut ? `<kbd>${esc(e.shortcut)}</kbd>` : ''}
    </li>`).join('') : `<li class="pal-empty">${h('palette.empty')}</li>`;
  dlg.querySelector('.pal-list').setAttribute('aria-activedescendant', `pal-${index}`);
}

function runAt(i) {
  const e = results[i];
  if (!e) return;
  close();
  e.run?.();
}

export function open() {
  if (!dlg) build();
  dlg.showModal();
  index = 0;
  renderList();
  dlg.querySelector('.rx-input').focus();
}

export function close() { dlg?.open && dlg.close(); }

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'palette';
  dlg.setAttribute('aria-label', t('palette.title'));
  dlg.dataset.ui = 'palette';
  dlg.innerHTML = `<div class="pal-inner"><div class="pal-search"></div><ul class="pal-list" role="listbox" aria-label="${esc(t('palette.title'))}"></ul><p class="pal-foot muted">↑↓ · Enter · Esc · <kbd>Ctrl+Shift+F</kbd></p></div>`;
  const field = searchField({ placeholderKey: 'palette.placeholder', ui: 'palette-search', onChange: (m) => { matcher = m; index = 0; renderList(); } });
  dlg.querySelector('.pal-search').append(field);
  document.body.append(dlg);
  dlg.addEventListener('keydown', (e) => {
    if (e.target.closest('.rx-panel')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(results.length - 1, index + 1); renderList(); dlg.querySelector('.pal-list li.on')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); renderList(); dlg.querySelector('.pal-list li.on')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter' && !e.target.classList.contains('pal-ctl')) { e.preventDefault(); runAt(index); }
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) { close(); return; }
    if (e.target.closest('.pal-ctl')) return;
    const li = e.target.closest('li[data-i]');
    if (li) runAt(Number(li.dataset.i));
  });
  dlg.addEventListener('input', (e) => {
    const c = e.target.closest('.pal-ctl');
    if (!c) return;
    const value = c.type === 'checkbox' ? c.checked : c.type === 'range' ? Number(c.value) : c.value;
    store.set(c.dataset.key, value);
    const out = c.nextElementSibling;
    if (out?.tagName === 'OUTPUT') out.textContent = c.value;
  });
}

export function init() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); if (dlg?.open) close(); else open(); }
  });
  registry.command({ id: 'palette.open', titleKey: 'palette.title', shortcut: 'Ctrl+Shift+F', run: open });
}

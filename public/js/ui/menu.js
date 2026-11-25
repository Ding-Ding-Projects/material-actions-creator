// A context menu on every element. Items show the shortcuts that actually work.
import { t, h, esc } from '../core/i18n.js';
import { say, notify } from '../core/feedback.js';
import * as store from '../core/store.js';
import * as registry from '../core/registry.js';
import * as palette from './palette.js';
import * as tabs from './tabs.js';
import * as exporter from '../core/exporter.js';

let menu;

function keyFor(el) {
  const ui = el.closest('[data-ui]');
  return ui ? ui.dataset.ui : null;
}

export function applyLocks(root = document) {
  const locked = new Set(store.get('lockedElements') || []);
  for (const el of root.querySelectorAll('[data-ui]')) {
    const on = locked.has(el.dataset.ui);
    el.classList.toggle('ui-locked', on);
    if (on) el.setAttribute('aria-disabled', 'true'); else if (el.classList.contains('was-locked')) el.removeAttribute('aria-disabled');
    if (on) el.classList.add('was-locked');
  }
}

function items(target) {
  const out = [];
  const tab = target.closest('[data-tab-id]');
  const selection = String(getSelection() || '').trim();
  const text = selection || target.closest('p, li, h1, h2, h3, label, button, a, td, pre, code, span')?.innerText?.trim() || '';
  if (tab) {
    const id = tab.dataset.tabId;
    const pinned = tab.classList.contains('pinned');
    out.push({ label: t(pinned ? 'tabs.unpin' : 'tabs.pin'), run: () => tabs.togglePin(id) });
    out.push({ label: t('tabs.moveLeft'), shortcut: 'Ctrl+Shift+PgUp', run: () => tabs.move(id, -1) });
    out.push({ label: t('tabs.moveRight'), shortcut: 'Ctrl+Shift+PgDn', run: () => tabs.move(id, 1) });
    if (!pinned) out.push({ label: t('tabs.close'), shortcut: 'Delete', run: () => tabs.close(id) });
    out.push({ label: t('tabs.closeOthers'), run: () => tabs.closeOthers(id) });
    out.push({ label: t('tabs.openAll'), run: () => tabs.openAll() });
    out.push('-');
  }
  if (text) out.push({ label: t('menu.copy'), shortcut: 'Ctrl+C', run: async () => { try { await navigator.clipboard.writeText(text); notify(t('common.copied'), { kind: 'success', speak: false }); } catch { /* blocked */ } } });
  if (text) out.push({ label: t('menu.narrate'), run: () => say(text, { force: true }) });
  out.push({ label: t('menu.customize'), run: async () => { const m = await import('./appearance-editor.js').catch(() => null); if (m?.openAppearanceEditor) m.openAppearanceEditor(target.closest('[data-ui]') || target); else notify(t('common.error'), { kind: 'warn', detail: 'Appearance editor is not available in this build.' }); } });
  const key = keyFor(target);
  if (key) {
    const locked = (store.get('lockedElements') || []).includes(key);
    out.push({ label: t(locked ? 'menu.unlock' : 'menu.lock'), run: () => {
      const list = new Set(store.get('lockedElements') || []);
      if (locked) list.delete(key); else list.add(key);
      store.set('lockedElements', [...list]);
      applyLocks();
    } });
  }
  out.push({ label: t('menu.exportPage'), run: () => {
    const view = target.closest('.view');
    const rows = [...(view || document.body).querySelectorAll('h1, h2, h3, p, li, label, td')].map((el) => ({ tag: el.tagName.toLowerCase(), text: el.innerText.trim() })).filter((r) => r.text);
    exporter.download(rows, 'md', `page-${tabs.active()}`);
  } });
  out.push('-');
  out.push({ label: t('menu.palette'), shortcut: 'Ctrl+Shift+F', run: () => palette.open() });
  return out;
}

function close() { if (menu) { menu.remove(); menu = null; } }

export function openAt(x, y, target) {
  close();
  const list = items(target);
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.dataset.ui = 'context-menu';
  menu.innerHTML = list.map((it, i) => (it === '-' ? '<hr>' : `<button type="button" role="menuitem" data-i="${i}"><span>${esc(it.label)}</span>${it.shortcut ? `<kbd>${esc(it.shortcut)}</kbd>` : ''}</button>`)).join('');
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  const before = document.activeElement;
  menu.querySelector('button')?.focus();
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = list[Number(b.dataset.i)];
    close();
    before?.focus?.();
    it.run();
  });
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); before?.focus?.(); }
  });
}

export function init() {
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]') && !e.shiftKey) return; // keep native editing menus
    e.preventDefault();
    openAt(e.clientX, e.clientY, e.target);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && document.activeElement) {
      e.preventDefault();
      const r = document.activeElement.getBoundingClientRect();
      openAt(r.left + 8, r.bottom, document.activeElement);
    }
  });
  document.addEventListener('click', (e) => { if (menu && !e.target.closest('.ctx-menu')) close(); });
  document.addEventListener('click', (e) => {
    const locked = e.target.closest('.ui-locked');
    if (locked) { e.preventDefault(); e.stopPropagation(); notify(t('menu.locked'), { kind: 'warn', speak: false }); }
  }, true);
  addEventListener('blur', close);
  registry.command({ id: 'menu.unlockAll', titleKey: 'menu.unlockAll', run: () => { store.set('lockedElements', []); applyLocks(); } });
}

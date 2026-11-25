// Browser-style tab strip. Every destination opens by default; a tab the user
// closes stays closed until reopened from the New tab catalog or "Open every tab".
// Tabs reorder by drag or Ctrl+Shift+PageUp/PageDown, pin from the context menu,
// and the layout persists.
import * as store from '../core/store.js';
import * as registry from '../core/registry.js';
import { t, h, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';

let strip;
let views;
const mounted = new Set();

function layout() {
  const ids = registry.allDestinations().map((d) => d.id);
  const saved = store.get('tabs');
  if (!saved) {
    return { open: ids, closed: [], pinned: [], offered: ids, active: ids[0] };
  }
  // Updates open only tabs the strip has never offered before.
  const fresh = ids.filter((id) => !saved.offered.includes(id));
  const open = [...saved.open.filter((id) => ids.includes(id)), ...fresh];
  return { ...saved, open, offered: [...new Set([...saved.offered, ...ids])], active: open.includes(saved.active) ? saved.active : open[0] };
}

function save(l) { store.set('tabs', l, { source: 'tabs' }); }

function ordered(l) {
  const pinned = l.open.filter((id) => l.pinned.includes(id));
  return [...pinned, ...l.open.filter((id) => !l.pinned.includes(id))];
}

export function render() {
  const l = layout();
  const items = ordered(l).map((id) => registry.getDestination(id)).filter(Boolean);
  strip.innerHTML = `
    <div class="tabstrip-scroll" role="tablist" aria-label="${esc(t('tabs.catalog'))}">
      ${items.map((d) => `
        <div class="tab2 ${d.id === l.active ? 'active' : ''} ${l.pinned.includes(d.id) ? 'pinned' : ''}" data-tab-id="${d.id}" draggable="true">
          <button type="button" role="tab" class="tab2-main" id="tab-${d.id}" aria-selected="${d.id === l.active}" aria-controls="view-${d.id}" tabindex="${d.id === l.active ? 0 : -1}" data-ui="tab-${d.id}">
            <span class="tab2-icon" aria-hidden="true">${esc(d.icon)}</span><span class="tab2-label">${h(d.titleKey)}</span>${d.badge ? `<span class="live-count" data-badge="${d.id}"></span>` : ''}
          </button>
          ${l.pinned.includes(d.id) ? '' : `<button type="button" class="tab2-close" aria-label="${esc(t('tabs.close'))}: ${esc(t(d.titleKey))}" data-close="${d.id}">×</button>`}
        </div>`).join('')}
    </div>
    <button type="button" class="tab2-new" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('tabs.new'))}" title="${esc(t('tabs.new'))}">+</button>
    <div class="tab2-catalog" role="menu" hidden></div>`;
  for (const d of items) {
    let view = views.querySelector(`#view-${d.id}`);
    if (!view) {
      view = document.createElement('main');
      view.id = `view-${d.id}`;
      view.className = 'view';
      view.setAttribute('role', 'tabpanel');
      view.setAttribute('aria-labelledby', `tab-${d.id}`);
      view.dataset.view = d.id;
      views.append(view);
    }
  }
  for (const view of views.querySelectorAll('.view[data-view]')) {
    const show = view.dataset.view === l.active && l.open.includes(view.dataset.view);
    view.hidden = !show;
    if (show && !mounted.has(view.dataset.view)) {
      mounted.add(view.dataset.view);
      registry.getDestination(view.dataset.view)?.mount(view);
    }
  }
  strip.querySelector('.tab2.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.dispatchEvent(new CustomEvent('mac:tab', { detail: l.active }));
}

export function show(id) {
  return new Promise((resolve) => {
    const l = layout();
    if (!l.open.includes(id)) l.open.push(id);
    l.closed = l.closed.filter((x) => x !== id);
    l.active = id;
    const apply = () => { save(l); render(); resolve(); };
    if (document.startViewTransition && document.documentElement.dataset.motion !== 'reduced' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(apply);
    } else apply();
  });
}

export function close(id) {
  const l = layout();
  if (l.pinned.includes(id)) return;
  const order = ordered(l);
  const i = order.indexOf(id);
  l.open = l.open.filter((x) => x !== id);
  if (!l.closed.includes(id)) l.closed.push(id);
  if (l.active === id) l.active = order[i + 1] || order[i - 1] || l.open[0];
  save(l);
  render();
  strip.querySelector('.tab2.active .tab2-main')?.focus();
}

export function openAll() {
  const l = layout();
  const ids = registry.allDestinations().map((d) => d.id);
  if (ids.every((id) => l.open.includes(id))) { notify(t('tabs.allOpen'), { speak: false }); return; }
  l.open = [...l.open, ...ids.filter((id) => !l.open.includes(id))];
  l.closed = [];
  save(l);
  render();
}

export function togglePin(id) {
  const l = layout();
  l.pinned = l.pinned.includes(id) ? l.pinned.filter((x) => x !== id) : [...l.pinned, id];
  save(l);
  render();
}

export function move(id, delta) {
  const l = layout();
  const order = ordered(l);
  const i = order.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  l.open = order;
  save(l);
  render();
  strip.querySelector(`[data-tab-id="${id}"] .tab2-main`)?.focus();
}

export function closeOthers(id) {
  const l = layout();
  for (const x of [...l.open]) if (x !== id && !l.pinned.includes(x)) { l.open = l.open.filter((y) => y !== x); l.closed.push(x); }
  l.active = id;
  save(l);
  render();
}

export function active() { return layout().active; }

function catalog() {
  const l = layout();
  const menu = strip.querySelector('.tab2-catalog');
  const all = registry.allDestinations();
  menu.innerHTML = `
    <button type="button" role="menuitem" data-open-all>${h('tabs.openAll')}</button>
    <hr>
    ${all.map((d) => `<button type="button" role="menuitem" data-open="${d.id}"><span aria-hidden="true">${esc(d.icon)}</span> ${h(d.titleKey)}${l.open.includes(d.id) ? ' <span class="muted">✓</span>' : ''}</button>`).join('')}`;
  return menu;
}

export function init(stripEl, viewsEl) {
  strip = stripEl;
  views = viewsEl;
  registry.setTabSwitcher(show);
  strip.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { close(closeBtn.dataset.close); return; }
    const tab = e.target.closest('.tab2-main');
    if (tab) { show(tab.closest('[data-tab-id]').dataset.tabId); return; }
    const newBtn = e.target.closest('.tab2-new');
    if (newBtn) {
      const menu = catalog();
      menu.hidden = !menu.hidden;
      newBtn.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) menu.querySelector('button')?.focus();
      return;
    }
    if (e.target.closest('[data-open-all]')) { openAll(); return; }
    const open = e.target.closest('[data-open]');
    if (open) show(open.dataset.open);
  });
  strip.addEventListener('auxclick', (e) => {
    const tab = e.target.closest('[data-tab-id]');
    if (e.button === 1 && tab) close(tab.dataset.tabId);
  });
  strip.addEventListener('keydown', (e) => {
    const tab = e.target.closest('[data-tab-id]');
    if (e.key === 'Escape') { const m = strip.querySelector('.tab2-catalog'); if (m && !m.hidden) { m.hidden = true; strip.querySelector('.tab2-new').focus(); } return; }
    if (!tab) return;
    const id = tab.dataset.tabId;
    const order = ordered(layout());
    const i = order.indexOf(id);
    if (e.ctrlKey && e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) { e.preventDefault(); move(id, e.key === 'PageUp' ? -1 : 1); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = order[(i + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
      show(next).then(() => strip.querySelector(`[data-tab-id="${next}"] .tab2-main`)?.focus());
    }
    if (e.key === 'Delete') { e.preventDefault(); close(id); }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const target = e.key === 'Home' ? order[0] : order.at(-1); show(target).then(() => strip.querySelector(`[data-tab-id="${target}"] .tab2-main`)?.focus()); }
  });
  let dragId = null;
  strip.addEventListener('dragstart', (e) => { const tab = e.target.closest('[data-tab-id]'); if (tab) { dragId = tab.dataset.tabId; tab.classList.add('dragging'); } });
  strip.addEventListener('dragend', (e) => { e.target.closest('[data-tab-id]')?.classList.remove('dragging'); dragId = null; });
  strip.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  strip.addEventListener('drop', (e) => {
    const target = e.target.closest('[data-tab-id]');
    if (!dragId || !target || target.dataset.tabId === dragId) return;
    e.preventDefault();
    const l = layout();
    const order = ordered(l).filter((x) => x !== dragId);
    order.splice(order.indexOf(target.dataset.tabId), 0, dragId);
    l.open = order;
    save(l);
    render();
  });
  document.addEventListener('click', (e) => {
    const menu = strip.querySelector('.tab2-catalog');
    if (menu && !menu.hidden && !e.target.closest('.tab2-catalog, .tab2-new')) { menu.hidden = true; strip.querySelector('.tab2-new').setAttribute('aria-expanded', 'false'); }
  });
  registry.command({ id: 'tabs.openAll', titleKey: 'tabs.openAll', run: openAll });
  render();
}

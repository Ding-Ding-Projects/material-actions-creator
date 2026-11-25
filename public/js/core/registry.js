// One registry that tabs, the command palette, settings search and the
// completeness view all read from. Feature modules register here.
const destinations = new Map(); // id -> { id, titleKey, icon, mount(el, ctx), order }
const commands = new Map(); // id -> { id, titleKey, title, keywords, shortcut, run(), tab }
const settings = new Map(); // id -> { id, key, titleKey, whyKey, control, options, min, max, step, section, tab, target }
const listeners = new Set();

function changed() { for (const fn of listeners) fn(); }
export function onRegistry(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function destination(d) { destinations.set(d.id, { order: 100, icon: '◇', ...d }); changed(); }
export function command(c) { commands.set(c.id, c); changed(); }
export function setting(s) { settings.set(s.id, { section: 'general', ...s }); changed(); }

export function allDestinations() { return [...destinations.values()].sort((a, b) => a.order - b.order); }
export function getDestination(id) { return destinations.get(id); }
export function allCommands() { return [...commands.values()]; }
export function allSettings() { return [...settings.values()]; }
export function getCommand(id) { return commands.get(id); }

// Switches to the element's tab, scrolls to it, focuses it and flashes it.
let showTab = () => {};
export function setTabSwitcher(fn) { showTab = fn; }
export async function teleport({ tab, target }) {
  if (tab) await showTab(tab);
  if (!target) return;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const focusable = el.matches('input, select, textarea, button, a, [tabindex]') ? el : el.querySelector('input, select, textarea, button, a, [tabindex]');
  (focusable || el).focus?.({ preventScroll: true });
  el.classList.remove('teleport-flash');
  void el.offsetWidth;
  el.classList.add('teleport-flash');
}

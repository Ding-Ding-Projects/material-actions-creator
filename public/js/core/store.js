// Persisted settings with local version history.
// Every change becomes a revision (append-only); restoring makes a new revision.
const KEY = 'mac.settings.v1';
const HISTORY_KEY = 'mac.history.v1';
const MAX_HISTORY = 500;

export const DEFAULTS = {
  lang: 'en', // en | yue | bi
  funnyEn: 5,
  funnyYue: 5,
  dialogEmoji: true,
  theme: 'dark',
  accent: '#d4ff3a',
  density: 'comfortable',
  textScale: 100,
  motion: 'full', // full | reduced
  sounds: true,
  volume: 60,
  narrate: false,
  voice: '',
  narrateRate: 1,
  schoolMode: false,
  adhd: 'off', // off | focus | calm
  displayName: 'Material Actions Creator',
  logo: 'default',
  dimSum: true,
  onboarded: false,
  tourDone: false,
  tabs: null, // { open: [...ids], closed: [...ids], pinned: [...ids], offered: [...ids], active }
  schedule: [], // [{ at: 'HH:MM', key, value }]
  scheduleUrl: '',
  appearance: {}, // { [elementKey]: { color, background, fontSize, fontWeight, ... } }
  lockedElements: [],
};

const listeners = new Set();
let state = load();

function safeParse(text, fallback) {
  try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
}

function load() {
  let saved = {};
  try { saved = safeParse(localStorage.getItem(KEY), {}); } catch { /* storage blocked */ }
  return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: keep in memory */ }
}

export function get(key) {
  return key ? state[key] : { ...state };
}

export function history() {
  try { return safeParse(localStorage.getItem(HISTORY_KEY), []); } catch { return []; }
}

function record(entry) {
  try {
    const h = history();
    h.push(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-MAX_HISTORY)));
  } catch { /* ignore */ }
}

// Values that must never reach history or exports.
const PRIVATE_KEYS = new Set([]);

export function set(key, value, { source = 'user', silent = false } = {}) {
  const before = state[key];
  if (JSON.stringify(before) === JSON.stringify(value)) return;
  state = { ...state, [key]: value };
  persist();
  if (!PRIVATE_KEYS.has(key)) {
    record({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), key, before, after: value, source });
  }
  if (!silent) for (const fn of listeners) fn(key, value, before);
}

export function reset(key) {
  set(key, DEFAULTS[key], { source: 'reset' });
}

export function restore(revisionId) {
  const rev = history().find((r) => r.id === revisionId);
  if (!rev) return false;
  set(rev.key, rev.before, { source: `restore:${revisionId}` });
  return true;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearAll() {
  try { localStorage.removeItem(KEY); localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  state = { ...DEFAULTS };
  for (const fn of listeners) fn('*', null, null);
}

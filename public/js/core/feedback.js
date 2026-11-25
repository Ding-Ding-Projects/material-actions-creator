// Non-blocking notifications (corner toasts + a persisted notification centre),
// action sounds and spoken narration.
import * as store from './store.js';
import { t, esc } from './i18n.js';

const CENTER_KEY = 'mac.notifications.v1';
const listeners = new Set();
let items = loadCenter();

function loadCenter() {
  try { return JSON.parse(localStorage.getItem(CENTER_KEY)) || []; } catch { return []; }
}
function saveCenter() {
  try { localStorage.setItem(CENTER_KEY, JSON.stringify(items.slice(-200))); } catch { /* memory only */ }
}

export function notifications() { return [...items]; }
export function onNotifications(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(notifications()); }

export function clearNotifications() { items = []; saveCenter(); emit(); }
export function dismissNotification(id) { items = items.filter((n) => n.id !== id); saveCenter(); emit(); }

const ICONS = { info: 'ℹ', success: '✓', error: '!', progress: '◐', warn: '!' };

// kind: info | success | error | warn | progress
export function notify(message, { kind = 'info', detail = '', speak = true, sound = true, timeout } = {}) {
  const n = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: new Date().toISOString(), kind, message: String(message), detail: String(detail || '') };
  items.push(n);
  saveCenter();
  emit();
  const host = document.getElementById('toasts');
  if (host) {
    const el = document.createElement('div');
    el.className = `toast-card ${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast-icon" aria-hidden="true">${ICONS[kind] || ICONS.info}</span>
      <div class="toast-body"><strong>${esc(n.message)}</strong>${n.detail ? `<span>${esc(n.detail)}</span>` : ''}</div>
      <button class="toast-x" type="button" aria-label="${esc(t('notify.dismiss'))}">×</button>`;
    const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 260); };
    el.querySelector('.toast-x').addEventListener('click', remove);
    host.prepend(el);
    while (host.children.length > 4) host.lastElementChild.remove();
    setTimeout(remove, timeout ?? (kind === 'error' ? 9000 : 4500));
  }
  if (sound) play(kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'tick');
  if (speak) say(n.detail ? `${n.message}. ${n.detail}` : n.message);
  return n;
}

// ---------- sounds (synthesised, no files) ----------
let ctx = null;
const TONES = {
  tick: [[880, 0.04, 'sine']],
  success: [[660, 0.08, 'sine'], [880, 0.08, 'sine'], [1320, 0.16, 'sine']],
  error: [[330, 0.12, 'square'], [220, 0.2, 'square']],
  confirm: [[520, 0.06, 'triangle'], [780, 0.12, 'triangle']],
  tada: [[523, 0.09, 'triangle'], [659, 0.09, 'triangle'], [784, 0.09, 'triangle'], [1047, 0.32, 'triangle']],
  invalid: [[300, 0.1, 'sawtooth'], [240, 0.18, 'sawtooth']],
};

export function play(name) {
  if (!store.get('sounds') || store.get('schoolMode')) return;
  const seq = TONES[name];
  if (!seq) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const vol = Math.max(0, Math.min(1, (store.get('volume') ?? 60) / 100)) * 0.18;
    let at = ctx.currentTime;
    for (const [freq, dur, type] of seq) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(vol, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.02);
      at += dur * 0.85;
    }
  } catch { /* audio unavailable */ }
}

// ---------- narration ----------
export function voices() {
  try { return speechSynthesis.getVoices(); } catch { return []; }
}

export function say(text, { force = false } = {}) {
  if (!force && !store.get('narrate')) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    const lang = store.get('lang') === 'yue' ? 'zh-HK' : 'en';
    u.lang = lang;
    u.rate = Number(store.get('narrateRate')) || 1;
    const wanted = store.get('voice');
    const v = voices().find((x) => x.name === wanted) || voices().find((x) => x.lang?.toLowerCase().startsWith(lang.toLowerCase()));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* speech unavailable */ }
}

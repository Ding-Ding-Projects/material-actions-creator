// Every search box: plain text by default, with an adjacent full regex builder
// (guided tokens, raw editing, flags, sample text, live matches and captures,
// syntax feedback, copy/export, time-boxed evaluation and zero-width safety).
import { t, h, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';

const TOKENS = [
  ['regex.tok.any', '.'], ['regex.tok.digit', '\\d'], ['regex.tok.word', '\\w'], ['regex.tok.space', '\\s'],
  ['regex.tok.start', '^'], ['regex.tok.end', '$'], ['regex.tok.oneMore', '+'], ['regex.tok.zeroMore', '*'],
  ['regex.tok.optional', '?'], ['regex.tok.group', '()'], ['regex.tok.or', '|'],
];
const MAX_MATCHES = 500;
const BUDGET_MS = 40;

export function compile(pattern, flags) {
  try {
    return { re: new RegExp(pattern, flags.replace(/[^imsu]/g, '')), error: null };
  } catch (err) {
    return { re: null, error: err.message.replace(/^Invalid regular expression: /, '') };
  }
}

// Finds matches without looping forever on zero-width patterns and stops after a time budget.
export function findMatches(re, text, budget = BUDGET_MS) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  const start = performance.now();
  let m;
  while ((m = g.exec(text)) && out.length < MAX_MATCHES) {
    out.push({ index: m.index, text: m[0], groups: m.slice(1) });
    if (m[0] === '') g.lastIndex++;
    if (performance.now() - start > budget) return { matches: out, timedOut: true };
  }
  return { matches: out, timedOut: false };
}

let uid = 0;

export function searchField({ placeholderKey = 'palette.placeholder', onChange = () => {}, ui } = {}) {
  const id = `rx${++uid}`;
  const state = { mode: 'plain', text: '', pattern: '', flags: 'i', sample: '' };
  const wrap = document.createElement('div');
  wrap.className = 'rx';
  if (ui) wrap.dataset.ui = ui;
  wrap.innerHTML = `
    <div class="rx-bar">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="rx-icon"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input class="rx-input" type="search" id="${id}" autocomplete="off" spellcheck="false" placeholder="${esc(t(placeholderKey))}" aria-label="${esc(t(placeholderKey))}">
      <button type="button" class="rx-mode" aria-pressed="false" title="${esc(t('regex.regex'))}">.*</button>
      <button type="button" class="rx-open" aria-expanded="false" aria-controls="${id}-panel">${h('regex.open')}</button>
    </div>
    <div class="rx-panel" id="${id}-panel" hidden>
      <div class="rx-tokens" role="group" aria-label="${esc(t('regex.open'))}">${TOKENS.map(([k, tok]) => `<button type="button" data-tok="${esc(tok)}" title="${esc(tok)}">${h(k)} <code>${esc(tok)}</code></button>`).join('')}</div>
      <label class="rx-row"><span>${h('regex.regex')}</span><input class="rx-raw" spellcheck="false" autocomplete="off"></label>
      <div class="rx-row rx-flags" role="group" aria-label="${esc(t('regex.flags'))}"><span>${h('regex.flags')}</span>
        ${['i', 'm', 's', 'u'].map((f) => `<label><input type="checkbox" data-flag="${f}" ${f === 'i' ? 'checked' : ''}> ${f}</label>`).join('')}</div>
      <label class="rx-row"><span>${h('regex.sample')}</span><textarea class="rx-sample" rows="3" spellcheck="false"></textarea></label>
      <div class="rx-feedback" aria-live="polite"></div>
      <div class="rx-preview" aria-label="${esc(t('regex.matches', { n: '' }))}"></div>
      <div class="rx-captures"></div>
      <div class="rx-actions"><button type="button" class="rx-copy">${h('regex.copy')}</button><button type="button" class="rx-export">${h('regex.export')}</button></div>
    </div>`;
  const $ = (s) => wrap.querySelector(s);
  const input = $('.rx-input');
  const raw = $('.rx-raw');

  function matcher() {
    if (state.mode === 'plain') {
      const needle = state.text.trim().toLowerCase();
      return needle ? (s) => String(s ?? '').toLowerCase().includes(needle) : () => true;
    }
    if (!state.pattern) return () => true;
    const { re } = compile(state.pattern, state.flags);
    if (!re) return () => true;
    const started = performance.now();
    return (s) => {
      if (performance.now() - started > 200) return true; // isolation: never hang the page
      re.lastIndex = 0;
      return re.test(String(s ?? '').slice(0, 5000));
    };
  }

  function feedback() {
    const fb = $('.rx-feedback');
    const preview = $('.rx-preview');
    const caps = $('.rx-captures');
    if (!state.pattern) { fb.textContent = ''; preview.textContent = state.sample; caps.textContent = ''; return; }
    const { re, error } = compile(state.pattern, state.flags);
    wrap.classList.toggle('rx-bad', Boolean(error));
    if (error) { fb.textContent = `${t('regex.invalid')}: ${error}`; preview.textContent = state.sample; caps.textContent = ''; return; }
    const { matches, timedOut } = findMatches(re, state.sample);
    fb.textContent = timedOut ? t('regex.timeout') : t('regex.matches', { n: matches.length });
    let html = '';
    let last = 0;
    for (const m of matches) {
      html += esc(state.sample.slice(last, m.index));
      html += m.text ? `<mark>${esc(m.text)}</mark>` : `<mark class="zw" title="${esc(t('regex.zeroWidth'))}"></mark>`;
      last = m.index + m.text.length;
    }
    preview.innerHTML = html + esc(state.sample.slice(last));
    const groups = matches.filter((m) => m.groups.length).slice(0, 20);
    caps.innerHTML = groups.length ? `<strong>${h('regex.captures')}</strong><ol>${groups.map((m) => `<li>${m.groups.map((g, i) => `<code>$${i + 1}</code> ${esc(g ?? '∅')}`).join(' · ')}</li>`).join('')}</ol>` : '';
  }

  function sync() {
    $('.rx-mode').setAttribute('aria-pressed', String(state.mode === 'regex'));
    input.value = state.mode === 'regex' ? state.pattern : state.text;
    raw.value = state.pattern;
    input.classList.toggle('mono', state.mode === 'regex');
    feedback();
    onChange(matcher(), { ...state });
  }

  input.addEventListener('input', () => {
    if (state.mode === 'regex') state.pattern = input.value; else state.text = input.value;
    sync();
  });
  $('.rx-mode').addEventListener('click', () => {
    state.mode = state.mode === 'regex' ? 'plain' : 'regex';
    if (state.mode === 'regex' && !state.pattern) state.pattern = state.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sync();
  });
  $('.rx-open').addEventListener('click', () => {
    const panel = $('.rx-panel');
    panel.hidden = !panel.hidden;
    $('.rx-open').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { state.mode = 'regex'; sync(); raw.focus(); }
  });
  raw.addEventListener('input', () => { state.mode = 'regex'; state.pattern = raw.value; sync(); });
  $('.rx-sample').addEventListener('input', (e) => { state.sample = e.target.value; feedback(); });
  wrap.querySelectorAll('[data-flag]').forEach((cb) => cb.addEventListener('change', () => {
    state.flags = [...wrap.querySelectorAll('[data-flag]:checked')].map((x) => x.dataset.flag).join('');
    sync();
  }));
  wrap.querySelectorAll('[data-tok]').forEach((b) => b.addEventListener('click', () => {
    const tok = b.dataset.tok;
    const pos = raw.selectionStart ?? raw.value.length;
    raw.setRangeText(tok, pos, raw.selectionEnd ?? pos, 'end');
    if (tok === '()') raw.setSelectionRange(pos + 1, pos + 1);
    state.mode = 'regex';
    state.pattern = raw.value;
    sync();
    raw.focus();
  }));
  $('.rx-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(`/${state.pattern}/${state.flags}`); notify(t('common.copied'), { kind: 'success', speak: false }); } catch { /* clipboard blocked */ }
  });
  $('.rx-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ pattern: state.pattern, flags: state.flags, sample: state.sample }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'pattern.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('.rx-panel').hidden) { $('.rx-panel').hidden = true; $('.rx-open').setAttribute('aria-expanded', 'false'); e.stopPropagation(); }
  });

  wrap.focusInput = () => input.focus();
  wrap.clear = () => { state.text = ''; state.pattern = ''; sync(); };
  wrap.matcher = matcher;
  return wrap;
}

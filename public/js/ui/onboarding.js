// First-run setup wizard (real actions: language, GitHub connection check,
// default run mode, optional vocabulary) and a guided "Take a tour".
import * as store from '../core/store.js';
import { api } from '../core/api.js';
import { t, h, esc, translate } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import * as registry from '../core/registry.js';
import * as auth from './auth.js';

const STEPS = ['s1', 's2', 's3', 's4', 's5'];

export function startOnboarding() {
  let step = Number(store.get('onboardingStep')) || 0;
  const before = document.activeElement;
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet onboarding';
  dlg.dataset.ui = 'onboarding';
  document.body.append(dlg);

  async function body(id) {
    if (id === 's1') {
      return `<div class="ob-grid">
        <div class="segmented" role="radiogroup" aria-label="${esc(t('set.language'))}">${[['en', 'set.lang.en'], ['yue', 'set.lang.yue'], ['bi', 'set.lang.bi']].map(([v, k]) => `<button type="button" role="radio" aria-checked="${store.get('lang') === v}" data-ob-key="lang" data-ob-val="${v}">${h(k)}</button>`).join('')}</div>
        <label class="field"><span>${h('set.funnyEn')}: <output>${store.get('funnyEn')}</output></span><input type="range" min="1" max="5" value="${store.get('funnyEn')}" data-ob-range="funnyEn"></label>
        <label class="field"><span>${h('set.funnyYue')}: <output>${store.get('funnyYue')}</output></span><input type="range" min="1" max="5" value="${store.get('funnyYue')}" data-ob-range="funnyYue"></label>
        <p class="muted small">${h('set.funny.why')}</p></div>`;
    }
    if (id === 's2') {
      return `<div class="ob-check" aria-live="polite"><p class="muted">${h('common.loading')}</p></div>
        <div class="stack"><button type="button" class="btn" data-ob-check>${h('ob.s2.check')}</button><button type="button" class="fab small" data-ob-signin>${h('auth.signInWithCli')}</button></div>`;
    }
    if (id === 's3') {
      const cur = store.get('defaultMode') || 'private';
      return `<div class="modes" role="radiogroup">${[['private', 'mode.private'], ['encrypted-public', 'mode.enc']].map(([v, k]) => `<button type="button" role="radio" class="mode ${v === 'encrypted-public' ? 'enc' : ''}" aria-checked="${cur === v}" aria-pressed="${cur === v}" data-ob-key="defaultMode" data-ob-val="${v}"><span class="mode-title">${h(`${k}.title`)}</span><span class="mode-body">${h(`${k}.body`)}</span></button>`).join('')}</div>`;
    }
    if (id === 's4') {
      return `<label class="btn"><input type="file" accept="application/json,.json" data-ob-vocab hidden>${h('set.vocab.upload')}</label><p class="set-state" aria-live="polite"></p>`;
    }
    return `<p class="muted">${h('ob.s5.body')}</p>`;
  }

  async function check() {
    const box = dlg.querySelector('.ob-check');
    if (!box) return;
    try {
      const a = await api('/api/auth');
      box.innerHTML = a.signedIn ? `<p class="${a.missing.length ? 'hint' : 'ok'}">${h(a.missing.length ? 'ob.s2.missing' : 'ob.s2.ok', { login: a.login, scopes: a.missing.join(', ') })}</p>` : `<p class="hint">${h('ob.s2.no')}</p>`;
    } catch (err) { box.innerHTML = `<p class="run-error">${esc(err.message)}</p>`; }
  }

  async function render() {
    const id = STEPS[step];
    store.set('onboardingStep', step, { silent: true });
    dlg.innerHTML = `<div class="sheet-inner">
      <div class="ob-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${STEPS.length}" aria-valuenow="${step + 1}" aria-label="${esc(t('ob.step', { n: step + 1, total: STEPS.length }))}">${STEPS.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
      <p class="eyebrow">${h('ob.step', { n: step + 1, total: STEPS.length })}</p>
      <h2 id="ob-title">${h(`ob.${id}.title`)}</h2>
      ${id !== 's5' ? `<p class="muted">${h(`ob.${id}.body`)}</p>` : ''}
      <div class="ob-body">${await body(id)}</div>
      <div class="ob-nav">
        <button type="button" class="btn" data-ob="back" ${step === 0 ? 'disabled' : ''}>${h('ob.back')}</button>
        <span class="spacer"></span>
        ${['s2', 's4'].includes(id) ? `<button type="button" class="btn quiet" data-ob="skip">${h('ob.skip')}</button>` : ''}
        <button type="button" class="fab small" data-ob="next">${h(id === 's5' ? 'ob.finish' : 'ob.next')}</button>
      </div></div>`;
    dlg.setAttribute('aria-labelledby', 'ob-title');
    if (id === 's2') check();
    dlg.querySelector('[data-ob="next"]').focus();
  }

  function finish() {
    store.set('onboarded', true);
    store.set('onboardingStep', 0, { silent: true });
    dlg.close();
    dlg.remove();
    before?.focus?.();
    if (!store.get('tourDone')) startTour();
  }

  dlg.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-ob]');
    if (nav) {
      const op = nav.dataset.ob;
      if (op === 'back') step = Math.max(0, step - 1);
      if (op === 'next' || op === 'skip') { if (step === STEPS.length - 1) { finish(); return; } step++; }
      render();
      return;
    }
    const pick = e.target.closest('[data-ob-key]');
    if (pick) { store.set(pick.dataset.obKey, pick.dataset.obVal); translate(); render(); return; }
    if (e.target.closest('[data-ob-check]')) { check(); return; }
    if (e.target.closest('[data-ob-signin]')) { auth.open(); }
  });
  dlg.addEventListener('input', (e) => {
    const r = e.target.closest('[data-ob-range]');
    if (r) { store.set(r.dataset.obRange, Number(r.value), { silent: true }); r.previousElementSibling.querySelector('output').textContent = r.value; }
  });
  dlg.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-ob-vocab]') || !e.target.files[0]) return;
    const { loadVocabFile } = await import('../views/settings.js');
    const ok = await loadVocabFile(e.target.files[0]);
    dlg.querySelector('.set-state').innerHTML = ok ? h('set.vocab.applied') : '';
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });
  render();
  dlg.showModal();
}

const TOUR = [
  { target: '#tabstrip', key: 'tour.1' },
  { target: '#tab-workflows', key: 'tour.2', tab: 'workflows' },
  { target: '#tab-runs', key: 'tour.3' },
  { target: '#paletteBtn', key: 'tour.4' },
  { target: '#notifyBtn', key: 'tour.5' },
];

export function startTour() {
  let i = 0;
  const before = document.activeElement;
  const pop = document.createElement('div');
  pop.className = 'tour-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-live', 'polite');
  pop.dataset.ui = 'tour';
  const ring = document.createElement('div');
  ring.className = 'tour-ring';
  ring.setAttribute('aria-hidden', 'true');
  document.body.append(ring, pop);
  async function show() {
    const s = TOUR[i];
    if (s.tab) await registry.teleport({ tab: s.tab });
    const el = document.querySelector(s.target);
    const r = el?.getBoundingClientRect() || { left: innerWidth / 2, top: 80, width: 0, height: 0, bottom: 80 };
    Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    pop.innerHTML = `<p class="eyebrow">${i + 1} / ${TOUR.length}</p><p>${h(s.key)}</p>
      <div class="ob-nav"><button type="button" class="btn quiet" data-tour="skip">${h('tour.skip')}</button><span class="spacer"></span><button type="button" class="fab small" data-tour="next">${h(i === TOUR.length - 1 ? 'tour.done' : 'tour.next')}</button></div>`;
    const top = Math.min(innerHeight - 200, r.bottom + 16);
    Object.assign(pop.style, { left: `${Math.max(12, Math.min(innerWidth - 360, r.left))}px`, top: `${Math.max(12, top)}px` });
    pop.querySelector('[data-tour="next"]').focus();
  }
  function end() { ring.remove(); pop.remove(); store.set('tourDone', true); before?.focus?.(); notify(t('tour.done'), { kind: 'success', speak: false }); }
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tour]');
    if (!b) return;
    if (b.dataset.tour === 'skip' || i === TOUR.length - 1) { end(); return; }
    i++;
    show();
  });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') end(); });
  show();
}

export function init() {
  registry.command({ id: 'tour', titleKey: 'set.tour', run: startTour });
  registry.command({ id: 'onboarding', titleKey: 'set.onboarding', run: startOnboarding });
  if (!store.get('onboarded')) setTimeout(startOnboarding, 400);
}

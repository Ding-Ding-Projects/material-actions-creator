// Account button and the assisted GitHub CLI sign-in dialog.
import { api, on } from '../core/api.js';
import { t, h, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import * as registry from '../core/registry.js';

export let auth = null;
let dlg;

export async function refresh() {
  auth = await api('/api/auth');
  renderAccount();
  if (dlg?.open) renderDialog();
  return auth;
}

function renderAccount() {
  const name = document.getElementById('accountName');
  if (!name) return;
  name.innerHTML = auth?.signedIn ? esc(auth.login) : h('auth.signIn');
  const av = document.getElementById('avatar');
  av.style.backgroundImage = '';
  if (auth?.avatarUrl) { const img = new Image(); img.onload = () => { av.style.backgroundImage = `url("${auth.avatarUrl}")`; }; img.src = auth.avatarUrl; }
  document.getElementById('scopeDots').innerHTML = (auth?.required || []).map((s) => `<i class="${auth.signedIn && !auth.missing.includes(s) ? 'ok' : 'miss'}" title="${s}"></i>`).join('');
}

const scopes = (a) => `<div class="scopes">${a.required.map((s) => `<span class="scope ${a.signedIn && !a.missing.includes(s) ? 'ok' : 'miss'}">${s}</span>`).join('')}</div>`;

function renderDialog() {
  const a = auth || { required: [], missing: [] };
  const flow = a.flow || { state: 'idle' };
  const body = dlg.querySelector('#authBody');
  const title = dlg.querySelector('#authTitle');
  if (['starting', 'waiting'].includes(flow.state)) {
    title.innerHTML = h(flow.mode === 'refresh' ? 'auth.addScopes' : 'auth.signIn');
    body.innerHTML = flow.code ? `
      <p class="muted">${h('auth.paste')}</p>
      <div class="device-code"><strong>${esc(flow.code)}</strong><button class="btn" type="button" data-auth="copy">${h('auth.copy')}</button></div>
      <div class="stack"><a class="fab small" href="${esc(flow.url)}" target="_blank" rel="noopener">${esc(flow.url.replace('https://', ''))} ↗</a><button class="btn quiet" type="button" data-auth="cancel">${h('confirm.cancel')}</button></div>
      <p class="waiting"><i></i><i></i><i></i> ${h('auth.waiting')}</p>` : `<p class="waiting"><i></i><i></i><i></i> ${h('common.loading')}</p>`;
    return;
  }
  if (a.signedIn) {
    title.textContent = a.login;
    body.innerHTML = `${scopes(a)}${a.missing.length ? `<p class="hint">${h('auth.missing')}</p>` : ''}
      <div class="stack">${a.source === 'gh' && a.missing.length ? `<button class="fab small" type="button" data-auth="refresh">${h('auth.addScopes')}</button>` : ''}
      ${a.source === 'gh' ? `<button class="btn" type="button" data-auth="login">${h('auth.switch')}</button><button class="btn quiet" type="button" data-auth="logout">${h('auth.signOut')}</button>` : ''}</div>`;
    return;
  }
  title.innerHTML = h('auth.signIn');
  body.innerHTML = `<p class="muted">${h('auth.intro')}</p>${scopes(a)}
    ${flow.state === 'error' ? `<p class="run-error">${esc(flow.error)}</p>` : ''}${a.error ? `<p class="run-error">${esc(a.error)}</p>` : ''}
    <div class="stack">${a.ghAvailable ? `<button class="fab small" type="button" data-auth="login">${h('auth.signInWithCli')}</button>` : `<p class="hint">${h('auth.noGh')}</p>`}</div>`;
}

export function open() {
  renderDialog();
  dlg.showModal();
}

// Resolves true when signed in; otherwise opens the dialog and resolves false.
export async function requireSignIn() {
  if (auth?.signedIn) return true;
  try { await refresh(); } catch { /* offline */ }
  if (auth?.signedIn) return true;
  open();
  return false;
}

export function init() {
  dlg = document.getElementById('authDialog');
  document.getElementById('accountBtn').addEventListener('click', open);
  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-auth]');
    if (!b) return;
    e.preventDefault();
    try {
      const op = b.dataset.auth;
      if (op === 'login' || op === 'refresh') auth.flow = await api('/api/auth/login', { method: 'POST', body: { mode: op } });
      if (op === 'cancel') auth.flow = await api('/api/auth/cancel', { method: 'POST' });
      if (op === 'logout') auth = await api('/api/auth/logout', { method: 'POST' });
      if (op === 'copy') { await navigator.clipboard.writeText(auth.flow.code); notify(t('auth.codeCopied'), { kind: 'success', speak: false }); }
      renderAccount(); renderDialog();
    } catch (err) { notify(err.message, { kind: 'error' }); }
  });
  on('auth', async (flow) => {
    if (auth) auth.flow = flow;
    if (flow.state === 'done') { await refresh(); notify(t('auth.signedIn'), { kind: 'success' }); } else if (dlg.open) renderDialog();
  });
  registry.command({ id: 'auth.open', titleKey: 'auth.signIn', run: open });
}

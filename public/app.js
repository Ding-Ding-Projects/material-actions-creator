// Boots the app: settings, language, every feature module, the tab strip,
// the command palette, the live event stream and window-wide vocabulary drop.
import * as store from './js/core/store.js';
import * as vocab from './js/core/vocab.js';
import { STRINGS } from './js/core/strings.js';
import { t, translate } from './js/core/i18n.js';
import { notify } from './js/core/feedback.js';
import * as registry from './js/core/registry.js';
import { api, on, connect, setKey, onKeyRequired } from './js/core/api.js';
import * as tabs from './js/ui/tabs.js';
import * as palette from './js/ui/palette.js';
import * as menu from './js/ui/menu.js';
import * as auth from './js/ui/auth.js';
import * as onboarding from './js/ui/onboarding.js';
import { setGithubApp } from './js/ui/modes.js';
import { applyAppearance } from './js/ui/appearance-editor.js';
import { applyLogo } from './js/ui/logo.js';
import * as workflows from './js/views/workflows.js';
import * as dockerfile from './js/views/dockerfile.js';
import * as runs from './js/views/runs.js';
import * as settings from './js/views/settings.js';
import * as info from './js/views/info.js';

Object.assign(STRINGS, {
  'key.eyebrow': { en: 'Locked', yue: '鎖咗' },
  'key.title': { en: 'Access key', yue: '存取密碼' },
  'key.body': { en: 'This server is protected. Enter the access key set on the server.', yue: '呢部伺服器有保護，請輸入伺服器設定嘅存取密碼。' },
  'key.label': { en: 'Key', yue: '密碼' },
  'key.unlock': { en: 'Unlock', yue: '解鎖' },
  'drop.title': { en: 'Drop to apply your personal wording', yue: '放手就套用你嘅個人詞彙' },
  'drop.body': { en: 'The file stays in this browser.', yue: '檔案只會留喺呢個瀏覽器。' },
  'drop.notJson': { en: 'Only vocabulary JSON files can be dropped here.', yue: '呢度只可以放詞彙 JSON 檔。' },
  'conn.offline': { en: 'Offline — reconnecting', yue: '離線中，重新連接緊' },
  'conn.back': { en: 'Connected again.', yue: '重新連接咗。' },
  'skip': { en: 'Skip to content', yue: '跳去內容' },
  'tabs.badge.running': { en: '{n} running', yue: '{n} 個跑緊' },
});

const root = document.documentElement;

// ---------- Look and feel from settings ----------
function applyLook() {
  const theme = store.get('theme');
  const dark = theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : theme !== 'light';
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.motion = store.get('motion');
  root.dataset.density = store.get('density');
  root.dataset.adhd = store.get('adhd');
  root.dataset.school = String(Boolean(store.get('schoolMode')));
  root.style.setProperty('--accent', store.get('accent'));
  root.style.fontSize = `${store.get('textScale')}%`;
  root.lang = store.get('lang') === 'yue' ? 'zh-HK' : 'en';
  const name = store.get('displayName') || 'Material Actions Creator';
  document.title = name;
  for (const el of document.querySelectorAll('[data-display-name]')) el.textContent = name;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0b0c10' : '#f6f4ee';
}

function refreshAll() {
  applyLook();
  translate();
  tabs.render();
  applyAppearance();
  menu.applyLocks();
}

// ---------- Recovery banner ----------
function renderRecovery(r) {
  const box = document.getElementById('recovery');
  if (!r || !r.builds?.length) { box.hidden = true; return; }
  document.getElementById('recoveryTitle').textContent = t('recovery.title', { n: Math.max(1, Math.round(r.offlineMs / 60000)) });
  document.getElementById('recoveryBody').textContent = t('recovery.body', { n: r.builds.length });
  box.hidden = false;
}

// ---------- Window-wide vocabulary drop ----------
function initDrop() {
  const zone = document.getElementById('dropzone');
  let depth = 0;
  const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFile(e)) return; depth++; zone.hidden = false; });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.hidden = true; });
  addEventListener('dragover', (e) => { if (hasFile(e)) e.preventDefault(); });
  addEventListener('drop', async (e) => {
    if (!hasFile(e)) return;
    // Let file inputs and drop areas inside views (e.g. the tools tab) handle their own drops.
    if (e.target.closest?.('input[type=file], [data-own-drop]')) { depth = 0; zone.hidden = true; return; }
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') { notify(t('drop.notJson'), { kind: 'warn' }); return; }
    await settings.loadVocabFile(file);
  });
}

// ---------- Dim sum surprise ----------
// Shown once per successful build when the setting is on. The public photo
// catalogue is not reachable from this build yet, so the panel says so plainly
// instead of showing a placeholder picture.
const dimSumSeen = new Set();
function dimSum(job) {
  if (job.status !== 'ready' || dimSumSeen.has(job.id) || !store.get('dimSum') || store.get('schoolMode')) return;
  dimSumSeen.add(job.id);
  if (Date.now() - (job.updatedAt || 0) > 60_000) return; // old builds replayed on connect
  const pop = document.createElement('aside');
  pop.className = 'dimsum';
  pop.dataset.ui = 'dim-sum';
  pop.setAttribute('role', 'status');
  pop.innerHTML = `<div class="dimsum-steam" aria-hidden="true"><i></i><i></i><i></i></div><p class="eyebrow">${t('dimsum.title')}</p><p>${t('dimsum.unavailable')}</p><button type="button" class="btn quiet">${t('dimsum.close')}</button>`;
  pop.querySelector('button').addEventListener('click', () => pop.remove());
  document.body.append(pop);
  setTimeout(() => pop.remove(), 9000);
}

// ---------- Connection state ----------
function initConnection() {
  const pill = document.querySelector('[data-conn]');
  let wasOffline = false;
  const show = (online) => {
    pill.hidden = online;
    pill.textContent = t('conn.offline');
    if (online && wasOffline) notify(t('conn.back'), { kind: 'success', speak: false, sound: false });
    wasOffline = !online;
  };
  on('connection', show);
  addEventListener('offline', () => show(false));
}

// ---------- Boot ----------
async function boot() {
  try {
    const cfg = await api('/api/config');
    workflows.setRunners(cfg.runners);
    dockerfile.setPlatforms(cfg.platforms);
    setGithubApp(cfg.githubApp);
    await auth.refresh();
    connect();
  } catch (err) {
    if (err.offline) document.querySelector('[data-conn]').hidden = false;
  }
}

function start() {
  vocab.init();
  applyLook();

  workflows.register();
  dockerfile.register();
  runs.register();
  info.register();
  settings.register();
  import('./js/views/tools.js').then((m) => { m.registerTools(); tabs.render(); }).catch(() => { /* tools not bundled */ });

  tabs.init(document.getElementById('tabstrip'), document.getElementById('views'));
  palette.init();
  menu.init();
  auth.init();
  onboarding.init();
  initDrop();
  initConnection();

  document.getElementById('paletteBtn').addEventListener('click', palette.open);
  document.getElementById('notifyBtn').addEventListener('click', () => registry.teleport({ tab: 'history', target: '.note-list' }));
  document.getElementById('recoveryView').addEventListener('click', () => registry.teleport({ tab: 'runs' }));
  document.getElementById('recoveryDismiss').addEventListener('click', async () => {
    document.getElementById('recovery').hidden = true;
    try { await api('/api/recovery/dismiss', { method: 'POST' }); } catch { /* best effort */ }
  });
  on('hello', ({ recovery }) => renderRecovery(recovery));
  on('recovery', renderRecovery);
  on('build', dimSum);

  onKeyRequired(() => { const d = document.getElementById('keyDialog'); if (!d.open) d.showModal(); });
  document.getElementById('keyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    setKey(document.getElementById('keyInput').value);
    document.getElementById('keyDialog').close();
    boot();
  });

  const count = document.querySelector('[data-note-count]');
  import('./js/core/feedback.js').then(({ notifications, onNotifications }) => {
    const draw = () => { const n = notifications().length; count.hidden = !n; count.textContent = n > 99 ? '99+' : String(n); };
    onNotifications(draw);
    draw();
  });

  store.onChange(refreshAll);
  vocab.onChange(refreshAll);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook);
  applyLogo();
  applyAppearance();
  menu.applyLocks();
  translate();
  info.provenance(document.querySelector('[data-provenance]'));
  settings.loadRemoteSettings?.().catch(() => {});
  boot();
}

start();

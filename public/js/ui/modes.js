// "Where it runs" cards shared by the Workflows and Dockerfile tabs.
import { h, t, esc } from '../core/i18n.js';
import { STRINGS } from '../core/strings.js';
import { api } from '../core/api.js';

Object.assign(STRINGS, {
  'mode.local.title': { en: 'This computer', yue: '呢部電腦' },
  'mode.local.body': { en: 'Runs here. No repository is created, no Actions minutes are used and nothing is uploaded.', yue: '喺呢度行。唔會開儲存庫、唔使 Actions 分鐘，亦唔會上載任何嘢。' },
  'local.title': { en: 'What this computer can run', yue: '呢部電腦行到啲乜' },
  'local.act': { en: 'Runner program', yue: '執行程式' },
  'local.act.ok': { en: 'act {version} is installed', yue: '已安裝 act {version}' },
  'local.act.auto': { en: 'act {version} is downloaded and hash-checked automatically on the first workflow run', yue: '第一次行工作流程嗰陣會自動下載 act {version} 兼核對雜湊' },
  'local.act.none': { en: 'no automatic download for this kind of computer; install "act" yourself', yue: '呢類電腦冇自動下載，請自行安裝「act」' },
  'local.act.get': { en: 'Get it now', yue: '即刻攞' },
  'local.act.getting': { en: 'Getting the runner…', yue: '攞緊執行程式…' },
  'local.act.got': { en: 'The runner program is installed.', yue: '執行程式已經裝好。' },
  'local.containers': { en: 'Containers', yue: '容器' },
  'local.containers.ok': { en: 'Docker {version}: each Linux job gets a clean container', yue: 'Docker {version}：每個 Linux 工作都有乾淨嘅容器' },
  'local.containers.host': { en: 'No Docker. Linux jobs run directly on this computer, as you, with the tools it has. Only run workflows you trust.', yue: '冇 Docker。Linux 工作會以你嘅身份直接喺呢部電腦行，用部機現有嘅工具。只好行你信得過嘅工作流程。' },
  'local.containers.none': { en: 'No Docker, so Linux jobs cannot run here. Docker needs an administrator to install, so the app cannot install it for you.', yue: '冇 Docker，所以呢度行唔到 Linux 工作。裝 Docker 要管理員權限，個 app 幫你裝唔到。' },
  'local.os.linux': { en: 'Linux jobs', yue: 'Linux 工作' },
  'local.os.windows': { en: 'Windows jobs', yue: 'Windows 工作' },
  'local.os.macos': { en: 'macOS jobs', yue: 'macOS 工作' },
  'local.yes': { en: 'yes', yue: '得' },
  'local.needsWindows': { en: 'only on a Windows computer; skipped here and listed by name', yue: '只可以喺 Windows 電腦行；呢度會跳過兼逐個列出' },
  'local.needsMac': { en: 'only on a Mac; skipped here and listed by name', yue: '只可以喺 Mac 行；呢度會跳過兼逐個列出' },
  'local.scripts': { en: 'Build scripts', yue: '建置腳本' },
  'local.scripts.body': { en: 'run with this computer\'s own shells: {shells}', yue: '用呢部電腦自己嘅 shell 行：{shells}' },
  'local.docker': { en: 'Docker images', yue: 'Docker 映像' },
  'local.docker.no': { en: 'need Docker', yue: '需要 Docker' },
});

let githubApp = false;
export function setGithubApp(v) { githubApp = Boolean(v); }

export function modeCards(current, { stacked = false } = {}) {
  return `<div class="modes three ${stacked ? 'stacked' : ''}" role="radiogroup">
    ${[['private', 'mode.private'], ['encrypted-public', 'mode.enc'], ['local', 'mode.local']].map(([id, k]) => `
      <button type="button" role="radio" class="mode ${id === 'encrypted-public' ? 'enc' : ''} ${id === 'local' ? 'local' : ''}" aria-checked="${id === current}" aria-pressed="${id === current}" data-mode="${id}" data-ui="mode-${id}">
        <span class="mode-title">${id === 'encrypted-public' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>' : ''}${id === 'local' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' : ''}${h(`${k}.title`)}</span>
        <span class="mode-body">${h(`${k}.body`)}</span>
        ${id === 'encrypted-public' ? `<span class="mode-key">${h(githubApp ? 'mode.enc.keyApp' : 'mode.enc.keySession')}</span>` : ''}
      </button>`).join('')}
  </div>`;
}

// Fills el with what this computer can run locally, and a one-click runner install.
export async function localPanel(el) {
  let caps;
  try { caps = await api('/api/local'); } catch (err) { el.innerHTML = `<p class="run-error">${esc(err.message)}</p>`; return null; }
  const row = (state, name, detail, extra = '') => `<li class="${state}"><i class="cap-mark">${state === 'ok' ? '✓' : state === 'warn' ? '!' : '–'}</i><div><strong>${name}</strong><p class="muted small">${detail}</p></div>${extra}</li>`;
  const shells = Object.entries(caps.shells).filter(([, v]) => v).map(([k]) => k).join(', ') || '—';
  el.innerHTML = `<p class="step">${h('local.title')}</p><ul class="cap-list">
    ${row('ok', h('local.scripts'), h('local.scripts.body', { shells }))}
    ${row(caps.act.installed ? 'ok' : caps.act.installable ? 'ok' : 'warn', h('local.act'), h(caps.act.installed ? 'local.act.ok' : caps.act.installable ? 'local.act.auto' : 'local.act.none', { version: caps.act.version }), !caps.act.installed && caps.act.installable ? `<button type="button" class="btn" data-local-install>${h('local.act.get')}</button>` : '')}
    ${row(caps.containers ? 'ok' : 'warn', h('local.containers'), caps.containers ? h('local.containers.ok', { version: caps.containers.version }) : h(caps.canRun.linux ? 'local.containers.host' : 'local.containers.none'))}
    ${row(caps.canRun.linux ? 'ok' : 'off', h('local.os.linux'), caps.canRun.linux ? h('local.yes') : h('local.containers.none'))}
    ${row(caps.canRun.windows ? 'ok' : 'off', h('local.os.windows'), caps.canRun.windows ? h('local.yes') : h('local.needsWindows'))}
    ${row(caps.canRun.macos ? 'ok' : 'off', h('local.os.macos'), caps.canRun.macos ? h('local.yes') : h('local.needsMac'))}
    ${row(caps.containers ? 'ok' : 'off', h('local.docker'), caps.containers ? h('local.yes') : h('local.docker.no'))}
  </ul>`;
  el.querySelector('[data-local-install]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = t('local.act.getting');
    const { notify } = await import('../core/feedback.js');
    try { await api('/api/local/install', { method: 'POST' }); notify(t('local.act.got'), { kind: 'success' }); } catch (err) { notify(err.message, { kind: 'error' }); }
    localPanel(el);
  });
  return caps;
}

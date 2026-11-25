// Extensions tab: searchable manager, permission consent, on-demand runs and
// last results. Extension text is untrusted: it is escaped or goes through the
// shared Markdown renderer, never inserted as HTML.
import * as registry from '../core/registry.js';
import { STRINGS } from '../core/strings.js';
import { t, h, v, esc } from '../core/i18n.js';
import { api, on, getKey } from '../core/api.js';
import { superConfirm } from '../ui/confirm.js';
import { notify, play } from '../core/feedback.js';
import { searchField } from '../ui/regex-builder.js';
import { render as md } from '../ui/markdown.js';

Object.assign(STRINGS, {
  'tab.extensions': { en: 'Extensions', yue: '擴充功能' },
  'ext.title': { en: 'Extensions', yue: '擴充功能' },
  'ext.lede': {
    en: ['Each extension is a folder with a manifest and a program that reads one JSON line and writes one back. It runs as a separate process with a time limit, an output limit and none of your sign-in values.', 'Each extension is a folder with a manifest and a program that reads one JSON line and writes one back. It runs as a separate process with a time limit, an output limit and none of your sign-in values.', 'Extensions are small helper programs. Each runs on its own, on a timer, on a size budget, and never sees your sign-in values.', 'Little helper programs. Each one runs in its own corner with a stopwatch, a size budget and zero access to your sign-in values.', 'Teach the app new tricks. Every extension runs in its own corner with a stopwatch, a size budget and zero peeking at your sign-in values.'],
    yue: ['每個擴充功能係一個資料夾，入面有 manifest 同一個程式：讀一行 JSON，寫返一行。佢會喺獨立程序行，有時間同輸出上限，而且攞唔到你嘅登入資料。', '每個擴充功能係一個資料夾，入面有 manifest 同一個程式：讀一行 JSON，寫返一行。佢會喺獨立程序行，有時間同輸出上限，而且攞唔到你嘅登入資料。', '擴充功能係細細個嘅幫手程式，各自獨立行，有計時、有容量上限，睇唔到你嘅登入資料。', '細細個幫手程式，各自喺自己個角落行，有計時器、有容量上限，掂唔到你嘅登入資料。', '教個 app 玩新招！每個擴充功能都喺自己個角落行，有計時器、有容量上限，仲偷睇唔到你嘅登入資料。'],
  },
  'ext.search': { en: 'Search extensions', yue: '搵擴充功能' },
  'ext.builtin': { en: 'Built in', yue: '內置' },
  'ext.user': { en: 'Added by you', yue: '你加嘅' },
  'ext.enable': { en: 'Turn {name} on or off', yue: '開或者閂 {name}' },
  'ext.needsConsent': { en: 'Waiting for permission', yue: '等緊你批准' },
  'ext.review': { en: 'Review permissions', yue: '睇吓權限' },
  'ext.noPerms': { en: 'No permissions', yue: '唔使權限' },
  'ext.run': { en: 'Run', yue: '執行' },
  'ext.running': { en: 'Running…', yue: '行緊…' },
  'ext.input': { en: 'Input', yue: '輸入' },
  'ext.lastRun': { en: 'Last run', yue: '上次執行' },
  'ext.never': { en: 'Has not run yet.', yue: '未行過。' },
  'ext.stats': { en: '{hook} · {ms} ms · {bytes} bytes', yue: '{hook} · {ms} 毫秒 · {bytes} 位元組' },
  'ext.failed': { en: '{name} stopped: {error}', yue: '{name} 停咗：{error}' },
  'ext.empty': { en: 'No extension matches. Try fewer words or switch off regex.', yue: '冇擴充功能符合，試吓少啲字或者閂咗 regex。' },
  'ext.none': { en: 'No extensions are installed.', yue: '未安裝任何擴充功能。' },
  'ext.folder': { en: 'Your extensions folder', yue: '你嘅擴充功能資料夾' },
  'ext.folderWhy': { en: 'Put an extension folder here, then rescan. New extensions start off and ask before they see anything.', yue: '將擴充功能資料夾放入呢度，再重新掃描。新加嘅預設閂咗，要你批准先睇到嘢。' },
  'ext.rescan': { en: 'Rescan', yue: '重新掃描' },
  'ext.rescanned': { en: 'Found {n} extensions.', yue: '搵到 {n} 個擴充功能。' },
  'ext.broken': { en: 'Not loaded', yue: '載入唔到' },
  'ext.limits': { en: 'Limits: {s} s, {kb} KB of output', yue: '上限：{s} 秒、{kb} KB 輸出' },
  'ext.notSandbox': { en: 'Permissions decide what the app hands to an extension. They are not an operating-system sandbox: only add extensions you trust.', yue: '權限決定個 app 交咩資料畀擴充功能，但唔係作業系統沙盒：只好加你信得過嘅擴充功能。' },
  'ext.consent.eyebrow': { en: 'Permission request', yue: '權限要求' },
  'ext.consent.title': { en: '“{name}” wants access', yue: '「{name}」想要權限' },
  'ext.consent.changed': { en: 'Version {version} asks for something you have not allowed yet. It stays off until you decide.', yue: '{version} 版要求一啲你未批准嘅嘢。你決定之前佢會一直閂住。' },
  'ext.consent.first': { en: 'Turning it on lets its program run on this computer. Version {version} asks for the following.', yue: '開咗即係畀佢個程式喺呢部電腦行。{version} 版要求以下嘢。' },
  'ext.consent.noPerms': { en: 'It only receives what you type into it.', yue: '佢只會收到你打入去嘅嘢。' },
  'ext.consent.new': { en: 'New', yue: '新' },
  'ext.consent.already': { en: 'Already allowed', yue: '已經批准' },
  'ext.consent.allow': { en: 'Allow and turn on', yue: '批准兼開啟' },
  'ext.consent.deny': { en: 'Keep it off', yue: '繼續閂住' },
  'ext.perm.build:read': { en: 'Build details', yue: '建置資料' },
  'ext.perm.build:read.why': { en: 'Title, mode, status, timing and stage names. Never the temporary repository or keys.', yue: '標題、模式、狀態、時間同階段名。唔包括臨時儲存庫同密鑰。' },
  'ext.perm.outputs:read': { en: 'Read output files', yue: '讀取輸出檔案' },
  'ext.perm.outputs:read.why': { en: 'Names, sizes and where the decrypted outputs are on this computer.', yue: '已解密輸出檔案嘅名、大細同喺部電腦嘅位置。' },
  'ext.perm.workflow:read': { en: 'Workflow text', yue: '工作流程內容' },
  'ext.perm.workflow:read.why': { en: 'The generated workflow YAML you are previewing.', yue: '你預覽緊嘅工作流程 YAML。' },
  'ext.perm.network': { en: 'Network access', yue: '網絡存取' },
  'ext.perm.network.why': { en: 'May reach the network. Only enforced when extensions run sandboxed; without a sandbox every extension can reach it.', yue: '可以上網。只有喺沙盒入面行先會強制執行；冇沙盒嘅話所有擴充功能都上到網。' },
  'ext.gallery': { en: 'Gallery', yue: '展覽館' },
  'ext.gallery.lede': { en: 'Samples that ship with the app. Added extensions start switched off.', yue: '個 app 附帶嘅範例。新加嘅擴充功能預設係閂咗。' },
  'ext.add': { en: 'Add', yue: '加入' },
  'ext.added': { en: 'Added', yue: '已加入' },
  'ext.addedNote': { en: '{name} was added. Switch it on when you are ready.', yue: '已加入 {name}，準備好就開啟佢。' },
  'ext.upload': { en: 'Choose an extension .zip', yue: '揀一個擴充功能 .zip' },
  'ext.drop': { en: 'Drop an extension .zip here, or choose a file. It is unpacked, checked and added switched off. 2 MB at most.', yue: '將擴充功能 .zip 拖嚟呢度，或者揀檔案。會解壓、檢查，再以閂咗嘅狀態加入。最大 2 MB。' },
  'ext.remove': { en: 'Remove', yue: '移除' },
  'ext.removed': { en: 'Extension removed.', yue: '已移除擴充功能。' },
  'confirm.extRemove': { en: 'Remove the extension “{name}” and its files from this computer?', yue: '由呢部電腦移除擴充功能「{name}」同佢嘅檔案？' },
  'ext.iso.title': { en: 'Isolation on this computer', yue: '呢部電腦嘅隔離狀態' },
  'ext.iso.bwrap': { en: 'Sandboxed (bubblewrap)', yue: '已用沙盒（bubblewrap）' },
  'ext.iso.bwrap.body': { en: 'Extensions see a read-only system, their own folder and the output files you allowed. No home folder, no app data, no sign-in files, and no network unless you allow it.', yue: '擴充功能只會見到唯讀系統、自己個資料夾同你批准嘅輸出檔案。冇主目錄、冇 app 資料、冇登入檔案，除非你批准否則冇網絡。' },
  'ext.iso.none': { en: 'Not sandboxed', yue: '未用沙盒' },
  'ext.iso.none.off': { en: 'Sandboxing is switched off by the MAC_EXTENSION_ISOLATION setting. Extensions run as ordinary programs.', yue: 'MAC_EXTENSION_ISOLATION 設定閂咗沙盒，擴充功能會當普通程式行。' },
  'ext.iso.none.not-linux': { en: 'The sandbox needs Linux with bubblewrap. Here extensions run as ordinary programs, so only add ones you trust.', yue: '沙盒需要 Linux 加 bubblewrap。喺呢度擴充功能會當普通程式行，只好加你信得過嘅。' },
  'ext.iso.none.not-installed': { en: 'bubblewrap is not installed, so extensions run as ordinary programs. Install the bubblewrap package to sandbox them.', yue: '未安裝 bubblewrap，擴充功能會當普通程式行。安裝 bubblewrap 套件就可以用沙盒。' },
  'ext.iso.none.not-permitted': { en: 'bubblewrap is installed but this system does not let it start (often inside containers). Extensions run as ordinary programs.', yue: '已安裝 bubblewrap，但系統唔畀佢啟動（喺容器入面好常見）。擴充功能會當普通程式行。' },
  'ext.sandboxed': { en: 'sandboxed', yue: '沙盒' },
  'ext.hook.build.finished': { en: 'When a build finishes', yue: '建置完成時' },
  'ext.hook.workflow.lint': { en: 'Workflow check', yue: '工作流程檢查' },
  'ext.hook.command': { en: 'On demand', yue: '手動執行' },
  'ext.lint': { en: 'Check with extensions', yue: '用擴充功能檢查' },
  'ext.lint.none': { en: 'Choose scripts first so there is a workflow to check.', yue: '揀咗腳本先，至有工作流程可以檢查。' },
  'ext.lint.noExt': { en: 'No workflow-check extension is turned on.', yue: '未開啟任何工作流程檢查擴充功能。' },
  'ext.line': { en: 'line {n}', yue: '第 {n} 行' },
});

const POST = (path, body) => api(path, { method: 'POST', body });
let data = { extensions: [], broken: [], userDir: '' };
let redraw = () => {};
const busy = new Set();

export async function refresh() {
  try { data = await api('/api/extensions'); } catch { /* offline or locked: keep what we have */ }
  registerCommands();
  redraw();
  return data;
}

function resultHtml(r) {
  if (!r) return '';
  const parts = [];
  if (r.title) parts.push(`<p class="ext-result-title">${esc(v(r.title))}</p>`);
  if (r.findings?.length) parts.push(`<ul class="ext-findings">${r.findings.map((f) => `<li class="${esc(f.level)}"><span class="ext-level">${esc(f.level)}</span>${f.line ? `<code>${esc(t('ext.line', { n: f.line }))}</code>` : ''}<span>${esc(v(f.message))}</span></li>`).join('')}</ul>`);
  if (r.items?.length) parts.push(`<dl class="ext-items">${r.items.map((i) => `<div><dt>${esc(i.label)}</dt><dd><code>${esc(i.value)}</code></dd></div>`).join('')}</dl>`);
  if (r.summary && !r.items?.length) parts.push(/^(#{1,6} |[-*] |\|)/m.test(r.summary) ? `<div class="prose ext-summary">${md(v(r.summary))}</div>` : `<pre class="ext-summary">${esc(v(r.summary))}</pre>`);
  return parts.join('');
}

function lastRunHtml(e) {
  const r = e.lastRun;
  if (!r) return `<p class="muted small">${h('ext.never')}</p>`;
  const hook = t(`ext.hook.${r.hook}`);
  return `<div class="ext-last ${r.ok ? 'ok' : 'bad'}"><p class="ext-stats"><span class="dot"></span>${esc(t('ext.stats', { hook, ms: r.ms, bytes: r.bytes ?? 0 }))} · <time>${esc(new Date(r.at).toLocaleString())}</time>${r.sandboxed ? ` · <span class="ext-chip">${h('ext.sandboxed')}</span>` : ''}</p>${r.ok ? resultHtml(r.result) : `<p class="run-error">${esc(v(r.error || ''))}</p>`}</div>`;
}

function card(e, i) {
  const perms = e.permissions.length ? e.permissions.map((p) => `<span class="ext-chip ${e.pendingPermissions.includes(p) ? 'pending' : ''}" title="${esc(t(`ext.perm.${p}.why`))}">${h(`ext.perm.${p}`)}</span>`).join('') : `<span class="ext-chip quiet">${h('ext.noPerms')}</span>`;
  const hooks = e.hooks.map((k) => `<span class="ext-chip hook">${h(`ext.hook.${k}`)}</span>`).join('');
  const canRun = e.enabled && e.hooks.includes('command');
  return `<li class="ext-card ${e.needsConsent ? 'needs-consent' : ''} ${e.enabled ? 'on' : ''}" style="--i:${i}" data-ext="${esc(e.id)}" data-search="${esc(e.name)}" data-ui="ext-${esc(e.id)}">
    <span class="ext-icon" aria-hidden="true">${esc(e.name.trim()[0]?.toUpperCase() || '?')}</span>
    <div class="ext-main">
      <p class="ext-name"><strong>${esc(v(e.name))}</strong> <code class="small">v${esc(e.version)}</code> <span class="ext-source">${h(e.source === 'builtin' ? 'ext.builtin' : 'ext.user')}</span></p>
      <p class="muted small">${esc(v(e.description))}</p>
      <div class="ext-chips">${hooks}${perms}</div>
      <p class="muted small">${esc(t('ext.limits', { s: e.limits.timeoutMs / 1000, kb: Math.round(e.limits.maxOutputBytes / 1024) }))}</p>
      ${e.needsConsent ? `<p class="hint">${h('ext.needsConsent')} <button type="button" class="btn" data-ext-review>${h('ext.review')}</button></p>` : ''}
      ${canRun ? `<form class="ext-run" data-ext-run>${e.command?.inputLabel ? `<label class="field grow"><span>${esc(v(e.command.inputLabel))}</span><textarea rows="2" name="input"></textarea></label>` : ''}<button type="submit" class="btn" ${busy.has(e.id) ? 'disabled' : ''}>${busy.has(e.id) ? h('ext.running') : esc(v(e.command?.title || t('ext.run')))}</button></form>` : ''}
      ${e.source === 'user' ? `<p><button type="button" class="text-btn danger" data-ext-remove>${h('ext.remove')}</button></p>` : ''}
      <details class="ext-details" ${e.lastRun ? 'open' : ''}><summary>${h('ext.lastRun')}</summary>${lastRunHtml(e)}</details>
    </div>
    <label class="switch" title="${esc(t('ext.enable', { name: e.name }))}"><input type="checkbox" role="switch" data-ext-toggle ${e.wantsEnabled && !e.needsConsent ? 'checked' : ''} aria-label="${esc(t('ext.enable', { name: e.name }))}"><span class="switch-track"></span></label>
  </li>`;
}

// Resolves true when the user allowed the listed permissions.
function consent(e) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet ext-consent';
    dlg.dataset.ui = 'ext-consent';
    dlg.setAttribute('aria-labelledby', 'ext-consent-title');
    const rows = e.permissions.map((p) => {
      const fresh = e.pendingPermissions.includes(p);
      return `<li class="${fresh ? 'fresh' : ''}"><span class="ext-flag">${fresh ? h('ext.consent.new') : '✓'}</span><div><strong>${h(`ext.perm.${p}`)}</strong><p class="muted small">${h(`ext.perm.${p}.why`)}${fresh ? '' : ` · ${h('ext.consent.already')}`}</p></div></li>`;
    }).join('') || `<li><span class="ext-flag">✓</span><div><strong>${h('ext.noPerms')}</strong><p class="muted small">${h('ext.consent.noPerms')}</p></div></li>`;
    dlg.innerHTML = `<div class="sheet-inner"><p class="eyebrow">${h('ext.consent.eyebrow')}</p>
      <h2 id="ext-consent-title">${h('ext.consent.title', { name: e.name })}</h2>
      <p class="muted">${h(e.grantedVersion ? 'ext.consent.changed' : 'ext.consent.first', { version: e.version })}</p>
      <ul class="ext-perm-list">${rows}</ul>
      <p class="muted small">${h('ext.notSandbox')}</p>
      <div class="ob-nav"><span class="spacer"></span><button type="button" class="btn" data-deny>${h('ext.consent.deny')}</button><button type="button" class="fab small" data-allow>${h('ext.consent.allow')}</button></div></div>`;
    const done = (ok) => { dlg.close(); dlg.remove(); before?.focus?.(); resolve(ok); };
    dlg.addEventListener('click', (ev) => { if (ev.target.closest('[data-allow]')) done(true); else if (ev.target.closest('[data-deny]')) done(false); });
    dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[data-deny]').focus();
  });
}

async function turnOn(e) {
  if (e.needsConsent) {
    if (!(await consent(e))) return false;
    await POST(`/api/extensions/${e.id}`, { grant: e.permissions, enabled: true });
  } else await POST(`/api/extensions/${e.id}`, { enabled: true });
  play('confirm');
  return true;
}

export async function runExtension(id, body) {
  busy.add(id); redraw();
  try { return await POST(`/api/extensions/${id}/run`, body); } finally { busy.delete(id); await refresh(); }
}

// Runs every enabled workflow-check extension on the given YAML.
export async function lintWorkflow(yaml) {
  if (!yaml) { notify(t('ext.lint.none'), { kind: 'warn' }); return []; }
  if (!data.extensions.length) await refresh();
  const linters = data.extensions.filter((e) => e.enabled && e.hooks.includes('workflow.lint'));
  if (!linters.length) { notify(t('ext.lint.noExt'), { kind: 'warn' }); return []; }
  const out = [];
  for (const e of linters) {
    try { out.push({ ext: e, run: await runExtension(e.id, { hook: 'workflow.lint', yaml }) }); } catch (err) { out.push({ ext: e, run: { ok: false, error: err.message } }); }
  }
  return out;
}

export function lintHtml(results) {
  return results.map(({ ext, run }) => `<section class="ext-lint"><p class="eyebrow">${esc(v(ext.name))}</p>${run.ok ? resultHtml(run.result) : `<p class="run-error">${esc(v(run.error || ''))}</p>`}</section>`).join('');
}

const registered = new Set();
function registerCommands() {
  for (const e of data.extensions) {
    if (!e.hooks.includes('command') || registered.has(e.id)) continue;
    registered.add(e.id);
    registry.command({ id: `ext.${e.id}`, title: `${t('ext.title')}: ${e.command?.title || e.name}`, tab: 'extensions', run: () => registry.teleport({ tab: 'extensions', target: `[data-ext="${e.id}"]` }) });
  }
}

function mount(el) {
  el.innerHTML = `<header class="info-head"><div><p class="eyebrow">${h('tab.extensions')}</p><h1>${h('ext.title')}</h1><p class="muted ext-lede">${h('ext.lede')}</p></div></header>
    <div class="info-filters"><div class="info-search"></div></div>
    <ul class="ext-list" aria-live="polite"></ul>
    <section class="ext-broken" hidden></section>
    <section class="ext-iso panel" aria-live="polite"></section>
    <section class="ext-gallery"><p class="eyebrow">${h('ext.gallery')}</p><p class="muted small">${h('ext.gallery.lede')}</p><div class="ext-gallery-grid"></div>
      <label class="ext-drop" data-own-drop><input type="file" accept=".zip,application/zip" hidden data-ext-zip><strong>${h('ext.upload')}</strong><span class="muted small">${h('ext.drop')}</span></label></section>
    <section class="ext-folder panel"><p class="step">${h('ext.folder')}</p><p><code data-ext-dir></code></p><p class="muted small">${h('ext.folderWhy')}</p><p class="muted small">${h('ext.notSandbox')}</p><button type="button" class="btn" data-ext-rescan>${h('ext.rescan')}</button></section>`;
  let matcher = () => true;
  const list = el.querySelector('.ext-list');
  redraw = () => {
    const hits = data.extensions.filter((e) => matcher(`${e.id} ${e.name} ${e.description} ${e.hooks.join(' ')} ${e.permissions.join(' ')}`));
    list.innerHTML = hits.length ? hits.map(card).join('') : `<li class="empty">${h(data.extensions.length ? 'ext.empty' : 'ext.none')}</li>`;
    const broken = el.querySelector('.ext-broken');
    broken.hidden = !data.broken?.length;
    broken.innerHTML = data.broken?.length ? `<p class="eyebrow">${h('ext.broken')}</p><ul>${data.broken.map((b) => `<li><code>${esc(b.folder)}</code> — ${esc(b.error)}</li>`).join('')}</ul>` : '';
    el.querySelector('[data-ext-dir]').textContent = data.userDir || '';
    const iso = data.isolation || { mode: 'none', reason: 'not-installed' };
    const isoEl = el.querySelector('.ext-iso');
    isoEl.className = `ext-iso panel ${iso.mode}`;
    isoEl.innerHTML = `<p class="step">${h('ext.iso.title')}</p><p class="ext-iso-title">${h(iso.mode === 'bwrap' ? 'ext.iso.bwrap' : 'ext.iso.none')}</p><p class="muted">${h(iso.mode === 'bwrap' ? 'ext.iso.bwrap.body' : `ext.iso.none.${iso.reason}`)}</p>`;
    el.querySelector('.ext-gallery-grid').innerHTML = (data.gallery || []).map((g, i) => `<article class="ext-sample" style="--i:${i}" data-sample="${esc(g.id)}"><div class="ext-sample-head"><span class="ext-icon" aria-hidden="true">${esc(g.name[0].toUpperCase())}</span><div><strong>${esc(v(g.name))}</strong><p class="muted small">${esc(g.program)} · v${esc(g.version)}</p></div></div><p class="muted small">${esc(v(g.description))}</p><button type="button" class="${g.installed ? 'btn' : 'fab small'}" data-ext-add ${g.installed ? 'disabled' : ''}>${h(g.installed ? 'ext.added' : 'ext.add')}</button></article>`).join('');
  };
  async function uploadZip(file) {
    if (!file) return;
    try {
      const res = await fetch('/api/extensions/upload', { method: 'POST', headers: { 'Content-Type': 'application/zip', ...(getKey() ? { 'x-access-key': getKey() } : {}) }, body: file });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      notify(t('ext.addedNote', { name: out.name }), { kind: 'success' });
      await refresh();
      registry.teleport({ tab: 'extensions', target: `[data-ext="${out.id}"]` });
    } catch (err) { notify(err.message, { kind: 'error' }); }
  }
  const drop = el.querySelector('.ext-drop');
  drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (ev) => { ev.preventDefault(); ev.stopPropagation(); drop.classList.remove('over'); uploadZip(ev.dataTransfer.files[0]); });
  el.querySelector('[data-ext-zip]').addEventListener('change', (ev) => { uploadZip(ev.target.files[0]); ev.target.value = ''; });
  el.querySelector('.info-search').append(searchField({ placeholderKey: 'ext.search', ui: 'ext-search', onChange: (m) => { matcher = m; redraw(); } }));
  const find = (node) => data.extensions.find((e) => e.id === node.closest('[data-ext]')?.dataset.ext);
  el.addEventListener('change', async (ev) => {
    if (!ev.target.matches('[data-ext-toggle]')) return;
    const e = find(ev.target);
    try {
      if (ev.target.checked) await turnOn(e); else await POST(`/api/extensions/${e.id}`, { enabled: false });
    } catch (err) { notify(err.message, { kind: 'error' }); }
    refresh();
  });
  el.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-ext-review]')) { try { await turnOn(find(ev.target)); } catch (err) { notify(err.message, { kind: 'error' }); } refresh(); return; }
    const add = ev.target.closest('[data-ext-add]');
    if (add) {
      try { const out = await POST('/api/extensions/install', { sample: add.closest('[data-sample]').dataset.sample }); notify(t('ext.addedNote', { name: out.name }), { kind: 'success' }); play('confirm'); } catch (err) { notify(err.message, { kind: 'error' }); }
      refresh(); return;
    }
    if (ev.target.closest('[data-ext-remove]')) {
      const e = find(ev.target);
      if (!(await superConfirm({ messageKey: 'confirm.extRemove', vars: { name: e.name } }))) return;
      try { data = await api(`/api/extensions/${e.id}`, { method: 'DELETE' }); notify(t('ext.removed'), { kind: 'success' }); } catch (err) { notify(err.message, { kind: 'error' }); }
      redraw(); return;
    }
    if (ev.target.closest('[data-ext-rescan]')) {
      try { data = await POST('/api/extensions/rescan'); notify(t('ext.rescanned', { n: data.extensions.length }), { kind: 'success' }); } catch (err) { notify(err.message, { kind: 'error' }); }
      registerCommands(); redraw();
    }
  });
  el.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-ext-run]');
    if (!form) return;
    ev.preventDefault();
    const e = find(form);
    try { await runExtension(e.id, { hook: 'command', input: form.elements.input?.value || '' }); } catch (err) { notify(err.message, { kind: 'error' }); }
  });
  refresh();
}

export function register() {
  registry.destination({ id: 'extensions', titleKey: 'tab.extensions', icon: '⧉', order: 52, mount });
  registry.command({ id: 'extensions.rescan', titleKey: 'ext.rescan', tab: 'extensions', run: async () => { await POST('/api/extensions/rescan'); await registry.teleport({ tab: 'extensions' }); refresh(); } });
  on('extension', (r) => {
    if (r.hook !== 'build.finished') { refresh(); return; } // on-demand runs show their result in place
    if (r.ok) notify(`${r.name}: ${r.result?.title || t(`ext.hook.${r.hook}`)}`, { kind: 'success', speak: false });
    else notify(t('ext.failed', { name: r.name, error: r.error || '' }), { kind: 'error' });
    refresh();
  });
  on('extensions', () => refresh());
  on('hello', () => refresh());
}

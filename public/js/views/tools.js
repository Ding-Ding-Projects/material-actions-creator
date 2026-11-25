// Tools tab: Base64 toolkit, local file converter and JSON studio.
// Each tool loads on first use and runs entirely in the browser.
import * as registry from '../core/registry.js';
import * as store from '../core/store.js';
import { t, h, translate } from '../core/i18n.js';
import '../tools/strings.js';

const TOOLS = [
  { id: 'base64', titleKey: 'tools.base64.title', commandKey: 'tools.cmd.base64', keywords: ['base64', 'encode', 'decode', 'data uri', 'hex', 'binary'], load: async () => (await import('../tools/base64-ui.js')).mountBase64 },
  { id: 'convert', titleKey: 'tools.convert.title', commandKey: 'tools.cmd.convert', keywords: ['convert', 'json', 'yaml', 'csv', 'tsv', 'ndjson', 'markdown', 'html', 'xml', 'image', 'png', 'jpeg', 'webp', 'bmp', 'encoding', 'utf-8', 'latin-1', 'batch'], load: async () => (await import('../tools/convert-ui.js')).mountConvert },
  { id: 'jsonstudio', titleKey: 'tools.jsonstudio.title', commandKey: 'tools.cmd.jsonstudio', keywords: ['json', 'editor', 'tree', 'types', 'typescript', 'schema', 'go', 'python', 'c#', 'rust', 'kotlin', 'quicktype'], load: async () => (await import('../tools/jsonstudio-ui.js')).mountJsonStudio },
];

const ACTIVE_KEY = 'mac.tools.active.v1';
let view = null; // { select(id, focus) } once mounted
let pending = null;

function remembered() {
  try { const id = localStorage.getItem(ACTIVE_KEY); return TOOLS.some((x) => x.id === id) ? id : null; } catch { return null; }
}
function remember(id) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* storage blocked */ }
}

function ensureStyles() {
  if (document.querySelector('link[data-tools-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/tools.css';
  link.dataset.toolsCss = '';
  document.head.append(link);
}

// Opens the Tools tab on a given tool and moves focus to its sub-tab.
export async function openTool(id) {
  pending = id;
  await registry.teleport({ tab: 'tools' });
  if (view) view.select(id, true);
}

export function registerTools() {
  registry.destination({ id: 'tools', titleKey: 'tab.tools', icon: '🧰', order: 50, mount });
  for (const tool of TOOLS) {
    registry.command({ id: `tools.open.${tool.id}`, titleKey: tool.commandKey, keywords: tool.keywords, tab: 'tools', run: () => openTool(tool.id) });
  }
}

function mount(el) {
  ensureStyles();
  el.classList.add('tools-view');
  el.innerHTML = `
    <header class="tl-head">
      <h2 data-i18n="tab.tools">${h('tab.tools')}</h2>
      <p class="muted" data-i18n="tools.intro">${h('tools.intro')}</p>
    </header>
    <div class="tl-subnav" role="tablist" aria-label="${t('tools.subnav')}" data-i18n-aria="tools.subnav">
      ${TOOLS.map((tool) => `<button type="button" role="tab" id="tools-tab-${tool.id}" aria-controls="tools-panel-${tool.id}" aria-selected="false" tabindex="-1" data-tool="${tool.id}"><span data-i18n="${tool.titleKey}">${h(tool.titleKey)}</span></button>`).join('')}
    </div>
    ${TOOLS.map((tool) => `<div class="tl-panel" role="tabpanel" id="tools-panel-${tool.id}" aria-labelledby="tools-tab-${tool.id}" tabindex="0" hidden data-panel="${tool.id}"></div>`).join('')}`;

  const tabs = [...el.querySelectorAll('[role="tab"]')];
  const mounted = new Set();

  async function select(id, focus = false) {
    const tool = TOOLS.find((x) => x.id === id) || TOOLS[0];
    for (const tab of tabs) {
      const on = tab.dataset.tool === tool.id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const panel of el.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.dataset.panel !== tool.id;
    remember(tool.id);
    if (!mounted.has(tool.id)) {
      mounted.add(tool.id);
      const panel = el.querySelector(`[data-panel="${tool.id}"]`);
      panel.innerHTML = `<p class="muted" role="status">${h('tools.loading')}</p>`;
      try {
        const mountTool = await tool.load();
        panel.innerHTML = '';
        mountTool(panel);
        translate(panel);
      } catch (e) {
        mounted.delete(tool.id);
        panel.innerHTML = `<p class="tl-status error" role="alert">${h('tools.loadFailed')}</p>`;
        console.error(e);
      }
    }
  }

  el.querySelector('.tl-subnav').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) select(tab.dataset.tool);
  });
  // Arrow keys, Home and End move between sub-tabs (automatic activation).
  el.querySelector('.tl-subnav').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next].dataset.tool, true);
  });

  // Refresh the header and sub-tab labels when the language or funny level changes.
  store.onChange((key) => { if (['lang', 'funnyEn', 'funnyYue', 'schoolMode', '*'].includes(key)) translate(el); });

  view = { select };
  select(pending || remembered() || TOOLS[0].id, Boolean(pending));
  pending = null;
}

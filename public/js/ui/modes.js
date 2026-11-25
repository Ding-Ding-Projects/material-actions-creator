// "Where it runs" cards shared by the Workflows and Dockerfile tabs.
import { h } from '../core/i18n.js';

let githubApp = false;
export function setGithubApp(v) { githubApp = Boolean(v); }

export function modeCards(current, { stacked = false } = {}) {
  return `<div class="modes ${stacked ? 'stacked' : ''}" role="radiogroup">
    ${[['private', 'mode.private'], ['encrypted-public', 'mode.enc']].map(([id, k]) => `
      <button type="button" role="radio" class="mode ${id === 'encrypted-public' ? 'enc' : ''}" aria-checked="${id === current}" aria-pressed="${id === current}" data-mode="${id}" data-ui="mode-${id}">
        <span class="mode-title">${id === 'encrypted-public' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>' : ''}${h(`${k}.title`)}</span>
        <span class="mode-body">${h(`${k}.body`)}</span>
        ${id === 'encrypted-public' ? `<span class="mode-key">${h(githubApp ? 'mode.enc.keyApp' : 'mode.enc.keySession')}</span>` : ''}
      </button>`).join('')}
  </div>`;
}

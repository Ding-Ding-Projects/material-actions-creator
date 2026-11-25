// Folder picker for "a folder on this computer". Browsers do not reveal full
// paths from their own file dialog, so this one asks the app's server, which
// runs on the computer whose folders are being listed.
import { STRINGS } from '../core/strings.js';
import { t, h, esc } from '../core/i18n.js';
import { api } from '../core/api.js';
import { searchField } from './regex-builder.js';

Object.assign(STRINGS, {
  'fp.browse': { en: 'Browse…', yue: '瀏覽…' },
  'fp.title': { en: 'Choose a folder', yue: '揀一個資料夾' },
  'fp.filter': { en: 'Filter folders', yue: '篩選資料夾' },
  'fp.up': { en: 'Up one level', yue: '上一層' },
  'fp.home': { en: 'Home', yue: '主目錄' },
  'fp.hidden': { en: 'Show hidden folders', yue: '顯示隱藏資料夾' },
  'fp.choose': { en: 'Choose this folder', yue: '揀呢個資料夾' },
  'fp.empty': { en: 'No folders inside this one.', yue: '入面冇資料夾。' },
  'fp.noMatch': { en: 'No folder matches the filter.', yue: '冇資料夾符合篩選。' },
  'fp.truncated': { en: 'Only the first 500 folders are shown. Use the filter or type the path.', yue: '只顯示頭 500 個資料夾。可以用篩選或者直接打路徑。' },
  'fp.tag.workflows': { en: '{n} workflows', yue: '{n} 個工作流程' },
  'fp.tag.scripts': { en: '{n} scripts', yue: '{n} 個腳本' },
  'fp.path': { en: 'Folder path', yue: '資料夾路徑' },
  'fp.go': { en: 'Go', yue: '去' },
});

// Opens the picker at `start` (or the home folder). Resolves the chosen path, or null.
export function pickFolder(start = '') {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet folder-picker';
    dlg.dataset.ui = 'folder-picker';
    dlg.setAttribute('aria-labelledby', 'fp-title');
    dlg.innerHTML = `<div class="sheet-inner">
      <button type="button" class="close" data-fp-cancel aria-label="${esc(t('common.close'))}">×</button>
      <h2 id="fp-title">${h('fp.title')}</h2>
      <nav class="fp-crumbs" aria-label="${esc(t('fp.path'))}"></nav>
      <form class="fp-path" data-fp-form><label class="sr-only" for="fp-input">${h('fp.path')}</label><input id="fp-input" spellcheck="false" autocomplete="off"><button type="submit" class="btn">${h('fp.go')}</button></form>
      <div class="fp-tools"><button type="button" class="btn quiet" data-fp-up>↑ ${h('fp.up')}</button><button type="button" class="btn quiet" data-fp-home>⌂ ${h('fp.home')}</button><label class="ws-check"><input type="checkbox" data-fp-hidden> ${h('fp.hidden')}</label></div>
      <div class="fp-search"></div>
      <p class="fp-msg muted small" aria-live="polite"></p>
      <ul class="fp-list" role="listbox" aria-label="${esc(t('fp.title'))}"></ul>
      <div class="ob-nav"><code class="fp-current"></code><span class="spacer"></span><button type="button" class="fab small" data-fp-choose>${h('fp.choose')}</button></div></div>`;
    let state = null;
    let matcher = () => true;
    let hidden = false;
    const list = dlg.querySelector('.fp-list');
    const msg = dlg.querySelector('.fp-msg');
    const done = (value) => { dlg.close(); dlg.remove(); before?.focus?.(); resolve(value); };
    const draw = () => {
      if (!state) return;
      const sepr = state.separator;
      const parts = state.path.split(sepr).filter(Boolean);
      const rooted = state.path.startsWith(sepr);
      dlg.querySelector('.fp-crumbs').innerHTML = `${rooted ? `<button type="button" data-fp-go="${esc(sepr)}">${esc(sepr)}</button>` : ''}${parts.map((name, i) => {
        const to = (rooted ? sepr : '') + parts.slice(0, i + 1).join(sepr) + (!rooted && i === 0 ? sepr : '');
        return `<button type="button" data-fp-go="${esc(to)}" ${i === parts.length - 1 ? 'aria-current="true"' : ''}>${esc(name)}</button>`;
      }).join(`<span aria-hidden="true">›</span>`)}`;
      dlg.querySelector('#fp-input').value = state.path;
      dlg.querySelector('.fp-current').textContent = state.path;
      dlg.querySelector('[data-fp-up]').disabled = !state.parent;
      const hits = state.folders.filter((f) => matcher(f.name));
      list.innerHTML = hits.map((f, i) => {
        const tags = [f.workflows ? t('fp.tag.workflows', { n: f.workflows }) : '', f.scripts ? t('fp.tag.scripts', { n: f.scripts }) : '', f.dockerfile ? 'Dockerfile' : ''].filter(Boolean);
        return `<li role="option" style="--i:${i}"><button type="button" data-fp-go="${esc(f.path)}"><span class="fp-icon" aria-hidden="true">📁</span><span class="fp-name">${esc(f.name)}</span>${tags.length ? `<span class="fp-tag">${esc(tags.join(' · '))}</span>` : ''}<span aria-hidden="true">›</span></button></li>`;
      }).join('');
      msg.textContent = !state.folders.length ? t('fp.empty') : !hits.length ? t('fp.noMatch') : state.truncated ? t('fp.truncated') : '';
      msg.classList.remove('run-error');
    };
    const go = async (path) => {
      try {
        const q = new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: '1' } : {}) });
        state = await api(`/api/local/browse?${q}`);
        draw();
        list.scrollTop = 0;
      } catch (err) {
        if (!state) { await go(''); }
        msg.textContent = err.message;
        msg.classList.add('run-error');
      }
    };
    dlg.querySelector('.fp-search').append(searchField({ placeholderKey: 'fp.filter', ui: 'fp-filter', onChange: (m) => { matcher = m; draw(); } }));
    dlg.addEventListener('click', (e) => {
      const to = e.target.closest('[data-fp-go]');
      if (to) { go(to.dataset.fpGo); return; }
      if (e.target.closest('[data-fp-up]') && state?.parent) { go(state.parent); return; }
      if (e.target.closest('[data-fp-home]')) { go(state?.home || ''); return; }
      if (e.target.closest('[data-fp-choose]') && state) { done(state.path); return; }
      if (e.target.closest('[data-fp-cancel]')) done(null);
    });
    dlg.addEventListener('change', (e) => { if (e.target.matches('[data-fp-hidden]')) { hidden = e.target.checked; go(state?.path || ''); } });
    dlg.addEventListener('submit', (e) => { if (e.target.matches('[data-fp-form]')) { e.preventDefault(); go(dlg.querySelector('#fp-input').value.trim()); } });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && e.altKey && state?.parent) { e.preventDefault(); go(state.parent); }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('.fp-list')) {
        e.preventDefault();
        const items = [...list.querySelectorAll('button')];
        items[Math.max(0, Math.min(items.length - 1, items.indexOf(e.target.closest('button')) + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
    go(start);
  });
}

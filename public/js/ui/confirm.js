// Two-key super confirmation for destructive actions: the slider must reach the
// end AND Shift+Enter must be pressed. Escape or Cancel aborts; focus returns.
import { t, h, esc } from '../core/i18n.js';
import { play } from '../core/feedback.js';
import * as store from '../core/store.js';

export function superConfirm({ messageKey, vars } = {}) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet super-confirm';
    dlg.setAttribute('aria-labelledby', 'sc-title');
    dlg.innerHTML = `
      <div class="sheet-inner">
        <p class="eyebrow">${store.get('dialogEmoji') ? '⚠️ ' : ''}${h('confirm.title')}</p>
        <h2 id="sc-title">${esc(t(messageKey, vars))}</h2>
        <label class="sc-slide"><span>${h('confirm.slide')}</span>
          <input type="range" min="0" max="100" value="0" aria-valuetext="0%"></label>
        <p class="muted sc-keys">${h('confirm.keys')}</p>
        <div class="stack"><button type="button" class="btn sc-cancel">${h('confirm.cancel')}</button></div>
      </div>`;
    document.body.append(dlg);
    const range = dlg.querySelector('input');
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      play(ok ? 'confirm' : 'tick');
      before?.focus?.();
      resolve(ok);
    };
    range.addEventListener('input', () => {
      range.setAttribute('aria-valuetext', `${range.value}%`);
      dlg.classList.toggle('armed', Number(range.value) >= 100);
    });
    range.addEventListener('change', () => { if (Number(range.value) < 100) { range.value = 0; dlg.classList.remove('armed'); } });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter' && e.shiftKey && Number(range.value) >= 100) { e.preventDefault(); finish(true); }
    });
    dlg.querySelector('.sc-cancel').addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    dlg.showModal();
    range.focus();
  });
}

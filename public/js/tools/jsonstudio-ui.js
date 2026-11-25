// JSON studio screen: GUI tree editor kept in sync with raw text, plus the type generator.
import { t, h, esc } from '../core/i18n.js';
import { notify } from '../core/feedback.js';
import {
  parseJson, parseMany, toValue, fromValue, stringify, getAt, setAt, setValue, addChild, renameKey, removeAt, moveChild, changeType, createHistory,
  uniqueKey, NODE_TYPES, LANGUAGES, generateTypes, EditError,
} from './jsonstudio.js';
import { L, uid, debounce, onLanguage, copyText, downloadText, dropZone, dropZoneHtml, fail, selectInTextarea, offsetOf, formatNumber } from './ui-common.js';

const SAMPLE = {
  id: 1,
  name: 'Har gow',
  price: 38.5,
  vegetarian: false,
  tags: ['steamed', 'shrimp'],
  kitchen: { station: 'steam', minutes: 8 },
  notes: null,
};

const LARGE = 2000; // nodes; beyond this, deep levels start collapsed

export function mountJsonStudio(root) {
  const id = uid('js');
  root.innerHTML = `
  <section class="tl-section" aria-labelledby="${id}-eh">
    <h3 id="${id}-eh" class="tl-h">${L('tools.js.editorHeading')}</h3>
    <div class="tl-toolbar" role="toolbar" aria-label="${esc(t('tools.js.toolbar'))}" data-i18n-aria="tools.js.toolbar">
      <button type="button" class="btn small" data-act="undo" aria-keyshortcuts="Control+Z">${L('tools.js.undo')}</button>
      <button type="button" class="btn small" data-act="redo" aria-keyshortcuts="Control+Y">${L('tools.js.redo')}</button>
      <button type="button" class="btn small" data-act="expand">${L('tools.js.expandAll')}</button>
      <button type="button" class="btn small" data-act="collapse">${L('tools.js.collapseAll')}</button>
      <button type="button" class="btn small" data-act="format">${L('tools.js.format')}</button>
      <button type="button" class="btn small" data-act="minify">${L('tools.js.minify')}</button>
      <button type="button" class="btn small" data-act="copy">${L('tools.copy')}</button>
      <button type="button" class="btn small" data-act="download">${L('tools.download')}</button>
    </div>
    ${dropZoneHtml({ id: `${id}-file`, labelKey: 'tools.chooseFile', hintKey: 'tools.dropHint', accept: '.json,application/json' })}
    <div class="tl-split tl-studio">
      <div class="tl-pane">
        <label class="tl-label" for="${id}-raw">${L('tools.js.raw')}</label>
        <textarea id="${id}-raw" class="tl-area tl-mono tl-tall" spellcheck="false" data-raw aria-describedby="${id}-status"></textarea>
        <div class="tl-status" id="${id}-status" role="status" aria-live="polite" data-status></div>
      </div>
      <div class="tl-pane">
        <h4 class="tl-label" id="${id}-treelabel">${L('tools.js.tree')}</h4>
        <div class="tl-tree" data-tree aria-labelledby="${id}-treelabel"></div>
      </div>
    </div>
  </section>

  <section class="tl-section" aria-labelledby="${id}-gh">
    <h3 id="${id}-gh" class="tl-h">${L('tools.js.genHeading')}</h3>
    <p class="tl-honest">${L('tools.js.honest')}</p>
    <div class="tl-options">
      <label class="tl-field"><span>${L('tools.js.language')}</span><select data-lang>${LANGUAGES.map((l) => `<option value="${l.id}" data-i18n="tools.js.lang.${l.id}">${h(`tools.js.lang.${l.id}`)}</option>`).join('')}</select></label>
      <label class="tl-field"><span>${L('tools.js.rootName')}</span><input type="text" value="Root" data-root-name spellcheck="false"></label>
      <label class="tl-check"><input type="checkbox" checked data-use-editor> ${L('tools.js.useEditor')}</label>
      <label class="tl-check"><input type="checkbox" data-split-array> ${L('tools.js.splitArray')}</label>
    </div>
    <label class="tl-label" for="${id}-samples">${L('tools.js.samples')}</label>
    <textarea id="${id}-samples" class="tl-area tl-mono tl-short" spellcheck="false" data-samples placeholder='{"id": 2, "name": "Siu mai"}'></textarea>
    <div class="tl-actions">
      <button type="button" class="btn primary small" data-act="generate">${L('tools.js.generate')}</button>
      <button type="button" class="btn small" data-act="copy-code">${L('tools.copy')}</button>
      <button type="button" class="btn small" data-act="download-code">${L('tools.download')}</button>
    </div>
    <p class="tl-stats muted" data-gen-status role="status" aria-live="polite"></p>
    <pre class="tl-code" tabindex="0" data-code aria-label="${esc(t('tools.js.generated'))}" data-i18n-aria="tools.js.generated"></pre>
  </section>`;

  const $ = (sel) => root.querySelector(sel);
  const raw = $('[data-raw]');
  const treeEl = $('[data-tree]');
  const status = $('[data-status]');
  const history = createHistory(fromValue(SAMPLE));
  const collapsed = new Set();
  let stale = false; // raw text is invalid; tree shows the last valid state
  let lastError = null;
  let indent = 2;

  const key = (path) => JSON.stringify(path);
  const collapseDeep = (tree) => walk(tree, [], (node, path) => { if (path.length >= 2 && (node.type === 'object' || node.type === 'array')) collapsed.add(key(path)); });

  // ----- raw text <-> tree -----
  const writeRaw = () => { raw.value = stringify(history.state, indent); };

  const setStatus = () => {
    if (lastError) {
      status.className = 'tl-status error';
      status.innerHTML = `<strong>${h('tools.js.invalid')}</strong> ${esc(t('tools.at', { line: lastError.line, column: lastError.column }))}: <span>${esc(lastError.message)}</span>
        <button type="button" class="btn small" data-act="goto">${L('tools.showProblem')}</button>
        <span class="muted">${h('tools.js.staleTree')}</span>`;
    } else {
      status.className = 'tl-status ok';
      status.innerHTML = h('tools.js.valid', { nodes: formatNumber(countNodes(history.state)) });
    }
    $('[data-act="undo"]').disabled = !history.canUndo;
    $('[data-act="redo"]').disabled = !history.canRedo;
  };

  const fromRaw = debounce(() => {
    const r = parseJson(raw.value);
    if (!r.ok) { lastError = r.error; stale = true; setStatus(); treeEl.classList.add('is-stale'); return; }
    lastError = null;
    stale = false;
    treeEl.classList.remove('is-stale');
    for (const w of r.warnings) notify(t('tools.js.duplicateKey', { key: w.key, line: w.line }), { kind: 'warn', speak: false });
    history.push(r.tree);
    if (!collapsed.size && countNodes(r.tree) > LARGE) collapseDeep(r.tree);
    renderTree();
    setStatus();
    generateLive();
  }, 250);
  raw.addEventListener('input', fromRaw);

  // Applies a tree edit: history, raw text and tree all update together.
  const apply = (fn, focusPath, focusRole) => {
    let next;
    try { next = fn(history.state); } catch (e) {
      if (e instanceof EditError) { fail(t(`tools.js.err.${e.code}`), e.message); return false; }
      throw e;
    }
    history.push(next);
    lastError = null;
    stale = false;
    treeEl.classList.remove('is-stale');
    writeRaw();
    renderTree(focusPath, focusRole);
    setStatus();
    generateLive();
    return true;
  };

  // ----- tree rendering -----
  const typeSelect = (node, path) => `<select class="tl-type" data-role="type" data-path='${esc(key(path))}' aria-label="${esc(t('tools.js.typeOf', { name: label(path) }))}">
    ${NODE_TYPES.map((ty) => `<option value="${ty}" ${ty === node.type ? 'selected' : ''}>${h(`tools.js.type.${ty}`)}</option>`).join('')}</select>`;

  const label = (path) => (path.length ? String(path[path.length - 1]) : t('tools.js.rootLabel'));

  const valueEditor = (node, path) => {
    const p = esc(key(path));
    const name = esc(t('tools.js.valueOf', { name: label(path) }));
    if (node.type === 'string') return `<input type="text" class="tl-value" data-role="value" data-path='${p}' value="${esc(node.value)}" aria-label="${name}" spellcheck="false">`;
    if (node.type === 'number') return `<input type="text" inputmode="decimal" class="tl-value tl-num" data-role="value" data-path='${p}' value="${esc(String(node.value))}" aria-label="${name}">`;
    if (node.type === 'boolean') return `<select class="tl-value" data-role="value" data-path='${p}' aria-label="${name}"><option value="true" ${node.value ? 'selected' : ''}>true</option><option value="false" ${node.value ? '' : 'selected'}>false</option></select>`;
    if (node.type === 'null') return '<span class="tl-null">null</span>';
    const count = node.type === 'object' ? node.entries.length : node.items.length;
    return `<span class="tl-count muted">${h(node.type === 'object' ? 'tools.js.keys' : 'tools.js.items', { count: formatNumber(count) })}</span>`;
  };

  const row = (node, path, parent, index, siblings) => {
    const p = esc(key(path));
    const container = node.type === 'object' || node.type === 'array';
    const open = container && !collapsed.has(key(path));
    const nm = esc(label(path));
    const childrenId = `${id}-c-${hash(key(path))}`;
    let keyPart = '';
    if (parent?.type === 'object') keyPart = `<input type="text" class="tl-key" data-role="key" data-path='${p}' value="${nm}" aria-label="${esc(t('tools.js.keyOf', { name: label(path) }))}" spellcheck="false"><span class="tl-colon" aria-hidden="true">:</span>`;
    else if (parent?.type === 'array') keyPart = `<span class="tl-index muted">[${index}]</span>`;
    else keyPart = `<span class="tl-index muted">${h('tools.js.rootLabel')}</span>`;
    const actions = [];
    if (container) actions.push(`<button type="button" class="tl-icon" data-role="add" data-path='${p}' aria-label="${esc(t('tools.js.addTo', { name: label(path) }))}" title="${esc(t('tools.js.addTo', { name: label(path) }))}">＋</button>`);
    if (parent) {
      actions.push(`<button type="button" class="tl-icon" data-role="up" data-path='${p}' ${index === 0 ? 'disabled' : ''} aria-label="${esc(t('tools.js.moveUp', { name: label(path) }))}" title="${esc(t('tools.js.moveUp', { name: label(path) }))}">↑</button>`);
      actions.push(`<button type="button" class="tl-icon" data-role="down" data-path='${p}' ${index === siblings - 1 ? 'disabled' : ''} aria-label="${esc(t('tools.js.moveDown', { name: label(path) }))}" title="${esc(t('tools.js.moveDown', { name: label(path) }))}">↓</button>`);
      actions.push(`<button type="button" class="tl-icon danger" data-role="delete" data-path='${p}' aria-label="${esc(t('tools.js.delete', { name: label(path) }))}" title="${esc(t('tools.js.delete', { name: label(path) }))}">✕</button>`);
    }
    const toggle = container
      ? `<button type="button" class="tl-toggle" data-role="toggle" data-path='${p}' aria-expanded="${open}" aria-controls="${childrenId}" aria-label="${esc(t(open ? 'tools.js.collapse' : 'tools.js.expand', { name: label(path) }))}">${open ? '▾' : '▸'}</button>`
      : '<span class="tl-toggle-space" aria-hidden="true"></span>';
    let children = '';
    if (container && open) {
      const list = node.type === 'object' ? node.entries.map((e) => [e.key, e.node]) : node.items.map((c, i) => [i, c]);
      children = `<ul class="tl-children" id="${childrenId}">${list.map(([k, child], i) => row(child, [...path, k], node, i, list.length)).join('')}</ul>`;
    }
    return `<li class="tl-node" data-depth="${path.length}"><div class="tl-row">${toggle}${keyPart}${typeSelect(node, path)}${valueEditor(node, path)}<span class="tl-row-actions">${actions.join('')}</span></div>${children}</li>`;
  };

  const renderTree = (focusPath, focusRole) => {
    const active = document.activeElement;
    const restore = focusPath ? { path: key(focusPath), role: focusRole } : (treeEl.contains(active) && active.dataset.path ? { path: active.dataset.path, role: active.dataset.role } : null);
    treeEl.innerHTML = `<ul class="tl-root">${row(history.state, [], null, 0, 1)}</ul>`;
    if (restore) {
      const el = [...treeEl.querySelectorAll('[data-path]')].find((x) => x.dataset.path === restore.path && x.dataset.role === restore.role)
        || [...treeEl.querySelectorAll('[data-path]')].find((x) => x.dataset.path === restore.path);
      el?.focus({ preventScroll: false });
    }
  };

  // ----- tree events -----
  const pathOf = (el) => JSON.parse(el.dataset.path);

  treeEl.addEventListener('click', (e) => {
    const el = e.target.closest('button[data-role]');
    if (!el) return;
    const path = pathOf(el);
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1];
    const parent = path.length ? getAt(history.state, parentPath) : null;
    const index = parent ? (parent.type === 'object' ? parent.entries.findIndex((x) => x.key === last) : last) : 0;
    switch (el.dataset.role) {
      case 'toggle':
        if (collapsed.has(key(path))) collapsed.delete(key(path)); else collapsed.add(key(path));
        renderTree(path, 'toggle');
        break;
      case 'add': {
        const node = getAt(history.state, path);
        collapsed.delete(key(path));
        if (node.type === 'object') {
          const k = uniqueKey(node, 'key');
          apply((s) => addChild(s, path, { key: k, node: { type: 'string', value: '' } }), [...path, k], 'key');
        } else {
          apply((s) => addChild(s, path, { node: { type: 'string', value: '' } }), [...path, node.items.length], 'value');
        }
        break;
      }
      case 'up':
      case 'down': {
        const to = el.dataset.role === 'up' ? index - 1 : index + 1;
        const newPath = parent.type === 'array' ? [...parentPath, to] : path;
        apply((s) => moveChild(s, parentPath, index, to), newPath, el.dataset.role);
        break;
      }
      case 'delete': {
        const siblings = parent.type === 'object' ? parent.entries.length : parent.items.length;
        const nextFocus = siblings > 1 ? (parent.type === 'object' ? [...parentPath, parent.entries[index === siblings - 1 ? index - 1 : index + 1].key] : [...parentPath, Math.max(0, index - 1)]) : parentPath;
        apply((s) => removeAt(s, path), nextFocus, siblings > 1 ? 'delete' : 'add');
        notify(t('tools.js.deleted', { name: String(last) }), { kind: 'info', speak: false });
        break;
      }
      default: break;
    }
  });

  treeEl.addEventListener('change', (e) => {
    const el = e.target.closest('[data-role]');
    if (!el) return;
    const path = pathOf(el);
    switch (el.dataset.role) {
      case 'type':
        apply((s) => setAtType(s, path, el.value), path, 'type');
        break;
      case 'value':
        if (!apply((s) => setValue(s, path, el.value), path, 'value')) el.value = String(getAt(history.state, path).value);
        break;
      case 'key': {
        const oldKey = path[path.length - 1];
        const parentPath = path.slice(0, -1);
        if (!apply((s) => renameKey(s, parentPath, oldKey, el.value), [...parentPath, el.value], 'key')) el.value = oldKey;
        break;
      }
      default: break;
    }
  });

  // Enter in a key or value field commits; Escape reverts.
  treeEl.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (e.key === 'Enter') { e.preventDefault(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    if (e.key === 'Escape') {
      const path = pathOf(el);
      el.value = el.dataset.role === 'key' ? String(path[path.length - 1]) : String(getAt(history.state, path).value);
    }
  });

  const setAtType = (s, path, type) => setAt(s, path, changeType(getAt(s, path), type));

  // ----- keyboard shortcuts (outside the raw text area, which keeps its native undo) -----
  root.addEventListener('keydown', (e) => {
    if (e.target === raw || e.target === $('[data-samples]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo('undo'); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); undoRedo('redo'); }
  });

  const undoRedo = (which) => {
    if (which === 'undo' ? !history.canUndo : !history.canRedo) return;
    history[which]();
    lastError = null;
    stale = false;
    treeEl.classList.remove('is-stale');
    writeRaw();
    renderTree();
    setStatus();
    generateLive();
    notify(t(which === 'undo' ? 'tools.js.undone' : 'tools.js.redone'), { kind: 'info', speak: false, sound: false });
  };

  // ----- type generator -----
  const code = $('[data-code]');
  const genStatus = $('[data-gen-status]');
  let generated = '';

  const collectSamples = () => {
    const samples = [];
    if ($('[data-use-editor]').checked) {
      if (stale) throw Object.assign(new Error(t('tools.js.fixEditorFirst')), { friendly: true });
      samples.push(toValue(history.state));
    }
    const extra = $('[data-samples]').value;
    if (extra.trim()) {
      const r = parseMany(extra);
      if (!r.ok) {
        const err = new Error(`${t('tools.js.samplesInvalid')} ${t('tools.at', { line: r.error.line, column: r.error.column })}: ${r.error.message}`);
        err.friendly = true;
        err.position = r.error;
        throw err;
      }
      samples.push(...r.trees.map(toValue));
    }
    if ($('[data-split-array]').checked && samples.length === 1 && Array.isArray(samples[0])) return samples[0];
    return samples;
  };

  const generate = ({ quiet = false } = {}) => {
    try {
      const samples = collectSamples();
      if (!samples.length) { genStatus.textContent = t('tools.js.noSamples'); code.textContent = ''; generated = ''; return; }
      const lang = $('[data-lang]').value;
      const rootName = $('[data-root-name]').value.trim() || 'Root';
      generated = generateTypes(samples, lang, { rootName });
      code.textContent = generated;
      genStatus.textContent = t('tools.js.generatedFrom', { count: formatNumber(samples.length), language: t(`tools.js.lang.${lang}`) });
    } catch (e) {
      genStatus.textContent = e.message;
      if (e.position) selectInTextarea($('[data-samples]'), offsetOf($('[data-samples]').value, e.position.line, e.position.column));
      if (!quiet) fail(t('tools.js.generateFailed'), e.message);
    }
  };
  const generateLive = debounce(() => generate({ quiet: true }), 200);
  for (const sel of ['[data-lang]', '[data-use-editor]', '[data-split-array]']) $(sel).addEventListener('change', () => generate({ quiet: true }));
  $('[data-root-name]').addEventListener('input', generateLive);
  $('[data-samples]').addEventListener('input', generateLive);

  // ----- toolbar and file -----
  dropZone($('[data-drop]'), async (files) => {
    raw.value = await files[0].text();
    fromRaw();
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'undo': undoRedo('undo'); break;
      case 'redo': undoRedo('redo'); break;
      case 'expand': collapsed.clear(); renderTree(); break;
      case 'collapse': walk(history.state, [], (node, path) => { if (path.length && (node.type === 'object' || node.type === 'array')) collapsed.add(key(path)); }); renderTree(); break;
      case 'format': if (!stale) { indent = 2; writeRaw(); } else fail(t('tools.js.fixEditorFirst')); break;
      case 'minify': if (!stale) { indent = 0; writeRaw(); } else fail(t('tools.js.fixEditorFirst')); break;
      case 'copy': copyText(raw.value); break;
      case 'download': downloadText(raw.value, 'document.json', 'application/json'); break;
      case 'goto': if (lastError) selectInTextarea(raw, offsetOf(raw.value, lastError.line, lastError.column)); break;
      case 'generate': generate(); break;
      case 'copy-code': if (generated) copyText(generated); break;
      case 'download-code': {
        if (!generated) return;
        const lang = LANGUAGES.find((l) => l.id === $('[data-lang]').value);
        downloadText(generated, `${$('[data-root-name]').value.trim() || 'Root'}.${lang.ext}`);
        break;
      }
      default: break;
    }
  });

  // Start: big documents open with deep levels collapsed.
  if (countNodes(history.state) > LARGE) collapseDeep(history.state);
  writeRaw();
  renderTree();
  setStatus();
  generate({ quiet: true });

  onLanguage(root, () => { renderTree(); setStatus(); generate({ quiet: true }); });
}

function walk(node, path, fn) {
  fn(node, path);
  if (node.type === 'object') for (const e of node.entries) walk(e.node, [...path, e.key], fn);
  else if (node.type === 'array') node.items.forEach((c, i) => walk(c, [...path, i], fn));
}

function countNodes(node) {
  let n = 0;
  walk(node, [], () => { n++; });
  return n;
}

function hash(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}

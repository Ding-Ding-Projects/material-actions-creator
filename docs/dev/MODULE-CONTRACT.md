# Front-end module contract

The web app is plain ES modules served from `public/` with no build step and no runtime network dependencies. Every feature is a module that registers itself.

## Core APIs

- `public/js/core/i18n.js`
  - `t(key, vars)` — plain text in the current language (personal vocabulary applied to English). Use for attributes, toasts, narration.
  - `h(key, vars)` — escaped HTML; in bilingual mode renders English plus a compact Cantonese line. Use for visible labels.
  - `v(text)` — run server-provided text through the personal vocabulary.
  - `esc(text)` — HTML escape.
  - `translate(root)` — refreshes `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-aria]`, `[data-i18n-title]`.
- `public/js/core/strings.js` — `STRINGS` table. A module adds its own copy with `Object.assign(STRINGS, { 'mymodule.key': { en, yue } })`. Values may be a string or five variants (funny level 1 serious → 5 playful); variants change voice, never facts. Every key needs both `en` and `yue`.
- `public/js/core/store.js` — `get(key)`, `set(key, value)`, `onChange(fn)`, `history()`, `restore(id)`. Settings persist locally and every change is kept in history. Add new defaults by setting the key the first time it is read (`store.get(k) ?? default`).
- `public/js/core/feedback.js` — `notify(message, { kind: 'info'|'success'|'error'|'warn'|'progress', detail })` (non-blocking corner toast + notification centre + narration + sound), `play(name)` (`tick`, `success`, `error`, `confirm`, `tada`, `invalid`), `say(text)`.
- `public/js/core/exporter.js` — `FORMATS`, `serialize(rows, format)`, `download(rows, format, title)`.
- `public/js/core/registry.js`
  - `destination({ id, titleKey, icon, order, mount(el) })` — a tab. `mount` is called once with an empty container element.
  - `command({ id, titleKey | title, keywords, shortcut, run, tab })` — indexed by the Ctrl+Shift+F palette.
  - `setting({ id, key, titleKey, whyKey, control, options, min, max, step, section, tab, target })` — indexed by the palette and settings search; `control` is `toggle | range | select | color | custom`.
  - `teleport({ tab, target })` — switch tab, scroll, focus and flash an element.
- `public/js/ui/regex-builder.js` — `searchField({ placeholderKey, onChange(matcher) })` returns an element: a plain-text search with an adjacent full regex builder. `matcher(text)` returns true when the text matches.
- `public/js/ui/confirm.js` — `superConfirm({ messageKey, vars })` resolves `true` only after the slider reaches the end and Shift+Enter is pressed; Escape cancels.

## Rules

- No new runtime dependencies or network calls. Everything runs locally in the browser.
- Every visible string goes through `h()` / `t()` with English and Cantonese copy.
- Every interactive element is a real `<button>`, `<a href>`, `<input>` + `<label>`, or `<select>`; icon-only buttons get an `aria-label`. Touch targets are at least 44 px. Visible focus.
- Motion uses the shared CSS custom properties (`--ease`) and must stop under `prefers-reduced-motion` and when `html[data-motion="reduced"]`.
- Style with the tokens in `public/app.css` (`--ink-*`, `--line`, `--text`, `--muted`, `--accent`, `--mint`, `--violet`, `--coral`, `--amber`, `--display`, `--mono`, `--r-*`). Put module CSS in `public/css/<module>.css` and link it from `index.html`.
- Personal vocabulary content must never be logged, exported or written to settings history.
- Add focused Node tests under `test/` for any pure logic (parsers, converters, colour maths).

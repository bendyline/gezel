---
id: gezel-app-page-style-guide
title: Gezel app page style guide
order: 13
summary: What Gezel supplies to app pages, and how to build consistent typography, themes, layouts, and controls.
subcategory:
  id: developer
  title: Developer
  order: 3
---

# Gezel app page style guide

An app page should feel like part of Gezel: readable, warm, and focused on the person's work. This guide applies to the HTML/CSS/JavaScript pages declared by a project type's `pages` block. Start with [Building AI Apps inside Gezel](building-ai-apps-inside-gezel.md) for the composition and [Using the Gezel page APIs](gezel-page-apis.md) for behavior.

## What the host supplies today

Gezel injects a shared typography stylesheet into hosted project-type HTML, before the page's own styles. This works in desktop previews, app-serve, and the phone's offline page snapshot. It includes local font faces and these roles:

| Role | Default | Applied automatically to |
| --- | --- | --- |
| `--font-body` | Hanken Grotesk, with system sans fallbacks | The document root; ordinary body text inherits it |
| `--font-ui` | Hanken Grotesk, with system sans fallbacks | Buttons, inputs, selects, textareas, options, and option groups |
| `--font-heading` | PT Serif, with serif fallbacks | `h1` through `h6` |
| `--font-display` | The heading family | Compatibility alias used by `--font-heading` |

Hanken Grotesk has normal weights 400, 500, 600, and 700 plus 400 italic. PT Serif has normal 400 and 700 plus 400 italic. Use those weights rather than requesting an intermediate serif weight that the browser must synthesize.

**Do not copy fonts, licenses, `@font-face` declarations, or a font CDN into each app.** Gezel owns the hosted font assets. The defaults use low-specificity `:where()` selectors, so your authored styles can override them. A `font: … system-ui` shorthand on `body` also overrides them; avoid that accidental reset.

The host supplies typography and an opt-in component kit, not a complete CSS framework. It does **not** inject the shell's color palette, spacing or radius tokens, a CSS reset, a body margin reset, a type size scale, general button styling, a chart library, or page layouts. Variables such as `--bg` and classes such as `.primary` have no built-in meaning inside the page. Define the ones your page uses. Shell CSS does not inherit through the sandboxed iframe.

## Shared file components

Prefer `gezel.ui.components.fileCard` for a file tile/row and `fileAdder` for uploads. The [page API guide](gezel-page-apis.md#file-cards-and-adding-files) covers mounting, lifecycle, permission declarations and standalone demo setup. Both ship their own shadow-root styles, native buttons, focus outlines, status messages and light/dark colors. They inherit the host's `--font-ui`; published and exported demos receive the same fonts. A page's broad `button` or `img` rules do not change component internals.

Pages own the containing grid/list, spacing and breakpoints. Choose `variant: 'tile'` or `'row'`; use `update` when changing layouts. Keep filenames as the primary label and preserve keyboard access. The adder states where files go and what was saved, so do not hide that destination or status.

Optional CSS custom properties on the mount element are `--gezel-component-text`, `--gezel-component-surface`, `--gezel-component-border`, `--gezel-component-muted`, and `--gezel-component-accent`. Set both light and dark values if overriding them, and maintain contrast and a visible focus outline. No copied fonts, CSS framework, external icon service or per-app component fork is needed.

Ordinary workspace/artifact HTML keeps its own styles. The demo publisher/exporter supplies the same typography and components. Keep system fallbacks for degraded rendering without bundling a second font set into app source:

```css
body {
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 1rem;
  line-height: 1.5;
}
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading, Georgia, serif);
  font-weight: 400;
}
button, input, select, textarea {
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: inherit;
}
```

The implementation contract is in [the typography roles](https://github.com/bendyline/gezel/blob/main/packages/ui/src/assets/fonts/typography-tokens.css), [the injected defaults](https://github.com/bendyline/gezel/blob/main/packages/ui/src/assets/fonts/page-defaults.css), and [the font builder](https://github.com/bendyline/gezel/blob/main/scripts/project-page-typography.mjs). Update this guide when that contract changes.

## Theme and page-owned tokens

Use parchment and warm ink in light mode, dark neutral surfaces in dark mode, and terracotta for actions. Sage is an identity color. Use semantic variables in component rules; retain content colors for photographs, illustrations, charts, and other data.

Use both the system preference and the host theme. The media query gives the page a correct initial appearance and supports a raw standalone demo. An explicit host theme should win over the operating system preference. This small starter uses the shell's palette values, but **these declarations belong to the page; they are not injected**:

```css
:root {
  color-scheme: light dark;
  --page-bg: #eae5d6;
  --page-panel: #f3eddf;
  --page-text: #1c1c1c;
  --page-muted: #5a4f42;
  --page-border: #8b7e6b;
  --page-accent: #9a4e30;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page-bg: #141517;
    --page-panel: #1c1d20;
    --page-text: #f0f0f0;
    --page-muted: #b9aea0;
    --page-border: #8b7e6b;
    --page-accent: #d5a07a;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page-bg: #141517;
  --page-panel: #1c1d20;
  --page-text: #f0f0f0;
  --page-muted: #b9aea0;
  --page-border: #8b7e6b;
  --page-accent: #d5a07a;
}
:root[data-theme="light"] { color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--page-bg); color: var(--page-text); }
main { max-width: 72rem; margin: auto; padding: clamp(1rem, 3vw, 2.5rem); }
button, input, select, textarea {
  min-height: 44px;
  padding: .5rem .75rem;
  border: 1px solid var(--page-border);
  border-radius: 6px;
  background: var(--page-panel);
  color: var(--page-text);
}
:focus-visible { outline: 2px solid var(--page-accent); outline-offset: 3px; }
a { font-family: var(--font-ui, system-ui, sans-serif); color: var(--page-accent); }
```

After the real API or shared demo bootstrap has initialized `gezel`, apply and subscribe to its theme:

```js
const applyTheme = ({ mode }) => { document.documentElement.dataset.theme = mode; };
applyTheme(gezel.ui.theme);
const stopTheme = gezel.ui.onTheme(applyTheme);
window.addEventListener('pagehide', stopTheme, { once: true });
```

## Layout, controls, and language

- Put the person's content first. Give the page one clear title, a short explanation when needed, and visible primary actions. Keep project ids, tool names, SQL, and host transport details out of ordinary flows.
- Use serif for headings and sans for body text, labels, and controls. Start body text around 16px with a comfortable line-height. Keep captions readable and avoid shrinking controls to fit a narrow pane.
- Use mostly-square controls: 4px for small badges, 6px for buttons and inputs, and around 10px for trays and small surfaces. Choice controls are keys in a tray with a clear pressed state. Avoid capsule buttons, emoji navigation, and decorative dashboard clutter.
- Use native elements: a `button` for an action, an `a` for a real destination, labels for inputs, and a real table for tabular data. Give toggles `aria-pressed` and icon-only controls an accessible name.
- The embedded page sandbox permits scripts but not native form submissions. Use `button type="button"` and explicit action handlers; support Enter in single-line inputs without relying on a form's `submit` event. Invoke declared tools through `gezel.tools.invoke`.
- Keep focus visible, support keyboard operation, and restore focus after closing dialogs. Native video/audio controls are a useful baseline. Do not autoplay media.
- Check contrast in both themes, including helper text and selected states. Communicate errors and chart series with text or shape as well as color. Honor reduced-motion preferences when adding animation.
- Check a narrow Output pane and a 320px viewport. Wrap filters, allow long filenames to break, and contain necessary table overflow within its region. A page should not force the whole host to scroll sideways.

The full product direction remains in [Gezel UX](https://github.com/bendyline/gezel/blob/main/docs/ux.md); the [brand guidelines](https://github.com/bendyline/gezel/blob/main/docs/design-guidelines.md) cover other surfaces. Their shell class names and token declarations are references, not automatically available page APIs.

## Data and state are part of the design

Show distinct loading, empty, permission-denied, unavailable, partial-result, and failed-action states. Keep useful content visible when an optional capability fails; a data dashboard can still list files without DuckDB, and a gallery can still list a file whose codec cannot play. Tell the person when a listing or query is truncated, or when a chart describes an indexed snapshot rather than the latest file bytes.

Use `textContent` for filenames and data labels. Read files through `gezel.data`, use `data.url()` for media, and use declared tools for writes. Debounce refreshes, limit rendered cards, unsubscribe watches, stop players on close, and ignore stale asynchronous results after a selection changes.

Standalone samples must be clearly labeled and deterministic. Keep their mutations in memory and provide Reset demo. Never substitute sample data after a live permission or query failure. The [page API guide](gezel-page-apis.md) describes the host modes and the shared demo bootstrap.

Before delivery, inspect light and dark mode, keyboard focus, long labels, an empty folder, a failed operation, narrow layouts, and the real host flow. Structural validation cannot establish that a page is usable.

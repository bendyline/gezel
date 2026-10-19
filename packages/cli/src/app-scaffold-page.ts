import { PAGE_DEMO_STUB } from './app-scaffold-demo.js';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

/** Self-contained so an installed CLI and a raw-file demo need no build step. */
export function dashboardHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="gezel-demo" content="standalone" />
<title>${escapeHtml(name)}</title>
<style>
  /* Gezel injects font roles, not a CSS reset or a control/layout framework. */
  :root {
    color-scheme: light dark;
    --bg: #f7f4ee; --ink: #2c2925; --card: #fffdf9;
    --line: #c2b9ab; --muted: #61594f; --accent: #5c6a4a; --error: #a52d28;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #211e1a; --ink: #e8e2d8; --card: #2b2723;
    --line: #766c60; --muted: #c0b6a8; --accent: #bac9a5; --error: #ffb4ab;
  }
  /* The OS is a fallback only; an explicit host theme always wins. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) {
      color-scheme: dark;
      --bg: #211e1a; --ink: #e8e2d8; --card: #2b2723;
      --line: #766c60; --muted: #c0b6a8; --accent: #bac9a5; --error: #ffb4ab;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: clamp(1rem, 4vw, 2rem);
    background: var(--bg); color: var(--ink);
    font-family: var(--font-body, system-ui, sans-serif);
    font-size: 1rem; line-height: 1.5;
  }
  main { max-width: 44rem; margin: auto; }
  h1 { font-family: var(--font-heading, Georgia, serif); font-size: 1.75rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0 1rem; }
  .muted { color: var(--muted); }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin: 1rem 0; }
  .toolbar p { flex: 1; margin: 0; }
  [data-gezel-demo-banner] { padding: .75rem; border: 1px solid var(--line); border-radius: 6px; }
  ul { list-style: none; margin: 1rem 0; padding: 0; }
  li { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: .75rem; margin-bottom: .5rem; overflow-wrap: anywhere; }
  li time { display: block; color: var(--muted); font-size: .875rem; }
  label { display: block; margin-bottom: .25rem; }
  .entry { display: flex; flex-wrap: wrap; gap: .5rem; }
  input { flex: 1 1 12rem; min-width: 0; }
  button, input {
    font-family: var(--font-ui, system-ui, sans-serif); font-size: 1rem; line-height: 1.5;
    background: var(--card); color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: .5rem .75rem;
  }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  :disabled { opacity: .6; cursor: default; }
  [role="alert"] { color: var(--error); overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
  <aside class="toolbar" data-gezel-demo-banner hidden aria-label="Demo">
    <p>Demo — sample records, saved only for this visit.</p>
    <button id="reset" type="button">Reset demo</button>
  </aside>
  <h1>${escapeHtml(name)}</h1>
  <p class="muted">A place for the things worth keeping.</p>
  <div class="toolbar">
    <p id="status" class="muted" role="status">Loading records…</p>
    <button id="refresh" type="button">Refresh</button>
  </div>
  <p id="load-error" role="alert" hidden></p>
  <ul id="records" aria-label="Records"></ul>
  <p id="readonly" class="muted" hidden>This preview is read-only. Open the page in Gezel to add records.</p>
  <div role="group" aria-label="Add a record">
    <label for="title">New record</label>
    <div class="entry">
      <input id="title" name="title" required autocomplete="off" disabled />
      <button id="add" type="button" disabled>Add record</button>
    </div>
  </div>
  <p id="action-error" role="alert" hidden></p>
</main>
<script>
${PAGE_DEMO_STUB}</script>
<script>${pageComponentsSource()}</script>
<script>
(() => {
  'use strict';
  // The canonical stub never replaces an injected host, including on errors.
  const samples = () => ({ records: [
    { title: 'Plan the next small step', at: '2026-01-01T12:00:00.000Z' },
    { title: 'Keep a useful discovery', at: '2026-01-02T12:00:00.000Z' },
  ] });
  let demoData = samples();
  const api = window.makeDemoGezel({
    page: { entry: 'dashboard/index.html', typeName: document.title },
    data: { 'data.json': () => structuredClone(demoData) },
    tools: {
      page_add_record: ({ title }) => {
        if (typeof title !== 'string' || !title.trim()) throw new Error('Enter a title for the record.');
        demoData.records.push({
          title: title.trim(),
          at: new Date(Date.UTC(2026, 0, demoData.records.length + 1, 12)).toISOString(),
        });
        return structuredClone(demoData);
      },
    },
  });
  const demoMode = api.page.mode === 'demo';
  window.installGezelComponents(api, { demoTargets: [] });
  const readOnly = api.page.mode === 'browser';
  const list = document.querySelector('#records');
  const status = document.querySelector('#status');
  const loadError = document.querySelector('#load-error');
  const actionError = document.querySelector('#action-error');
  const title = document.querySelector('#title');
  const add = document.querySelector('#add');
  document.querySelector('[data-gezel-demo-banner]').hidden = !demoMode;
  document.querySelector('#readonly').hidden = !readOnly;
  let ready = false, busy = false, active = false, revision = 0;
  let unwatch = () => {}, untheme = () => {};

  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function showError(element, message = '') {
    element.textContent = message;
    element.hidden = !message;
  }
  function updateControls() {
    title.disabled = add.disabled = readOnly || !ready || busy;
    add.textContent = busy ? 'Adding…' : 'Add record';
  }
  function render(data) {
    if (!data || !Array.isArray(data.records) || data.records.some(record =>
      !record || typeof record.title !== 'string' || typeof record.at !== 'string')) {
      throw new Error('Expected records with a title and date.');
    }
    list.replaceChildren();
    for (const record of data.records) {
      const item = document.createElement('li');
      const date = document.createElement('time');
      // Workspace strings are content, never HTML.
      item.textContent = record.title;
      date.textContent = record.at.slice(0, 10);
      date.dateTime = record.at;
      item.append(date);
      list.append(item);
    }
    status.textContent = data.records.length
      ? data.records.length + (data.records.length === 1 ? ' record' : ' records')
      : 'No records yet. Add the first one below.';
  }
  async function refresh() {
    const current = ++revision;
    status.textContent = 'Loading records…';
    try {
      const data = await api.data.read('data.json', { as: 'json' });
      if (!active || current !== revision) return;
      render(data);
      ready = true;
      showError(loadError);
    } catch (error) {
      if (!active || current !== revision) return;
      ready = false;
      status.textContent = 'Records could not be refreshed.';
      showError(loadError, errorText(error) + ' Use Refresh to try again.');
    }
    if (active && current === revision) updateControls();
  }
  // Gezel's iframe allows scripts, not native form submissions.
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add.click(); }
  });
  add.addEventListener('click', async () => {
    if (busy || readOnly || !ready) return;
    if (!title.value.trim()) {
      showError(actionError, 'Enter a title for the record.');
      title.focus();
      return;
    }
    busy = true;
    updateControls();
    showError(actionError);
    try {
      await api.tools.invoke('page_add_record', { title: title.value.trim() });
      if (!active) return;
      title.value = '';
      await refresh();
    } catch (error) {
      if (active) showError(actionError, errorText(error));
    } finally {
      busy = false;
      if (active) { updateControls(); if (!title.disabled) title.focus(); }
    }
  });
  document.querySelector('#refresh').addEventListener('click', refresh);
  document.querySelector('#reset').addEventListener('click', () => {
    if (!demoMode || busy) return;
    demoData = samples();
    title.value = '';
    showError(actionError);
    refresh();
  });
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme.mode === 'dark' ? 'dark' : 'light';
  }
  function start() {
    if (active) return;
    active = true;
    applyTheme(api.ui.theme);
    untheme = api.ui.onTheme(applyTheme);
    unwatch = api.data.watch('data.json', refresh);
    refresh();
  }
  window.addEventListener('pagehide', () => {
    active = false;
    ++revision; // Ignore any read that completes after teardown.
    unwatch(); untheme();
  });
  window.addEventListener('pageshow', start); // Also resume after back/forward cache restoration.
  start();
})();
</script>
</body>
</html>
`;
}
import { pageComponentsSource } from '@bendyline/gezel';

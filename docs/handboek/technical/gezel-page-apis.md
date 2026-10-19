---
id: gezel-page-apis
title: Using the Gezel page APIs
order: 12
summary: Connect an app page to project files, file viewers, DuckDB summaries, declared actions, and the host theme.
subcategory:
  id: developer
  title: Developer
  order: 3
---

# Using the Gezel page APIs

A project type can ship `pages/index.html` with relative JavaScript, CSS, and assets. Gezel hosts that page in the project's Output pane and injects `window.gezel` before its scripts run. You build a normal browser interface; Gezel supplies project identity, scoped file access, declared actions, and the theme. You do not need a React component inside the desktop shell or a new service for each app.

Read [Building AI Apps inside Gezel](building-ai-apps-inside-gezel.md) for the whole app and the [app page style guide](gezel-app-page-style-guide.md) for injected fonts and page-owned styles. The complete [Output Pane API reference](https://github.com/bendyline/gezel/blob/main/docs/output-pane-api.md) owns method signatures, error codes, permissions, limits, and compatibility; [the typed API](https://github.com/bendyline/gezel/blob/main/packages/sdk/src/page.ts) is exported as `@bendyline/gezel-sdk/page` for authoring tools.

## Declare the page and its authority

This is a `pages` block inside a project type's **version** manifest:

```json
{
  "pages": {
    "entry": "index.html",
    "api": 1,
    "reads": [
      { "source": "workspace", "path": "media", "subtree": true },
      { "source": "artifacts", "path": "summary.json" }
    ],
    "tools": ["page_refresh_summary"]
  }
}
```

The entry is relative to `pages/`. Reads are project-relative; `workspace` and `artifacts` are different trees. An exact-file grant does not grant the surrounding directory. A folder explorer can deliberately grant `{"source":"workspace","path":".","subtree":true}` for the whole selected project folder. The host checks the grants and path containment. It binds the project; a page never supplies its own project id to escape that boundary.

Every `pages.tools` name must also be declared in the type's `tools` array. Those names are page-only: they are removed from the model's tool roster. If both the page and a gezel need an action, declare two tool names sharing the same script and bound operation. A declared action still needs the script's capabilities and the user's project policy to permit it.

## Choose the smallest API that does the job

| Job | API | Important behavior |
| --- | --- | --- |
| Identify the app instance | `gezel.page` | Type name, params, project id, API version, and host mode |
| List a folder | `gezel.data.list(path, opts?)` | One directory at a time; recursion and scan bounds belong to the page |
| Read small state | `gezel.data.read(path, opts?)` | JSON, text, or bytes; bounded reads |
| Follow changes | `gezel.data.watch(path, callback, opts?)` | Callback signals a change; re-read the data; retain the unsubscribe function |
| Display media | `gezel.data.url(path, opts?)` | Assign to an image/audio/video element; hosted media can stream and seek |
| Open the original in Gezel | `gezel.data.open(path, opts?)` | Navigates to the existing file rendition in embedded mode |
| Render a consistent file tile or row | `gezel.ui.components.fileCard(mount, options)` | Thumbnail/fallback, metadata, keyboard action and existing file viewer |
| Add files with a picker or drop | `gezel.ui.components.fileAdder(mount, options)` | Explicit destination, progress, cancellation and per-file results |
| Discover upload destinations | `gezel.data.importTargets()` | Manifest targets plus current write permission |
| Copy selected files into a destination | `gezel.data.importFiles(files, options)` | Scoped, create-only uploads; returns saved paths and partial failures |
| Find indexed datasets | `gezel.tables.list()` | Only tables whose source files are within the page's readable scope |
| Inspect columns | `gezel.tables.describe(tableName)` | Column types and available metadata |
| Summarize or chart data | `gezel.tables.query(sql, opts?)` | Bounded, read-only DuckDB queries over permitted indexed tables |
| Change state or run an action | `gezel.tools.invoke(name, input?)` | Schema-validated, declared script-backed action |
| Follow the host theme | `gezel.ui.theme`, `gezel.ui.onTheme(callback)` | Apply at boot and keep the unsubscribe function |

Use the existing file rendition instead of rebuilding a spreadsheet or CSV editor in your page. Use the shared query API instead of bundling DuckDB or fetching observation storage files. Tables describe an indexed snapshot: listing a CSV does not guarantee a table is ready. Handle missing indexing and unavailable query engines explicitly.

For a simple live list, wire a change signal to a fresh read, and treat filenames as text:

```js
// Live-host example; initialize the demo stub first if this page also runs raw.
const list = document.querySelector('#files');
const status = document.querySelector('#status');
let revision = 0;
async function refresh() {
  const request = ++revision;
  try {
    const entries = await gezel.data.list('media');
    if (request !== revision) return;
    list.replaceChildren(...entries.map((entry) => {
      const row = document.createElement('li');
      row.textContent = entry.name;
      return row;
    }));
    status.textContent = entries.length ? `${entries.length} items` : 'This folder is empty.';
  } catch (error) {
    if (request === revision) status.textContent = `Could not read this folder: ${error.message}`;
  }
}
const stop = gezel.data.watch('media', refresh, { intervalMs: 15000 });
window.addEventListener('pagehide', () => { revision++; stop(); }, { once: true });
void refresh();
```

Do not treat the watch callback's `{path, etag}` as the file's contents. Avoid overlapping whole-folder scans and unbounded watchers. The browser fallback interval is configurable; embedded watches use the host's shared mechanism.

## Account for the host mode

| Host | Files/media | Tools | File viewer | Tables |
| --- | --- | --- | --- | --- |
| Desktop Output pane (`embedded`) | Scoped access | Declared actions | `data.open()` | When the query engine and index are available |
| Authenticated mini-site (`serve`) | Scoped access | Declared actions | Unavailable | When the query engine and index are available |
| Capability preview tab (`browser`) | Capability-scoped fallback | Unavailable | Unavailable | Unavailable |
| Raw standalone page (`demo`) | Authored samples | In-memory demo handlers | Explain the live action | Authored sample summaries, if provided |
| Phone's embedded snapshot | Scoped bridge with bounded media relay | Supported portable actions | Host-dependent; handle unavailable | Unavailable in the portable runtime |

Feature-detect optional additions such as `gezel.tables` and `gezel.data.open`, then handle their errors. Mode alone is not a promise that every engine or codec is installed. Avoid offering an action that cannot work in the current mode.

For Gilde's standalone demos, embed [the canonical demo stub](https://github.com/bendyline/gilde/blob/main/authoring/page-demo-stub.js) verbatim before your own code and call `makeDemoGezel(...)`. It returns the real API unchanged when present. Otherwise it installs the demo transport; your app supplies deterministic sample handlers and a visible sample banner with Reset demo. The stub does not invent table data or a working host file viewer. Follow [Gilde's page-authoring contract](https://github.com/bendyline/gilde/blob/main/docs/page-authoring.md). A failed live call must remain a live error, not switch the page into demo mode.

Pages have no daemon credentials, Node filesystem, unrestricted SQL connection, or arbitrary-path write API. Imports are a narrow exception for explicitly declared destinations. Stay on this shared surface.

## File cards and adding files

The host injects `gezel.ui.components` with the page API. It works with ordinary HTML and has no React dependency. Pass a selector or an element; the component appends its own custom element with a shadow root. Retain its handle and call `destroy()` before discarding it. `update(partialOptions)` updates an existing instance. File adder handles also provide `refresh()` to recheck destination availability after a settings change.

```html
<div id="add-files"></div>
<div id="selected-file"></div>
```

```js
const card = gezel.ui.components.fileCard('#selected-file', {
  file: { source: 'workspace', path: 'media/garden.jpg', size: 24576 },
  variant: 'tile', // 'row' for a compact list
});
const adder = gezel.ui.components.fileAdder('#add-files', {
  target: 'library',
  onAdded: async (savedFiles) => { await refreshListing(); },
});
window.addEventListener('pagehide', () => { card.destroy(); adder.destroy(); });
```

By default a card calls `data.open` and displays an error if the host viewer is unavailable. A gallery can supply `onActivate(file)` to show its own media preview; do not replace Gezel's spreadsheet/document renditions. `thumbnail: false` disables automatic image thumbnails; an explicit URL selects a local demo illustration. Filenames render as text. Components inherit `--font-ui` and track `ui.onTheme`; see the [style guide](gezel-app-page-style-guide.md#shared-file-components).

Declare destinations in the project type, separately from readable files:

```json
{
  "pages": {
    "entry": "index.html",
    "api": 1,
    "reads": [{ "source": "workspace", "path": "media", "subtree": true }],
    "imports": [{
      "id": "library", "source": "workspace", "path": "media",
      "accept": [".jpg", ".png", ".mp4"], "maxFileBytes": 268435456
    }]
  }
}
```

Imports support workspace destinations only. `path: "."` means the project's selected folder. `accept` is an optional extension allowlist; the host enforces it and the byte limit independently of picker hints. An import declaration does not grant read access or override managed workspace writes. In particular, an external folder still needs the user's existing write opt-in in Project Settings. There is no page-facing bypass or permission toggle.

Use the adder for the usual flow. A custom UI can call `data.importFiles(File[], { target, signal, onProgress })`; each result is `{ ok: true, name, file: { source, path, name, size, mtime } }` or `{ ok: false, name, error }`. `onProgress` reports `{ completed, total, name }` per file, not bytes. Save the returned paths: duplicates become `name (1).ext`, and existing files are never overwritten. Originals stay where the user selected them. Cancel stops pending work and does not undo files already saved. A file that finished committing as cancellation arrived may already exist; refresh the listing to reconcile.

The current limits are 100 files per batch, 256 MiB per file (a target may lower it), two active uploads per project, four per daemon, 120 attempts per project per minute, and a five-minute upload deadline. The server streams bytes to private temporary storage, validates scopes and paths, rechecks the destination and write policy at commit, and publishes atomically through the Store. It rejects traversal, symlink escapes, hidden/reserved names, and alternate streams. Imports never accept host source paths from a page.

Live imports currently require the embedded desktop host. Browser tabs, phone snapshots and app-serve visitors get an explicit unavailable state; a shareable site's read capability never grants uploads. Components themselves work across these hosts. Always handle unsupported hosts and permission failures without silently enabling demo mode.

After `onAdded`, refresh the app's listing. Ordinary workspace indexing follows asynchronously, so a newly added spreadsheet may appear before its DuckDB tables are ready. Keep the indexing/empty state and normal table refresh behavior.

### Standalone component demos

Keep the canonical demo stub, visible demo banner and Reset demo control. Copy [Gilde's canonical component runtime](https://github.com/bendyline/gilde/blob/main/authoring/page-components.js) alongside your page and load it before your app script. Gezel injects this same runtime when hosted. Initialize it after `makeDemoGezel`:

```js
const api = makeDemoGezel({ page: { typeName: 'My library' } });
const components = api.ui.components || installGezelComponents(api, {
  demoTargets: [{ id: 'library', source: 'workspace', path: '.', accept: ['.png'] }],
  existingPaths: samples.map(file => file.path),
});
// Merge these into your representative sample listing after onAdded:
const added = components.demo?.files() ?? [];
// In your Reset demo handler, clear imported descriptors and release object URLs:
components.demo?.reset();
```

Demo imports exercise the same picker, drop, validation, progress and cards. They retain browser Files/object URLs in this tab, use deterministic metadata, and never write to disk or invoke a model. `data.url` resolves imported demo media. Reset the page's own sample state and remount the adder to clear its result list. Do not claim imported demo data was indexed: Data Analysis keeps its charts on labeled sample tables.

React apps can mount either component in a ref inside an effect and call `destroy()` in cleanup. There is no separate React component implementation to keep in sync.

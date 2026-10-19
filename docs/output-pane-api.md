# Output Pane API (`window.gezel`)

## Shared file UI and scoped imports

`gezel.ui.components.fileCard(mount, options)` and `fileAdder(mount, options)`
mount framework-independent custom elements with shared fonts, theme handling
and shadow-root styles. Handles support `update` / `destroy`; file adders also
support `refresh` to recheck permissions. See the
[component examples and standalone setup](handboek/technical/gezel-page-apis.md#file-cards-and-adding-files)
and [styling contract](handboek/technical/gezel-app-page-style-guide.md#shared-file-components).

`data.importTargets()` returns declared `pages.imports` destinations and current
writability. `data.importFiles(files, { target, signal?, onProgress? })` copies
browser Files into one named workspace destination and returns per-file
success/failure results with actual saved paths. This is separate from
`pages.reads`; arbitrary path writes, overwrites, and external-folder consent
bypasses are unavailable. Unsupported hosts reject explicitly; standalone demos
use the same components with an in-memory adapter.

Desktop transport: `import-targets`, `import-file` (structured-cloned Blob),
`import-cancel`, and `import-result` v1 bridge messages. The parent binds the
current project and authenticates `GET/POST /api/projects/:id/page-imports`.
POST uses `?target=<id>&name=<child-name>` and a raw byte body. Neither the daemon
token nor host source paths reach the page. Uploads are streamed, bounded,
reauthorized at commit and atomically published through the Store. The endpoint
requires first-party auth and is absent from app-serve visitor and phone runtime
surfaces. Limits and result types are detailed in the authoring guide above.

For the authoring path, start with [Building Gezel apps](building-gezel-apps.md)
and [Using the Gezel page APIs](handboek/technical/gezel-page-apis.md). The
[app page style guide](handboek/technical/gezel-app-page-style-guide.md) separates
injected typography from the styles each page owns. This document is the method
and transport reference.

The supported JavaScript surface for interactive project-type pages — the
HTML dashboards pinned into a project's Output pane (`manifest.pages`).
Version 1. The daemon injects the API into every served type page; pages
authored against it never parse their own URLs, never juggle preview-
capability expiry, and never hand-roll postMessage plumbing.

This replaces the copy-pasted `gezelPage` IIFE + capability-fetch-polling
pattern of the first interactive types (checkers 1.1.x, flashcards 1.0.x).
That legacy wire protocol ("v0") keeps working forever — see
[Compatibility](#compatibility).

## The object

Project pages also receive [shared typography](project-types.md#shared-typography)
automatically: local body/UI and heading fonts, with `--font-body`, `--font-ui`,
and `--font-heading` CSS roles. No JavaScript or bundled font assets are needed.

Served type pages find a frozen `window.gezel` defined before any page
script runs:

```js
gezel.page      // { api: 1, projectId, source: 'type', entry, typeName, params, mode }
gezel.tools     // { list(), invoke(tool, input?) }
gezel.data      // { read(path, opts?), list(path, opts?), watch(path, cb, opts?), url(path, opts?), open(path, opts?) }
gezel.tables    // { list(), describe(name), query(sql, opts?) }
gezel.ui        // { theme: { mode: 'light'|'dark' }, onTheme(cb) }
gezel.refresh() // ask the host to re-mint + reload this page
```

Typed definitions ship as `@bendyline/gezel-sdk/page`. Feature-detect with
`typeof gezel !== 'undefined' && gezel.page.api >= 1`.

`gezel.page.mode` tells a page where it woke up:

| mode | Where | tools | data |
|---|---|---|---|
| `embedded` | The Output pane iframe | relayed through the host | relayed through the host |
| `browser` | "Open in browser" tab | reject `code: 'unavailable'` | same-origin capability fetch fallback |
| `serve` | An app-serve mini-site (`gezel app serve`) | same-origin fetch against the head API | same-origin fetch; `watch` polls | 
| `demo` | Published preview or exported offline page | page-supplied handlers | page-supplied handlers |

`demo` comes from the shared demo bootstrap, injected by the website publisher,
Gilde preview server, or `gezel app demo` offline exporter. App scripts use
`window.gezel || window.makeDemoGezel({ page, tools, data, existingPaths })`.
The bootstrap supplies the canonical components, font stylesheet and sample
transport; import destinations come from `pages.imports`. App source contains
its own sample handlers and Reset control, with no platform asset copies.
Existing hosts are preserved, including when a live call fails.

## Reading data

```js
const game = await gezel.data.read('game.json');            // parsed JSON (by extension)
const notes = await gezel.data.read('notes.md');            // string
const bytes = await gezel.data.read('media/a.png', { as: 'bytes' });  // Uint8Array
const posts = await gezel.data.list('posts');               // [{ name, kind, size, mtime }]
const stop  = gezel.data.watch('posts', ({ path, etag }) => rerender());
const src   = gezel.data.url('media/hero.png');             // for <img src>, media elements
await gezel.data.open('sales.csv');                       // open Gezel's file viewer
```

- Every path must be declared in the manifest's `pages.reads` (exact file,
  or a subtree root with `subtree: true`). Enforcement is server-side, per
  request, re-derived from the applied type's manifest — a page can never
  read beyond its declaration.
- `opts.source` is `'workspace'` (default) or `'artifacts'`. Artifacts is
  how a dashboard reads connector-synced corpora (`data/**`) for analytics.
- Reads are capped (2 MB per read; watch this if you store large blobs).
- `watch` is centralized in the host: zero polling when nothing watches,
  one etag sweep per interval for everything, plus an immediate sweep after
  each successful tool invoke — a user action that mutates a watched file
  repaints in ~200 ms. The unsubscribe function is the return value.
- `url()` returns a capability-relative URL for media elements. It expires
  with the document's preview lease; a reload re-mints. Use `read`/`watch`
  for data, `url()` only for `<img>`/`<audio>`/`<video>`.
- `open()` opens a file in the host's existing rendition (CSV table,
  spreadsheet, document, or other file viewer). It checks `pages.reads`,
  path containment, and file existence through the server before navigating;
  it does not read the bytes through the page bridge. It accepts `opts.source`
  and works only in embedded mode; browser and serve modes reject with
  `unavailable`. Feature-detect `gezel.data.open` when supporting older hosts.

## Querying tables

```js
const tables = await gezel.tables.list();
if (tables.length) {
  const table = tables[0]; // name, title, source, path, rows, columnCount, updatedAt
  const { columns } = await gezel.tables.describe(table.name);
  // Quote identifiers; parameterize/escape values separately when building SQL.
  const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';
  const result = await gezel.tables.query(
    `SELECT count(*) AS records FROM ${identifier(table.name)}`,
    { tables: [table.name], limit: 100 },
  );
  renderSummary(result.rows, columns);
}
```

These methods use Gezel's existing DuckDB observation tables. They query the
indexed snapshot, not the raw file on demand. Today XLSX and large CSV/TSV files
can produce workspace tables; a file appearing in `data.list()` does not by
itself mean it has a queryable table. Indexing must have completed successfully.
Descriptions include typed columns, roles, units, and available documentation.

`pages.reads` is the authority on every call, including calls reusing an old
table name. Workspace tables require permission to read their original source
file. Connector tables require an **artifacts subtree** grant covering their
table directory (for example `data/weather/tables/readings`). Reading just a
manifest file does not grant access to its rows. Deleted source files and revoked
grants disappear from discovery. Host-issued SQL names are stable opaque
identifiers; they are not capabilities and must not be derived from filenames.

`query(sql, { tables?, limit? })` accepts one read-only SELECT statement. `tables`
narrows the available tables; omitting it selects all currently readable tables.
The host binds the project, validates SQL with DuckDB's parser, restricts file
access to the selected table directories, and disables external/network access.
Default results are 100 rows, at most 1,000 rows and 1 MiB, with a `truncated`
flag when more rows exist. Validation and query execution each have a 10-second
budget and a 256 MB engine memory limit. Requests are rate-limited and concurrency is capped at two per project
and eight across the service. Prefer aggregate queries for charts and summaries.
The result contains `rows`, `columns`, `limit`, `truncated`, and `tablesInScope`.

Tables work in embedded desktop and authenticated app-serve pages. Standalone
capability browser tabs and the phone's portable runtime report `unavailable`;
the desktop also reports this when its DuckDB engine is absent. Feature-detect
`gezel.tables` for older hosts, handle errors, and keep file browsing usable when
no tables or query engine are available. Never substitute demo data in a live page.

## Invoking tools

```js
try {
  const { output } = await gezel.tools.invoke('user_move', { from: 'c3', to: 'd4' });
} catch (err) {
  // err.code: 'not-allowed' | 'invalid-input' | 'script-error' | 'timeout'
  //         | 'unavailable' | 'rate-limited'
  showError(err.message);
}
```

- Only names in the manifest's `pages.tools` are invokable, and those names
  are removed from the model's tool surface (page-ONLY, so a gezel can
  never play the user's moves). The host re-derives the allowlist
  server-side on every call.
- The tool's declared `inputs` JSON schema is validated server-side; a
  mismatch rejects with `code: 'invalid-input'` before the script runs.
- Manifest `bind` values are merged over the page's input — a page cannot
  override a pinned action selector.
- A successful invoke may carry `reaction` metadata when the tool declares
  one (the "summon the gezel" mechanism, unchanged from v0).

## Theme

Pages render inside the app and should follow its theme:

```js
applyTheme(gezel.ui.theme.mode);
gezel.ui.onTheme(({ mode }) => applyTheme(mode));
```

The host pushes changes live (Settings toggle, OS switch while on system).

## Wire protocol (host implementers)

Everything rides one versioned postMessage envelope, zod-defined in
`packages/core/src/schemas/page-bridge.ts`:

```
page → host: { __gezelPage: 1, kind: 'hello' | 'invoke' | 'read' | 'open' | 'watch' | 'unwatch' | 'refresh', ... }
host → page: { __gezelPage: 1, kind: 'init' | 'result' | 'read-result' | 'open-result' | 'change' | 'theme', ... }
```

- The shim (`pageApiShimSource` / `buildPageApiShim` in
  `packages/core/src/project-types/page-api-shim.ts`) is injected by
  `preparePreviewHtml` for `source === 'type'` responses only, with a
  server-authoritative bootstrap (identity, params, declared tools). The
  phone embeds the same shim; see "Pages on phones" below.
- The host relay lives in the UI's `HtmlPreviewFrame`. Reads relay to
  `POST /api/projects/:id/page-read` (first-party auth; scopes re-derived
  via `resolvePageReads`); invokes relay to the existing
  `POST /api/projects/:id/page-invoke`. Table operations relay to
  `POST /api/projects/:id/page-tables`, with `{ op: 'list' }`,
  `{ op: 'describe', table }`, or `{ op: 'query', sql, tables?, limit? }`.
- Identity, not origin, authenticates both directions: the iframe is
  sandboxed without `allow-same-origin` (opaque origin), so the shim
  requires `event.source === window.parent` and the relay requires
  `event.source === frame.contentWindow`. No bearer ever enters the frame.

## Serve head (HTTP transport)

When a page is served by the app-serve head (`gezel app serve`,
docs/app-serve.md), the injected bootstrap carries a `serve` block
(`{ apiBase, dataBase, chat }`) and the shim selects mode `serve`. The same
queue/ceiling machinery runs, but each call travels as a same-origin fetch
under the visitor's HttpOnly cookie:

- `tools.invoke` → `POST {apiBase}/invoke` with `{tool, input}` — the same
  body and result contract as the first-party page-invoke route, enforced by
  the same server-side implementation (`http/page-io.ts`).
- `data.read/list/stat` → `POST {apiBase}/read` with the read envelope.
- `tables.list/describe/query` → `POST {apiBase}/tables` with the table envelope,
  enforced by the same permission checks as the desktop relay.
- `data.watch` → polls `stat` on the read route (2.5s default), with an
  immediate sweep after each successful invoke.
- `data.url()` → `{dataBase}/{source}/{path}` — direct media GETs; the
  browser attaches the visitor cookie same-origin.

Desktop preview and app-serve media URLs stream images, video, and audio from
the authorized file instead of buffering the entire file. Single byte-range
requests and `HEAD` support playback and seeking; each request still passes
the normal capability or visitor-cookie and file-scope checks. The 2 MiB
`data.read` limit stays in place, including the phone relay described below.

HTTP status → error-code mapping matches the desktop relay: 400/413/422 →
`invalid-input`, 401/403/404 → `not-allowed`, 429 → `rate-limited`,
anything else `unavailable`. No credential ever reaches the page; the
visitor cookie is HttpOnly and means nothing to the daemon's `/api/*`
surface.

## Pages on phones

A phone has no preview server. Its Output pane shows a type's page as a
**snapshot**: one document with every script and asset embedded as `data:`
URLs, served by the native host from `https://localhost/__gezel_preview/<id>/`
under a CSP with no network (`connect-src 'none'`) and a sandbox
([html-preview.ts](../packages/mobile/src/html-preview.ts)). For a type's
page the snapshot builder reads the page tree from the bundled type
(`/api/projects/:id/type/read`), takes the bootstrap from
`/api/projects/:id/type/bootstrap`, and embeds `pageApiShimSource` after the
log shim and before any page script, so `window.gezel` behaves exactly as on
the desktop. The parent relay in `HtmlPreviewFrame` answers it through the
phone's own `page-invoke` / `page-read` routes
([runtime/project-type-routes.ts](../packages/core/src/runtime/project-type-routes.ts)),
which enforce `pages.tools` and `pages.reads` with the same core rules as the
desktop (`projectTypePageTools`, `pageReadIsDeclared`). Workspace and
artifact snapshots stay closed to the bridge.

What this means for authors:

- **Only v1 pages run on phones.** A v0 page reads its project from the
  preview URL, which a snapshot does not have; WebKit refuses the URL rewrite
  that could fake one. The phone says the page has not been updated rather
  than showing its demo data as if it were the project's.
- **`data.url()` works, a moment late.** There is no capability URL, and the
  snapshot CSP allows only `data:` media, so on a phone the call returns a
  blank image tagged with the file. The shim reads the bytes over the relay
  and swaps a `data:` URL in wherever the tag sits in a `src`, `poster`,
  `href` or `style` attribute, and later calls for the same file return the
  `data:` URL directly. An element never attached to the document (a bare
  `new Image()`) is not swapped, and a file over the relay's read cap (2 MiB)
  stays blank and logs an error. Use `data.read(path, { as: 'bytes' })` when
  the page needs the bytes themselves.
- **Design for 320px.** The phone viewport is 320–400 CSS px wide. A page must
  not scroll sideways, and controls should be at least 44px tall.
  `pnpm mobile:test:pages` opens every type's page at 320px and 390px in
  Chromium and WebKit, fails on horizontal overflow, script errors and v0
  pages, and reports small touch targets (`--strict` fails on them).
  `GEZEL_GILDE_DATA_DIR` points it at a gilde checkout under review.

## Compatibility

The v0 sentinels (`__gezelPageInvoke` / `__gezelPageResult` /
`__gezelPageRefresh`) and the out-of-band capability fetch for `pages.reads`
are permanent: shipped catalog page versions hard-code them. The host
relays both generations side by side; the v1 shim ignores v0 replies and
vice versa. New pages should set `pages.api: 1` in the manifest (routes
gilde lint; serving does not branch on it) and use `window.gezel`
exclusively.

## Writes

There is deliberately no raw write API. Pages mutate state only through
declared script tools — auditable (`ScriptRun` + history events),
bind-pinned, rate-limited, reaction-capable, and provenance-trusted on
platforms without an OS sandbox boundary. For generic record CRUD, vendor
the `storeRecords` stdlib script (`packages/script-stdlib/scripts/`) into
the type manifest and expose `bind`-pinned tool names for exactly the
operations the page needs.

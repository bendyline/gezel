# Output Pane API (`window.gezel`)

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

Served type pages find a frozen `window.gezel` defined before any page
script runs:

```js
gezel.page      // { api: 1, projectId, source: 'type', entry, typeName, params, mode }
gezel.tools     // { list(), invoke(tool, input?) }
gezel.data      // { read(path, opts?), list(path, opts?), watch(path, cb, opts?), url(path, opts?) }
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
| `demo` | Raw file, no server | page-supplied handlers | page-supplied handlers |

`demo` is not produced by the injected shim — a raw double-clicked file has
no server. Gilde ships a canonical ~40-line stub (`authoring/page-demo-stub.js`)
that pages paste verbatim; it defines `window.gezel` only when the real one
is absent, wiring `tools.invoke`/`data.read` to page-supplied demo handlers.
Pages keep their demo *logic*; all transport switching dies.

## Reading data

```js
const game = await gezel.data.read('game.json');            // parsed JSON (by extension)
const notes = await gezel.data.read('notes.md');            // string
const bytes = await gezel.data.read('media/a.png', { as: 'bytes' });  // Uint8Array
const posts = await gezel.data.list('posts');               // [{ name, kind, size, mtime }]
const stop  = gezel.data.watch('posts', ({ path, etag }) => rerender());
const src   = gezel.data.url('media/hero.png');             // for <img src>, media elements
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
page → host: { __gezelPage: 1, kind: 'hello' | 'invoke' | 'read' | 'watch' | 'unwatch' | 'refresh', ... }
host → page: { __gezelPage: 1, kind: 'init' | 'result' | 'read-result' | 'change' | 'theme', ... }
```

- The shim (`packages/service/src/http/routes/page-api-shim.ts`) is
  injected by `preparePreviewHtml` for `source === 'type'` responses only,
  with a server-authoritative bootstrap (identity, params, declared tools).
- The host relay lives in the UI's `HtmlPreviewFrame`. Reads relay to
  `POST /api/projects/:id/page-read` (first-party auth; scopes re-derived
  via `resolvePageReads`); invokes relay to the existing
  `POST /api/projects/:id/page-invoke`.
- Identity, not origin, authenticates both directions: the iframe is
  sandboxed without `allow-same-origin` (opaque origin), so the shim
  requires `event.source === window.parent` and the relay requires
  `event.source === frame.contentWindow`. No bearer ever enters the frame.

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

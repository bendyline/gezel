# Page libraries

A page a gezel writes can use three.js, Chart.js, React and other libraries
with no network: the preview loads them from a shelf on this computer. The
page is written the ordinary way, by npm name or CDN address, and nothing in
it is Gezel-specific. Decision and alternatives:
[ADR 0034](decisions/0034-page-libraries.md).

**Status.** Built: the shared resolver and desktop swap, the shelf store,
the Gilde `page-library` kind, downloads on first use, the Settings card,
model guidance, export, modules over plain-script builds (React 18, D3) and
over CommonJS files (React 19),
inline JSX, and phones. Not yet live for anyone: the bundled catalog has no
`page-library` items until a Gilde release carries them and the pins move
(see "Releasing" below).

## What a page may write

| Spelling | Answered by |
| --- | --- |
| `import * as THREE from 'three'`, `'three/addons/…'`, `import('chart.js/auto')` | The page's import map |
| `<script type="importmap">` pointing at unpkg, jsDelivr or esm.sh | Rewritten and merged into the one map |
| `<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js">` | The attribute is rewritten; `integrity` is dropped |
| `<link rel="stylesheet" href="https://cdn…">` | The attribute is rewritten |
| `import x from 'https://esm.sh/react@19'` in a module | The address is rewritten |
| `<script type="text/babel">` (also `text/jsx`, `text/tsx`) | Compiled where the page is served; the Babel tag is dropped |
| `.jsx`/`.tsx` modules | React's automatic JSX runtime, as Vite compiles them, unless the file imports Preact or names a global `React` |

Known hosts: unpkg, jsDelivr (`/npm/`, `+esm`), esm.sh, esm.run, Skypack,
JSPM, cdnjs, plus whole addresses a line lists (`d3js.org/d3.v7.min.js`). An
address the shelf does not answer is left alone and loads or not under the
page's network policy, as before.

## One address per file

Every spelling of a file resolves to

```
/preview/<capability>/lib/<library>/<version>/<path inside the package>
```

and the route never redirects. A browser keys a module by the URL it asked
for; two addresses for one file would run the library twice on a page (two
`THREE.Vector3` classes, a React with two sets of hooks). The integration
test asserts the identity across spellings, and a real page check asserts
`THREE.Vector3 === ByUrl.Vector3`.

The route is authorized by any live preview lease (`authorizeLease`), serves
only files the line's marker lists, and uses the preview's own headers, so it
is the page's origin for the strict CSP, "Open in browser", the agent's
local-only browser and the page check. It is not a `PreviewSource`.

## Lines

A **line** is one pinned release of a library (`PageLibraryLineSchema`,
[schemas/page-library.ts](../packages/core/src/schemas/page-library.ts)):

- `source`: the npm package, exact version and tarball SHA-256.
- `include`: the files and folders taken from the package. Nothing else is
  installed.
- `module`, `classic`, `style`: the forms a page can load it in, each mapping
  requests (`.`, `./addons/`) to files. `default` marks the line that answers
  a request naming no version.
- `answers`: the requested versions it answers (`from`, `before`).
- `packages`: npm names a page imports it by.
- `paths`, `cdnjs`, `urls`: other spellings of its files.
- `requires`: bare imports its own files make of other libraries.
- `globals`: modules made from a plain-script build, for a library that
  publishes no browser module (React 18, D3 7). Each request is a small
  module the shelf writes at `_gezel/<request>.js`
  ([globals.ts](../packages/core/src/pages/globals.ts)): it loads the build,
  then exports its global's names. `after` loads other libraries first (React
  DOM reads React's global); `jsxRuntime` writes React's JSX runtime instead.
- `commonjs`: modules made from a CommonJS file, for a library that publishes
  neither a browser module nor a plain-script build (React 19). The shelf
  writes a module that runs the file, as published and hash-checked, inside
  a function, answers its `require` calls from `imports` (bare imports of
  this line or the ones it `requires`), and exports `exports`. A linker (the
  single-file export, phones) takes the file itself. The seeding script
  checks the file's `require` calls and `exports.NAME =` assignments against
  the spec, reading the text without running it.
- `license`, `notice`.
- `hosts`: `desktop`, `phone`. A library that needs `eval` or workers (Vue's
  full build compiles templates with `new Function`) stays desktop-only.
- `phoneRequests`: the requests a phone build carries when not every file
  request, and single files inside a folder request
  (`./addons/controls/OrbitControls.js`).

**Picking a line.** The form the page loads decides first (a plain `<script>`
needs a `classic` form), then the version in the spelling, then the default.
A version no line answers falls to the default and the page gets a
`console.warn` (never an error: the page check must not fail a working page).

**Requires must be declared.** A line's module files may import only the
line's own packages and what it lists in `requires`; the import map's
`scopes` send those to the right line. The seeding script refuses a line that
breaks this.

## The shelf on disk

```
~/.gezel/page-libraries/<library>/<version>-<sha12>/
    .gezel-page-library.json     the line, and every file's SHA-256
    build/three.module.js …      the package's files, byte for byte
```

Owned by `PageLibraryStore`
([inference page-libraries/store.ts](../packages/inference/src/page-libraries/store.ts)).
It reads the home's folder first, then any folders in
`GEZEL_PAGE_LIBRARIES_DIR` (separated like `PATH`): libraries that ship with
the app. Files are never rewritten. A file is hashed against its marker the
first time a process serves it and refused if it differs. Regenerable, safe
to delete, counted under "Tools and browsers".

## The catalog and downloads

Lines come from the Gilde `page-library` kind: one item per library, its
lines in the version manifest (`PageLibraryManifestSchema` in
[schemas/catalog.ts](../packages/core/src/schemas/catalog.ts)). Gilde's
validator checks the license (MIT, ISC, BSD, Apache-2.0), the entries against
`include`, and the `globals` and `commonjs` files.

`PageLibraryManager`
([inference page-libraries/manager.ts](../packages/inference/src/page-libraries/manager.ts))
installs a line from the npm registry, checking the tarball against its pin
and taking only `include`, with one download per line at a time. Nothing
downloads from a preview `GET`. The callers ask what a page needs
(`POST /api/projects/:id/page-libraries/needs`), which collects the page's
spellings, downloads what is missing and saves the project's pins:

| Caller | Waits | When a library is still downloading |
| --- | --- | --- |
| The preview frame | 60 s | Reloads when it arrives |
| The page check | 15 s | `ran: false`, `reason: 'page-libraries-pending'`, never a failure |
| `validate` | 10 s | Says so in the result |
| A task whose steps declare `libraries` | none | Prefetched at task creation |

Who may download ([page-libraries/service.ts](../packages/service/src/page-libraries/service.ts)):

- **Store builds never do** (`allowPageLibraryDownloads` in the distribution
  profile). They ship a fixed set: release-mas and release-msix stage
  `seed-page-libraries.mjs --out packages/app/dist/page-libraries`,
  electron-builder ships it as `Resources/page-libraries`, and main stamps
  `GEZEL_PAGE_LIBRARIES_DIR` (`stampPageLibrarySeed`).
- **Automatic downloads** need App network in the security policy and
  `config.pageLibraries.autoDownload` not `false` (Settings → More settings
  → Page libraries).
- **A person's install** from that card runs at any security level.

Session tokens may ask what a page needs; they cannot install, remove or
export (`/api/page-libraries/*` and `/pages/export` are refused in
[scope-guard.ts](../packages/service/src/http/scope-guard.ts)).

**Project pins.** The lines a project's pages resolved are kept in
`projects/<id>/page-libraries.json` through `Store`, so moving a default in
the catalog never changes a page that already works.

## What models are told

One generated note, `pageLibrariesNote`
([note.ts](../packages/core/src/pages/note.ts)), lists only the libraries
that resolve on this host, and only to a turn that can write files. Plain
JavaScript stays the default. A craftbook step may declare
`libraries: ['three']`: the task prefetches them and the step prompt names
them. A page naming a library that does not resolve gets a message listing
what is available. The bans ("no frameworks, no CDN") are gone from the
runtime prompts. Fifteen interactive-page books were revised to allow a
listed library where it clearly helps (Gilde `tools/migrate-page-libraries.mjs`);
the chart books and canvas-generative-art name theirs on the step. Books where
plain, self-contained code is the point keep their wording: web-component,
feedback-widget, the decks and ebook, the email digest, the static sites, and
html-arcade-game, whose contract refuses any remote script address.

## Export

`POST /api/projects/:id/pages/export` (`format: folder | single`), the Output
pane's Export…, and `gezel page export <project> <path> <out> [--single]`
([pages/export.ts](../packages/core/src/pages/export.ts)):

- **Folder** (a zip): the page's files with TS and JSX compiled, the library
  files the page reaches under `lib/`, a relative import map, and
  `LICENSES.txt`. For a web server: browsers refuse modules from `file://`.
- **Single file**: modules linked into one script at the end of `<body>`,
  plain-script builds run before it, assets inlined as data addresses,
  licenses in a comment. Opens by double-click. Capped at 64 MiB.

## Phones

A phone cannot download, so the app bundles the lines marked for phones
([mobile scripts/page-libraries.ts](../packages/mobile/scripts/page-libraries.ts)).
Its build reads a staged shelf (`GEZEL_PAGE_LIBRARIES_DIR`, else
`packages/mobile/page-libraries`, git-ignored), checks every file's hash,
precompiles each module file with the preview compiler, and emits two
modules: the lines alone (17 KB, loaded at boot, for the prompt) and the
files (3.8 MB for the current set, loaded by the first preview that uses a
library). The snapshot builder
([html-preview.ts](../packages/mobile/src/html-preview.ts)) embeds what a
page uses, reads an authored import map rather than running it, and compiles
inline JSX. A phone with no staged shelf carries none and its prompt says npm
packages do not load, as before.

```
node scripts/seed-page-libraries.mjs --out packages/mobile/page-libraries --phone
```

Phone lines today: three 0.187 (`three` and OrbitControls), Chart.js, D3,
React and React DOM 19 and 18, Preact, htm.

## Embedding apps (DocBlocks)

An app that lets a model write pages uses the same module and catalog. It
needs `@bendyline/gezel/pages` and a shelf, not the daemon:

- **With a local server**, rewrite each page with `rewritePageLibraries`
  against the app's own file route, as the desktop preview does.
- **Without one** (an embedded host), build one self-contained page with
  `exportPageSingleFile` and a `PageExportSource` over the app's files and
  shelf, and show it in a sandboxed frame that may run scripts. This is the
  phone's shape.
- Stage the shelf at build time with `seed-page-libraries.mjs --out`, read
  it with `PageLibraryStore`, and name what it carries with
  `pageLibrariesNote`, so the model and the shelf agree.

## Shared code

`@bendyline/gezel/pages` is dependency-free:

| Module | Does |
| --- | --- |
| [resolver.ts](../packages/core/src/pages/resolver.ts) | CDN grammar, version ranges, spelling → line and file |
| [import-map.ts](../packages/core/src/pages/import-map.ts) | The page's map; merging an authored one |
| [html-rewrite.ts](../packages/core/src/pages/html-rewrite.ts) | Locates `<script>`/`<link>` by offset; rewrites addresses |
| [collect.ts](../packages/core/src/pages/collect.ts) | What a page and its modules ask for; pins |
| [note.ts](../packages/core/src/pages/note.ts) | What a model is told |
| [export.ts](../packages/core/src/pages/export.ts) | Folder and single-file export |
| [globals.ts](../packages/core/src/pages/globals.ts) | Modules over plain-script builds |
| [jsx.ts](../packages/core/src/pages/jsx.ts) | Inline JSX, Babel's tag |
| [phone.ts](../packages/core/src/pages/phone.ts) | What a phone build carries |

The host hands in the import scanner (`scanPreviewModuleImports` in
script-runtime, which reads the syntax tree: the compiler's text scan misses
imports in minified code) and serves the files. The desktop wiring is in
[routes/preview.ts](../packages/service/src/http/routes/preview.ts).

## Seeding a shelf (development)

```
pnpm build
node scripts/seed-page-libraries.mjs --home ~/.gezel-dev --gilde ../gilde/data
node scripts/seed-page-libraries.mjs --home <dir> --only three,chart.js
```

One of `--home` or `--out` is required. Lines come from `--gilde`, else
`GEZEL_GILDE_DATA_DIR`, else the pinned `@bendyline/gilde`. The script
refuses a line whose module files import a package it does not declare.

Current lines: three 0.187 (module) and 0.128 (plain script and module),
Chart.js 4, D3 7, React and React DOM 19 (module) and 18 (plain script and
module), Preact 10, htm 3, Vue 3, plus scheduler and @kurkle/color, which only
other libraries load. An unversioned `import 'react'` gets 19; a plain
`<script>` gets 18, the last React with such a build. React DOM 19 refuses any
other React, so its line requires React 19.3.1 exactly.

## Releasing

Until Gilde ships the kind, the bundled catalog has no page libraries and
nothing downloads. In development, run the daemon with
`GEZEL_GILDE_DATA_DIR=../gilde/data` (or `pnpm link:gilde`). To ship:

1. `pnpm gilde:export-schemas`, then Gilde's `npm run fix && npm run check`,
   and the Gilde PR with `data/page-libraries/`, the schemas, and the craftbook
   versions `tools/migrate-page-libraries.mjs` wrote.
2. After the pipeline publishes, bump the `@bendyline/gilde` pins in
   `packages/service/package.json` and `packages/catalog/package.json`.
3. Store builds and phones stage their shelves from the new pins.

## Limits today

- Module workers get no import map; a worker importing a library by name
  fails.
- A plain script over 512 KB is not scanned for CDN imports.
- Phone releases do not stage their shelf yet: `pnpm mobile:package` and
  mobile CI build without one.

# TypeScript and modules in workspace previews

A gezel that builds a web page or game writes it the way its own tools would:
TypeScript files that import each other, an `index.html` that loads the entry
with `<script type="module" src="./src/main.ts">`. Opening that page in the
app's preview runs it as written, on the desktop and on phones. No build step,
no dev server, no `localhost`.

## One reading of an import

Both hosts resolve an import with `resolvePreviewImport` in
[core/preview/modules.ts](../packages/core/src/preview/modules.ts), so a page
behaves the same on either:

- `./tank` tries `tank.ts`, `tank.tsx`, `tank.js`, `tank.mjs`, `tank.jsx`,
  `tank.json`, then `tank/index.*`.
- `./tank.js` falls back to `tank.ts` (TypeScript's own convention), `.mjs` to
  `.mts`, `.jsx` to `.tsx`.
- A root-absolute source (`/src/main.ts`, as Vite writes it) means the page's
  own folder.
- An npm package, a URL, or a path above the previewed folder is refused, with
  a message naming the file that made the import (`previewImportProblem`).

Files are compiled by `compilePreviewModule` in
[script-runtime/preview-module.ts](../packages/script-runtime/src/preview-module.ts):
types are stripped, never checked, so a type error never keeps a game from
running. A syntax error is reported with its file, line and column. Imports
are read from the compiled output, so a type-only import of a file that does
not exist is not a dependency.

## Desktop: compiled as served

The preview server ([routes/preview.ts](../packages/service/src/http/routes/preview.ts))
compiles a `.ts`/`.tsx`/`.jsx` file when the browser asks for it and serves it
as JavaScript. Each import is rewritten to the exact file it names, because the
browser keys modules by the URL requested: `./tank` and `./tank.ts` would
otherwise run the same module twice. A script request spelled the way an
import is (`src/engine`, a folder) redirects to the file it names; a page
request keeps static-host 404s. A `<script src="x.ts">` becomes a module.

A module that cannot run (a missing file, an npm package, a syntax error)
serves a small script that puts the reason on the page and in the preview log,
instead of a blank frame. For an npm package it adds that an app that builds
with npm can be built and its `dist/index.html` previewed.

## Phones: linked into the snapshot

A phone has no server. Its preview is a single snapshot page whose scripts are
`data:` URLs, under a CSP with no network and no access to the app
([html-preview.ts](../packages/mobile/src/html-preview.ts)). A `data:` URL has
nothing to resolve a relative import against, so the files cannot import each
other there. Instead the preview builder walks the import graph a round at a
time, compiles each file to CommonJS, and links them with
`bundlePreviewModules` into one classic script, deferred so it runs once the
page is parsed, as a module would. Each module runs once on first import; an
entry that throws is reported and the next still runs.

- The compiler runs in the existing script-compiler worker
  ([script-compiler-worker.ts](../packages/mobile/src/script-compiler-worker.ts)),
  held open for one preview so TypeScript loads once. A second worker bundle
  would ship a second ~9 MB copy of the compiler.
- JSON imports become data, stylesheet imports become `<style>` elements with
  their `url()`s embedded, and image or font imports become their `data:` URL.
- `await` outside a function is refused with its place: a linked module runs
  inside a plain function, where it is a syntax error.
- The snapshot's existing limits apply: 64 files, 2 MiB each, 16 MiB in all,
  8 MiB once embedded, and nothing outside the previewed page's folder.

Covered in a real browser under the snapshot's CSP by
`packages/mobile/scripts/test-html-preview.mjs`.

## Telling the model

A phone's prompt carries `IN_APP_WEB_PREVIEW_GUIDANCE`
([prompt/web-preview.ts](../packages/core/src/prompt/web-preview.ts)): pages
run by opening their HTML file in the app, there is no server, terminal or npm,
write `index.html` with a module script, never tell the person to open
`localhost`. It replaces the desktop's browser-automation guidance in the
llama.cpp prompt and is appended to the system models' short prompt when the
gezel can write files.

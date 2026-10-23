# Building Gezel apps

For file explorers, reuse `gezel.ui.components.fileCard` and `fileAdder` rather
than rebuilding file tiles and upload controls. Declare `pages.imports` targets
and `pages.reads` separately, honor workspace write policy, and refresh after
successful imports. Follow the [component and import contract](handboek/technical/gezel-page-apis.md#file-cards-and-adding-files),
including its in-memory standalone demo adapter and cleanup lifecycle.

The host runtime is `packages/core/src/project-types/page-components.ts`.
After changing it or the demo adapter, run `pnpm pages:sync-components` to refresh
Gilde's shared preview assets under `authoring/`. No app source carries a runtime
copy. The Handboek exporter writes one content-hashed bootstrap and typography
asset set for all website demos. `gezel app demo <source> --out <new-directory>`
exports a private app with the same assets for offline use; open the generated
entry under `pages/`. Gilde's `npm run demos` injects them during local
preview; `npm run export-page-demo -- <id> --out <new-directory>` creates an
offline catalog demo.
Run `pnpm test:e2e:page-components` for hosted/component tests; set `GILDE_DIR`
to the content checkout to also test Media Library and Data Analysis demos.
New manifest fields require `pnpm gilde:export-schemas` and Gilde validation.

Start here when a request combines a custom interface, a crew, craftbooks, and
project setup. A **Gezel app** is the experience; a **project type** is its reusable
composition; a **project** is one person's instance. A `.gezapp` is a distribution
package for that composition. A page-only folder explorer is also a valid app:
include only the parts the experience needs.

## Read in this order

| Need | Maintained guide |
| --- | --- |
| Build an app, including roles, craftbooks, scripts, data, and project defaults | [Building AI Apps inside Gezel](handboek/technical/building-ai-apps-inside-gezel.md) |
| Build its browser interface and connect it to project files and tools | [Using the Gezel page APIs](handboek/technical/gezel-page-apis.md) |
| Understand injected CSS, fonts, theme, layout, and accessible controls | [Gezel app page style guide](handboek/technical/gezel-app-page-style-guide.md) |
| Look up exact page methods, permissions, modes, limits, and error codes | [Output Pane API reference](output-pane-api.md), [TypeScript declarations](../packages/sdk/src/page.ts) |
| Look up composition, adoption, upgrades, and `.gezapp` formats | [Project-type specification](project-types.md) |
| Write a deterministic action or gate | [Script SDK guide](handboek/technical/writing-scripts-with-gezel-sdk.md) |
| Start from a complete, tested source folder | [Sample apps](../examples/apps/README.md) |
| Share an app page outside the desktop shell | [App-serve](app-serve.md) |

The three Handboek guides above are public documentation sources: the Handboek
export publishes them to the website, and the bundled Handboek makes them
retrievable by gezellen. Keep authoring instructions there; this page is the
repository entry point, not another copy of the tutorial.

## Choose the implementation home

- **Public catalog content:** author in the sibling `gilde` repository's `data/`
  tree. Read its `AGENTS.md` and `docs/page-authoring.md`. Do not add catalog
  content to Gezel's old `data/` path or edit installed `node_modules`.
- **Private or portable app:** author a `gezapp.json` + `items/` source folder;
  `gezel app new <id> --with-page` supplies the initial shape.
- **Missing shared capability:** extend Gezel's service/client/page bridge/SDK
  once, with permission tests and API documentation, then consume it from the
  app. Do not put daemon tokens, direct filesystem access, DuckDB subprocesses,
  or a second transport bridge into a page.
- **External application with its own process/UI:** use the separate
  [connected-app SDK](handboek/technical/building-connected-apps-with-gezel-app-sdk.md).

Content and runtime releases are separate. Test a Gilde checkout with
`GEZEL_GILDE_DATA_DIR` pointing at its `data/` directory and regenerate its local
indexes. Respect the checkout's dependency policy before using `pnpm link:gilde`.
The normal installed app still consumes its pinned/released catalog. Call out
that distinction when handing over an app that exists only in the checkout.

## What a completed app change includes

Deliver the composition and every referenced payload, a short account of data
ownership and permissions, working empty/error/demo states, and verification of
the main user action against a real host. A screenshot of sample data alone is
not evidence that file access, writes, or queries work. Use the completion
checklist and reusable LLM brief in the public authoring guide.

The CLI scaffold has contract tests for source validation, packaging, page/model
tool audiences, and generated demo bootstrap delivery. Run `pnpm test:e2e:scaffold`
from this repository to check the generated page against the real page shim,
shared typography, and a temporary service installation, including both page
and keeper actions. It uses the existing built service and installed Playwright
Chromium; it does not require a shell UI build. The same spec also runs with the
full web suite. See [the browser tests](../packages/app/e2e-web/app-scaffold.spec.ts)
when extending the scaffold's behavior.

Known authoring gaps and proposed platform improvements are recorded separately
in the [app platform review](gezel-app-platform-review.md). Proposals there are
not APIs authors may assume exist.

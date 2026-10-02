# Office and LibreOffice integrations

Engineering reference. The decision and its alternatives are in
[ADR 0016](decisions/0016-office-host.md); folder-to-project mapping is
[ADR 0015](decisions/0015-project-inference.md); the user-facing story is
the Handboek's Connected Apps article.

## Pieces

| Piece | Where |
|---|---|
| Office CA + leaf | `packages/service/src/office-host/tls-identity.ts` |
| Office listener (full product app, stable port) | `packages/service/src/office-host/listener.ts`, `http/local-bridge-port.ts` (`officeHostPortForHome`) |
| `/office/*` pages and their CSP; framing rule for `/?embedded=chat` | `packages/service/src/office-host/static-routes.ts`, `http/server.ts` |
| Same-origin registration | `packages/service/src/http/routes/v1-apps.ts` (`isOfficePaneRequest`) |
| Code-free grants for Gezel's add-ins (ADR 0018) | `packages/service/src/grants/first-party-apps.ts`; `/v1/apps/office/enroll` and `/v1/apps/local-connect` in `v1-apps.ts` |
| Daemon wiring (listener, both setup managers, boot and shutdown) | `packages/service/src/office-host/integrations.ts` |
| Setup state, manifests, detection | `packages/service/src/office-setup/{manager,manifest,detect}.ts` |
| LibreOffice setup state | `packages/service/src/libreoffice-setup/` |
| Routes | `/api/office-setup` (GET, PUT, DELETE, POST `/host-report`), `/api/libreoffice-setup` (same) |
| Client methods | `client.officeIntegrations` (`packages/client/src/office-integrations.ts`) |
| OS steps (trust store, Office registration, unopkg) and their IPC | `packages/app/src/office-integration/` (`ipc.ts` registers the handlers) |
| Settings cards | `packages/ui/src/components/{Office,LibreOffice}SetupCard.tsx` |
| Office task pane | `packages/ui/office-pages/*.html`, `packages/ui/src/office/`, `packages/ui/vite.office.config.ts` |
| LibreOffice extension | `packages/libreoffice-extension/` |

## Office pane boot contract

1. `office.js` loads from Microsoft's CDN; `history-guard.js` runs first and
   the pane restores `history.pushState`/`replaceState` after `Office.onReady`.
2. Token: `localStorage['gezel:office:token']`, probed with `GET /api/config`.
   None or revoked → `POST /v1/apps/office/enroll` with the key from the
   page's `?enroll=` parameter (`OFFICE_ENROLL_PARAM`), which returns the
   shared `office` grant; the pane drops the key from its address once it has
   a token. No key, or a refused one → `POST /v1/apps/register`
   (`appId: office`, `scopes: ['product']`, same-origin) → show the code →
   long-poll `GET /v1/apps/grant/:id?wait=30`. See
   [ADR 0018](decisions/0018-local-add-in-grants.md).
3. Project: `POST /api/projects/infer-for-path` with the document path from
   `Office.context.document.url` (none for unsaved or cloud documents).
4. Gezel: remembered for this document (localStorage, keyed by path, never in
   the document), else the project lead, a member, the Meester, anyone.
5. The pane mints a surface id (one per pane), writes the token to
   `gezel:token`, and frames
   `/?embedded=chat&compact=1&projectId=…&gezelId=…&appSurface=…`; the SPA
   seeds the recipient from `gezelId`, and its API client sends every request
   with the surface id in `x-gezel-app-surface`
   (`packages/ui/src/embedded/app-surface.ts`).
6. The pane registers its tools through the app-tool relay (ADR 0013) for the
   project, **the chosen gezel only** (`gezelIds`), and **its own chat only**
   (`surfaceId`). A session is offered the tools while its latest message
   from a person came through that surface, so the same gezel's other
   threads — the Meester's front-door chat in the desktop app when the pane
   talks to the Meester, background work, another document's pane — never
   get a live document writer, and a thread the pane shares with the desktop
   app loses them when someone writes to it from there. Changing the gezel
   re-registers (the LibreOffice panel re-publishes the scope, and stamps its
   own chat's sends the same way). The pane re-publishes on the edits switch,
   including a switch made while the relay was still connecting, and closes
   the relay on `pagehide` (keepalive DELETE).
7. Copilot, Claude CLI and Codex CLI run their own tool loop and never receive
   app tools (`providerUsesManagedMcpBridge`). When the chosen gezel resolves
   to one of them (its own provider, else the install default from
   `/api/config`), the pane says so in one line under its header instead of
   claiming the gezel can read the document.

## Tool catalogue (shared by both suites)

| Tool | Hosts | Writes |
|---|---|---|
| `office_describe_document`, `office_read_selection` | all | no |
| `doc_read_selection`, `doc_read` (paragraph pagination), `doc_search` | Word, Writer | no |
| `doc_insert_text`, `doc_replace_selection` (`plain` or `markdown`) | Word, Writer | yes |
| `doc_insert_diagram` (Mermaid source, drawn as a picture) | Word (WordApi 1.2) | yes |
| `sheet_list`, `sheet_read_selection`, `sheet_read_range`, `sheet_describe_table` | Excel, Calc | no |
| `sheet_write_range` | Excel, Calc | yes |
| `slides_list`, `slide_read` | PowerPoint, Impress | no |
| `slide_insert` | PowerPoint, Impress | yes |

Caps: results clip at 60,000 characters (under the relay's 80,000); reads and
writes touch at most 5,000 cells (an oversized read is answered with the
range's size, before any values load); inserts carry at most 50,000
characters. Write tools are withdrawn, not refused, while edits are off; a
tool whose Office.js requirement set is missing is never offered. Names are
host-prefixed because `read_document` and `describe_table` are built-ins.

Word markdown nests lists by indentation (`markdown-to-html.ts`) and draws a
```` ```mermaid ```` fence the same way `doc_insert_diagram` does
(`packages/ui/src/office/diagram.ts`): Mermaid renders in the pane with SVG-text
labels (WebKit will not export a canvas that drew `foreignObject`, and Word's
SVG import drops it), the SVG is rasterized to a 2x PNG on white, and the PNG
replaces a placeholder paragraph inserted with the HTML, so text and pictures
keep their written order wherever the insert lands. Every diagram is drawn
before anything is inserted: one Mermaid cannot parse fails the call with
Mermaid's message and leaves the document untouched. Mermaid is a lazy chunk
of the pane bundle, fetched the first time a diagram is drawn. Writer keeps
mermaid fences as code.

## Manifests

One XML add-in-only manifest per app, generated by the daemon under
`<home>/integrations/office/manifests/`: `TaskPaneApp`, a GUID per app kept
for the life of the home, the product version padded to four parts,
`ReadWriteDocument`, base requirement set 1.1, a Home-tab button
(`ShowTaskpane`), icons under `/office/icons/`. The task-pane URL carries the
setup's enrollment key, so manifests are owner-only: 0600 files in a 0700
folder, and the macOS copy in Office's container is chmodded 0600. The key
lives in `setup.json`, is added to older records by reconcile, and rotates
only when the setup is removed (which also revokes the `office` grant). A
changed manifest (new version, port, or key) resets that app's registration
to "not reported", and the desktop app re-copies it on macOS at its next
launch.

## Testing

- Unit: `project-inference` (core), `office-host`, `office-setup`,
  `libreoffice-setup`, `v1-apps` (service), `office-integration` (app),
  `src/office` and the two cards (UI), `test` + `test:py` (extension).
- `tests/published/bundledAssets.test.ts` guards `dist/office` and
  `dist/libreoffice/gezel.oxt`.
- End to end with Office: Settings → Connected Apps → set up Word; restart
  Word; Home → Gezel; the pane connects without a code (a code here means the
  key did not arrive: check the page URL for `?enroll=`); ask for a summary
  of the selection and watch for a `doc_read_selection` call. On macOS the
  first open is Home → Add-ins → Gezel instead: Word parses a sideloaded manifest
  (`ContainsAppCommands: true` in its diagnostics log) but adds no ribbon
  button until the add-in has been opened from that menu once. The setup
  card says so in a dialog after a Mac setup.
- LibreOffice: the manual recipe in `packages/libreoffice-extension/README.md`.

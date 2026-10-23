# Gezel

Gezel is a local-first desktop app for assembling a **team of AI agents** — gezels — and putting them to work. The name is Dutch for "companion" or "journeyman." Everything the user creates lives on their disk, talks to whichever LLM provider they point it at, and is inspectable as plain files. No cloud service of our own stands between them and the model.

One of the other main value propositions of gezel is to simplify AI and make it accessible to all people, not just technical people. The name "gezel" is an example of this in itself: users work with gezels (craftsmen) rather than the cold and technical "agents". This project is a relentless pursuit to simplify AI and make "the good parts" accessible to all.

This document is for anyone (human or AI) extending gezel. It captures the mental model, the layering, and the conventions that aren't obvious from the directory structure alone.

For UX philosophy and the visual direction the app is heading — read [docs/ux.md](docs/ux.md) before touching UI.

## Building Gezel apps

For requests to build a custom app, dashboard, project experience, crew, or
craftbook-backed workflow, start with [Building Gezel apps](docs/building-gezel-apps.md).
Read its public [authoring guide](docs/handboek/technical/building-ai-apps-inside-gezel.md),
[page API guide](docs/handboek/technical/gezel-page-apis.md), and
[page style guide](docs/handboek/technical/gezel-app-page-style-guide.md) before implementing.

A Gezel app is composed by a project type; its page, roles, craftbooks, scripts,
and project defaults are optional parts chosen for the user flow. Public catalog
content belongs in sibling `gilde`; private apps use a `gezapp.json` + `items/`
source folder. Extend the shared runtime only when a reusable capability is missing.
Pages use `window.gezel` ([API reference](docs/output-pane-api.md)), inherit the
host's fonts, and own their remaining CSS. Do not copy font assets or build a
private filesystem/query bridge. Specify data ownership and permissions first,
validate against the current schemas, and test a real host flow as well as the demo.
Report the catalog release/install step separately from source-code completion.
Reuse `gezel.ui.components.fileCard` / `fileAdder` for file interfaces; declare
`pages.imports` for scoped uploads and keep `pages.reads` explicit. Never bypass
workspace write policy. Let the demo publisher/exporter inject the shared bootstrap and fonts; never
copy platform assets into app source. Reset in-memory imports, and test the
live relay as well as generated demo controls.
These linked guides are the maintained authoring contract; proposals in the
[platform review](docs/gezel-app-platform-review.md) are not available APIs.

## The soul of gezel

Three ideas are load-bearing:

1. **Gezels are warm, named characters, not chat sessions.** Each gezel has a name, a role, a distinct abstract SVG icon, and an `about.md` that becomes their system prompt. They feel like members of a crew you're putting together. The UX is oriented around that crew, not around a "new chat" button.

2. **Local-first, files-all-the-way-down.** State lives under `~/.gezel/` (or `$GEZEL_HOME`) as ordinary files you can `cat` and `grep`. `gezel.md` holds frontmatter + sections; `about.md` is prose; sessions are JSON; memories are daily markdown + a sqlite-vec index. If you ever want to understand what the app believes, `ls` is your friend.

3. **The Meester is the front door.** The first gezel every user meets is the **Meester** — a guildmaster/concierge figure whose job is to help the user figure out which other gezels they need and to spin them up. They have MCP tools for the job. This is deliberately not a generic "AI assistant" — it's a character with a role.

## Runtime shape

```
┌─────────────────────────────────────────────────────────────┐
│  Electron shell (packages/app)                              │
│   ├─ BrowserWindow → React UI (packages/ui)                 │
│   └─ Supervisor — resolves hosting + connects via HTTP      │
└──────────────────────────────┬──────────────────────────────┘
                               │ 127.0.0.1:<port>
                               │ bearer token, loopback TLS
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  gezeld  (@bendyline/gezel-service)                         │
│   ├─ Hono HTTP API                                          │
│   ├─ Store (fs) — reads/writes GEZEL_HOME                   │
│   ├─ ChatManager — owns sessions + provider routing         │
│   ├─ Providers (Copilot, OpenAI, Anthropic, llama.cpp, …)   │
│   │    └─ per-session MCP bridge (stdio → mcp server)       │
│   └─ UsageTracker / MemoryManager / TaskRunner              │
└─────────────────────────────────────────────────────────────┘
```

**Production (packaged installs) hosts `gezeld` as a machine-wide system service by default on Windows, macOS, and Linux.** Windows registers `GezelService` (hosted by the first-party `gezel-service-host` helper) under a least-privileged LocalService identity with a dedicated per-service SID and system-scope home at `C:\ProgramData\Gezel\`; macOS installs `com.bendyline.gezeld` under `/Library/Application Support/Gezel/`; Linux installs `gezeld.service` under `/var/lib/gezel/`. Private daemon state is readable only by the service/admin identity; only `runtime/` discovery metadata is exposed to local desktop clients. The daemon root token remains process-local, while `runtime/auth-token` is a scoped first-party client credential. Per-user spawn remains supported (and is the development default), and Settings → Daemon can register user-level autostart. See **Architectural intent — hosting modes** below.

**Process scope and client membership are separate security choices.** A machine-wide daemon may serve approved local users, every local user, or a single user; do not equate its service-manager placement with authorization. The current shared runtime credential treats every account that can read it as a first-party client. A future installer membership choice/group or OS-authenticated broker must make that trust explicit. Never regain multi-user convenience by elevating the daemon or exposing its root credential.

Auth is a random bearer token rotated per service start, surfaced to the UI via a synchronous `ipcMain` preload bridge. The HTTP transport is loopback-only TLS in packaged installs; the cert is pinned via `session.setCertificateVerifyProc` so the renderer trusts only that one self-signed cert.

## Architectural intent — hosting modes

The Electron shell runs a **supervisor** ([packages/app/src/supervisor/](packages/app/src/supervisor/)) that decides how `gezeld` runs each launch. Six concrete modes — five tried in order, with **embedded** as the fallback when none apply or a spawn fails. The mode kinds themselves live in [packages/app/src/supervisor/mode.ts](packages/app/src/supervisor/mode.ts).

1. **Remote** — user has `service: { url, token }` in `~/.gezel/config.json`. Probe `/api/health` with that token. Success → connect. **Failure does NOT fall through** — a misconfigured remote URL must surface as a loud error, not silently drift into embedded mode.

2. **System service** — the default packaged path on every supported OS. Windows uses LocalService with a dedicated per-service SID and a stripped privilege set, macOS uses the `_gezeld` LaunchDaemon account, and Linux uses the dedicated `gezel` systemd account. Electron discovers runtime metadata through [systemServiceHome](packages/app/src/supervisor/system-service.ts), probes `/api/health`, and falls back on failure. Never run the Windows service as LocalSystem, and never put the process-local root credential in the runtime directory.

3. **Local adopt** — `~/.gezel/runtime/{pid,port,auth-token}` exist and the pid is alive. Probe `/api/health`. In **packaged** mode, compare `health.version` to the shipped bundle version; on mismatch, SIGTERM the stale daemon and fall through to step 5 (the user's Electron is newer than the running service). In dev mode, adopt regardless.

4. **Local spawn (packaged)** — the supported per-user path, and the path every machine-engine install takes for its *product* daemon (branch 2 gives you engines, never product state). Resolve a service tree, then spawn it under the logged-in user. Resolution prefers the tree the installer already unpacked into the system-scope service home — on POSIX, when its `.gezel-bundle.sha256` equals the shipped bundle's sha and it is not writable by the calling account ([shared-service-tree.ts](packages/app/src/supervisor/shared-service-tree.ts)) — and otherwise extracts `app.asar.unpacked/dist/service-bundle.tar.gz` to `~/.gezel/service/`. Adopting matters because the alternative is unpacking a byte-identical ~33k-file tree once per account minutes after the installer unpacked it once per machine; that duplicate was ~20 minutes on the startup splash of a fresh Linux arm64 install. It is a *code* tree only — `GEZEL_HOME` still points at the user's own home, so gezels, projects, and sessions are unaffected. Windows always extracts its own copy: the trust check is an ownership/mode test that has no meaning there. The Copilot login flow runs inside the app via `POST /api/system/copilot-login` under the bundled pnpm + Node — and presupposes that the user has already installed the Copilot SDK from Settings → GitHub Copilot, since it is an on-demand toolset (see **Provider** below).

5. **Local spawn (dev)** — `GEZEL_SPAWN=1` is set in dev mode. Spawn from `packages/service/dist/bin/gezeld.js` via `require.resolve`. No extraction. Watch-mode rebuilds of the service package aren't picked up until the child is restarted — if you're iterating on service code, set `GEZEL_EMBEDDED=1` instead.

6. **Embedded** (fallback or forced) — `GEZEL_EMBEDDED=1` env var is set, OR we're in dev mode and `GEZEL_SPAWN=1` is *not* set, OR any of the spawn branches above fail inside the health-wait budget. Boot the service via `@bendyline/gezel-service`'s `startService()`, without a separate daemon. When this branch is reached because of a spawn failure (not by force), the UI reports it as an **install-health notice** ([packages/ui/src/system-notices.ts](packages/ui/src/system-notices.ts)): one muted line in the navigation rail under Settings, with the full explanation in Settings → About. It is deliberately not a banner on Home — the state is neither urgent nor fixable without the installer — and the copy must never imply background work resumes on its own, because in this branch it does not.

   An embedded service runs in one of two hosts ([utility-host.ts](packages/app/src/supervisor/utility-host.ts), `resolveServiceHost`). **In-process** is Electron's main process, which is also Chromium's browser process: a service stall there freezes the window's input, menus and IPC, and a service crash takes the whole app down. **Utility** is an Electron `utilityProcess` running [utility-service-entry.ts](packages/app/src/supervisor/utility-service-entry.ts): the service gets its own process and heap, still inside the app bundle, so it needs no separate Node binary. Development launches use the utility host by default. Packaged builds (store builds and the fallback above) and the Electron E2E suite stay in-process until the store lanes validate the helper under the Mac App Store and MSIX sandboxes. `GEZEL_SERVICE_HOST=utility|in-process` overrides either way. In the utility host the service process is forked and its tree imported while the supervisor prepares (`prewarmUtilityService`), and the final environment is mirrored into it at start. A crash or a failed health check restarts it within the budget below and falls back to in-process when the budget runs out; a restart also loads freshly built service code. Engines it orphaned are reaped by the restarted service's startup sweep. Packaged builds must ship the entry unpacked (`files` and `asarUnpack` in both `electron-builder.yml` and `electron-builder.mas.yml`, which restates the base lists).

The supervisor also runs a health-watch on spawned children and utility-hosted services (15s interval, 3 consecutive failures trigger a restart). Restart budget: 3 attempts in 60s, then fall back to embedded. On each restart, the BrowserWindow reloads so the UI picks up the rotated auth token via the preload's synchronous `ipcMain.on('gezel:current-connection')` bridge.

**Autostart** ([packages/app/src/autostart/](packages/app/src/autostart/)) is an opt-in toggle in Settings → Daemon. Writes a user-level LaunchAgent / systemd `--user` unit / Task Scheduler on-logon task — no admin required. Enabling it makes gezeld run independently of Electron, unlocking scheduled jobs and other "always on" features. Disabling uninstalls the unit. This is the "mode 2" of the original intent — packaged spawn (branch 4) is the foundation; autostart is the operational flip that keeps gezeld running when the app is closed.

On macOS and Linux the unit, not the app, owns the daemon's lifetime, and that shapes three rules. **The unit points at the service tree the supervisor resolves** (`autostartDefinition` in [supervisor/index.ts](packages/app/src/supervisor/index.ts)), never at `~/.gezel/service` by assumption: once the installer's shared tree is adopted nothing refreshes that directory, and a LaunchAgent pinned there ran a two-month-old release while every upgrade reported success. **Every stop and restart goes through launchd/systemd, never a pid.** A SIGTERM is exactly what `KeepAlive` answers with a relaunch, and the relaunched stale daemon won the home lock back from the app's own spawn on most launches. On each packaged launch, [autostart-handover.ts](packages/app/src/supervisor/autostart-handover.ts) re-registers a drifted unit for this home, restarts it through the manager until it serves the shipped version, and adopts it; a unit that cannot get there is stopped for the session. **A refused autostart daemon stands down.** gezeld exits 0 when launched by autostart and another daemon owns the home, and the LaunchAgent's `KeepAlive` relaunches only unsuccessful exits, so it no longer reboots every ten seconds. Quitting an app that owns its daemon then hands the home to the unit. Units serving a different `GEZEL_HOME` are never touched. Windows' logon task relaunches nothing and keeps the ordinary stop-and-respawn path.

**Remote mode (branch 1)** is wire-complete — the supervisor probes and connects — but the UI for configuring a remote URL is not yet built. `service:{url,token}` is declared in `GezelConfigSchema` so Store writes round-trip it (a hand-edited config now survives settings saves). The supported way to reach a remote daemon's full product API + web UI today is a loopback-preserving tunnel (SSH `-L` / Tailscale toward loopback); recipes and the first-class remote-access design live in [docs/remote-access.md](docs/remote-access.md). Remote *inference* between paired devices is a separate, shipped subsystem (`packages/service/src/remotes/`, `/v1/remote/*`, LAN listener on 6229) and is not this branch.

Do not bake "the service is in-process" assumptions into new code — go through the HTTP API (via `@bendyline/gezel-client`) and you'll be fine across every branch.

## Directory layout on disk

```
~/.gezel/
├── config.json              provider creds, default meester, default model
├── runtime/                 pid, port, auth-token (cleared on restart)
│   └── codex-cli/{projectId}/{sessionId}/  per-session CODEX_HOME (5–9 MB each); idle ones are
│                            pruned by providers/codex-cli/runtime-sweep.ts (14 days, newest 1,000)
├── .transactions/           private durable journals for crash-safe multi-file operations
├── service/                 extracted gezel-service bundle (packaged mode)
├── logs/                    service-YYYY-MM-DD.log — 7-day rolling, 10 MB cap
├── pending-handoffs.json    gezel→gezel messages parked mid-send, replayed at boot
├── gezels/
│   └── {id}/
│       ├── gezel.md         frontmatter: name, role, provider?, model?
│       ├── about.md         system prompt prose
│       ├── icon.svg         current icon
│       ├── icons/           last 5 variants, archived by timestamp
│       ├── sessions/        {sessionId}.json — one per chat thread; .wire/{sessionId}.json —
│       │                    a local-engine session's exact transcript, reseeded after a restart
│       │                    so the engine's persisted KV cache still matches
│       ├── memories/        daily/YYYY-MM-DD.md + lessons.md + index/mem.db
│       └── resources/
├── projects/
│   └── {id}/
│       ├── project.json     name, description, workingDir?, packages
│       ├── finding-lifecycle.json  durable open/in-progress/resolved scanner findings
│       ├── report-actions.json  fired/dismissed lifecycle of report-embedded action requests
│       ├── artifacts/       read-write user/agent outputs
│       │   └── tasks/{num}/ per-task working folder — auto-created at task
│       │                    creation, shared by fanout children; craftbooks
│       │                    address it via the {{task.dir}} token
│       ├── workspace/       internal fallback when no external dir
│       ├── index/           content index (index.db) — always here, never in workingDir
│       ├── quarantine/      connector content the safety scanner refused
│       └── memories/        same structure as gezel memories
├── memories/                the person's own memories ("About you"), read by every gezel:
│                            daily/YYYY-MM-DD.md + index/mem.db
├── documents/               cross-project shared library (mission, guidelines) — the
│                            `shared` project's workspace; see docs/documents-library.md
├── index/                   global.db — sqlite FTS cache over sessions + history
└── tasks/history/           completed task records
```

Persisted user state uses **gezels/**, never **agents/**. Repository-only metadata such as `.agents/` and `.github/agents/` is not part of the on-disk product schema. `Store.ensureLayout` retains a one-shot migration for older installs that used an `agents/` state directory.

## Packages

| Package | Purpose |
|---|---|
| `packages/core` | Shared Zod schemas, path helpers, gezel-markdown parser. No runtime deps on node beyond built-ins; safe for UI + service to both import. |
| `packages/inference` | `@bendyline/gezel-inference`: the shared on-device runtime — native engines and capacity, local providers, model management, knowledge and embedding workers, the OpenAI-compatible routes, native release pins. No product state, tools, cloud providers or UI. It owns the `inferenceOnly` profile in both host modes: its `startService` is the in-process host the app SDK loads (so an embedder such as DocBlocks installs it instead of the whole service), and `gezeld` with `GEZEL_EMBEDDED_INFERENCE_ONLY=1` serves the same host behind the service's listener ([inference-host.ts](packages/service/src/inference-host.ts)). Never re-add inference-only branches to the product daemon. The service imports it through `./internal/*`, a coordinated surface pinned exactly by `workspace:*` and not covered by semver. Most of its tests still live in the service suite and resolve the **built** `dist/`: rebuild inference (or run `pnpm dev`) before trusting a service test of inference code. |
| `packages/service` | The daemon: HTTP API, `Store`, `ChatManager`, providers, memory, chat events. |
| `packages/mcp` | The stdio MCP server. Gezels get this as their "hands" — list/read/write workspace, artifacts, documents, memories, and the **team tools** (`list_gezels`, `create_gezel`, `update_gezel`, `list_projects`, `create_project`, `update_project`) used by the Meester. |
| `packages/client` | Typed HTTP client wrapping every service endpoint. Also used internally by the MCP server to call back into the running service. |
| `packages/ui` | React/Vite web app. Served by the service at `/`. |
| `packages/app` | Electron shell. Holds the supervisor (machine-service adoption on every packaged platform, per-user spawn, and embedded fallback), loads the UI, and ships platform installer/autostart scaffolding. |
| `packages/cli` | `gezel` command-line for headless scenarios. |
| `packages/catalog` | Catalog *loader* (sources, install pipeline, authoring/generation scripts). The content itself — gilde templates, toolsets, craftbooks, chat-/image-/video-model catalogs — lives in the external [`bendyline/gilde`](https://github.com/bendyline/gilde) repo, consumed as the exact-pinned `@bendyline/gilde` npm package. Local content dev via `pnpm link:gilde`. See "The three-repo catalog architecture" below. |
| `packages/gezk` | The `.gezk` **format** as code (`@bendyline/gezk`): manifest/registry/profile schemas, id grammars, `knowledge://` references, quantization, DDL, canonical JSON, Ed25519 signing. No gezel dependency; browser-safe main entry plus `./node`. The public spec, JSON Schemas, conformance kit and Python reader live in [bendyline/gezk](https://github.com/bendyline/gezk); see [docs/gezk-format.md](docs/gezk-format.md). |
| `packages/knowledge` | The `.gezk` knowledge-catalog toolchain: deterministic compiler, archive safety (verified ZIP inspect/extract), read-only reader with two-stage `bit+int8` retrieval (an in-memory sign-bit scan — no vector extension), chunking, validation. Depends on `gezk`, never on `core` or `gezel-service`. |
| `packages/plugin-sdk` | Helpers for writing gezel plugins (legacy surface, kept for compatibility). |
| `packages/sdk` | Newer extension surface — typed entry points for external integrations and embedders. The plugin-sdk is the historical equivalent; treat `sdk` as the preferred surface for new work. |
| `packages/script-runtime` | Portable, capability-mediated script execution: the `ScriptExecutor` contract, `PortableScriptRunner`, and a QuickJS-WASM executor for hosts without Node's sandbox (browsers, WebViews). The service still defaults to its Node sandbox. |
| `packages/app-sdk` | The surface for software running *beside* gezel: discovery, consent, and OpenAI-shaped chat from `.`. The `./host` subpath adds `connectOrHost()` → a **`Gezel`** (connection, `ensureModel`, `ensureProject`) that hands back a **`GezelProject`** (`openChat`, `registerTools`) — chats and app tools are project-scoped, so the id is never threaded by hand. It can run the daemon **inside** the consuming app against `~/.gezel/apps/<appId>/`; `@bendyline/gezel-service` is an **optional peer** reached by dynamic import, so a connect-only consumer never downloads it. |
| `packages/vscode` | VSCode extension that surfaces gezel features inside the editor. |
| `evals` (top-level, **not** under `packages/`) | End-to-end evaluation harness. Drives `gezeld` via `GezelClient` against scripted scenarios and reports success rates. Registered in `pnpm-workspace.yaml`; invoked via root `pnpm eval:run` / `pnpm eval:batch`. |

**Fifteen of these are published to npm** as public API under semver: `gezk`, `core`, `client`, `sdk`, `script-runtime`, `app-sdk`, `plugin-sdk`, `catalog`, `knowledge`, `connectors-spectral`, `script-stdlib`, `mcp`, `inference`, `service`, `cli` (inference's `./internal/*` subpath excepted). The authoritative list is [scripts/published-packages.mjs](scripts/published-packages.mjs); a new entry there needs its one-time hand bootstrap on npm before the next release (`scripts/check-npm-bootstrap.mjs` fails the release otherwise). `app` and `vscode` are versioned and tagged by the release tooling but stay `private: true` — that flag is the only thing keeping them off npm. `ui`, `eval-viewer` and `evals` are excluded entirely; the UI ships *inside* the service tarball (`packages/service/tsup.config.ts` stages `packages/ui/dist` into `dist/ui/`). See [docs/npm-release.md](docs/npm-release.md).

Build order (enforced by root `build:packages:unleased`): `gezk` → `core` → `client` / `plugin-sdk` / `sdk` / `app-sdk` / `capacitor` / `catalog` / `knowledge` / `connectors-spectral` (parallel) → `inference` → `script-runtime` → `mcp` → `ui` → `libreoffice-extension` → `service` → `cli` / `app` / `vscode` (parallel). **`ui` and `libreoffice-extension` build before `service`**, because `packages/service/tsup.config.ts` stages `packages/ui/dist` into `dist/ui/` and the extension's `gezel.oxt` into `dist/libreoffice/`; a missing `.oxt` only warns, so the order is what keeps it in the tarball. Consumers read siblings through their built `dist/`, so a checkout whose `dist/` predates a pull fails typecheck and tests on exports its sources already have — rebuild the stale package before diagnosing further. The MCP depends on `client`; the service depends on all of them and resolves `@bendyline/gezel-mcp/dist/server.js` at runtime — this subpath is **explicitly exported** from the mcp package's `package.json` for a reason (see "Gotchas" below).

## The three-repo catalog architecture

Catalog **content** is not in this repo. It lives across three repos:

- **gezel** (this repo) — the app plus the catalog *loader*
  (`packages/catalog`: `CatalogService`, sources, npm-toolset install
  pipeline) and schema-aware compilers that genuinely depend on unpublished
  core APIs. It contains no chat-model authoring recipes or generator.
- **[`bendyline/gilde`](https://github.com/bendyline/gilde)** — the
  content: `data/` (chat/image/video models, toolsets, connector types,
  project types, gezel role templates, craftbooks + `test.json` eval
  sidecars, and the bot-managed `data/community/` MCP-registry tier), plus
  every chat-model recipe under `authoring/chat-models/` and its local
  generator. Model introductions require no Gezel source change.
  Repo root **is** the npm package root of `@bendyline/gilde`, so the
  published package and the checkout are interchangeable. Gilde owns the
  canonical `tools/build-index.mjs` plus dependency-light PR validation
  (ajv against `schemas/*.schema.json`, which are **generated from
  core's Zod schemas** — see Gotchas). `build-index` writes two indexes
  per kind directory: `raw-index.json`, the item files verbatim (identity,
  every version's stamp, the newest payload), which this build lists from
  and resolves with its own code; and the legacy `index.json`, a resolved
  manifest re-derived through gilde's schema copy and a port of gezel's
  merge, kept only for older builds live-updating on the current minor
  line — drop it at the next minor bump. It takes open-source PRs.
- **[`bendyline/gilde-pipeline`](https://github.com/bendyline/gilde-pipeline)**
  — verifies gilde, publishes `@bendyline/gilde` to npm (patch version
  injected at publish; the committed gilde version is the minor line),
  and deploys the gezelgilde.com Pages site plus the versioned
  `catalog/v1/latest.json` update manifest (the contract the stubbed
  `RemoteSource` will eventually poll).

Gezel consumes the content as an **exact-pinned registry dependency** of
`packages/service`, with the same pin in `packages/catalog` development
dependencies. The published catalog loader declares Gilde as an optional peer:
standalone users of its default source install `@bendyline/gilde` explicitly.
Inference supplies a model-only snapshot generated from the same content via
`dataDir`, so it needs neither the full Gilde payload nor a second loader.
Default content is resolved at runtime through `gildeDataDir()` in
[packages/catalog/src/gilde-data.ts](packages/catalog/src/gilde-data.ts).
`GEZEL_GILDE_DATA_DIR` overrides resolution for tests/evals/operators;
authoring scripts locate the sibling checkout via `GILDE_DIR` (default
`../gilde`).

The content-change dance: edit or generate in the sibling `../gilde`
checkout (run `pnpm link:gilde` so the daemon/tests/evals see it) → run
Gilde's `npm run fix && npm run check` → gilde PR → CI
validates → merge → the pipeline publishes → bump the service runtime and catalog development pins in
`packages/service/package.json` and `packages/catalog/package.json` (every `@bendyline/*` package is exempt from
the seven-day release-age hold in `pnpm-workspace.yaml`, so a fresh gilde needs
no exclusion entry) → `pnpm unlink:gilde`. Content regressions
gate in gezel CI against the *pinned* version via the catalog package's
data-contract tests.

**If your content edit uses a value newly added to a core Zod schema**
(a fresh `style.family`, behavior id, tool-grammar format, engine enum,
etc.), run `pnpm gilde:export-schemas` so gilde's validation accepts it,
and rebuild the service: a daemon built before the value drops it (see
below). With stale schemas, `build-index` also **silently drops the item
from the legacy `index.json`** (`--verbose` → `skip … invalid-identity`);
only builds that predate `raw-index.json` read that file.

**Gezel and gilde are not in schema lockstep.** Every catalog read — identity,
version manifest, `craftbook.json`, and each index entry — goes
through core's own schemas via `parseTolerant`
([schemas/tolerant-parse.ts](packages/core/src/schemas/tolerant-parse.ts)):
a value this build does not understand (an unknown gate check kind, enum
value, or key in a strict object) is dropped and logged once as
`ignored what this build does not understand`, instead of failing the
whole item. Required values are never dropped; an item that is
structurally incompatible still fails. So content may run ahead of the app,
and the app ahead of gilde's schema snapshot, in either direction. When a
new field is load-bearing (ignoring it would make the item *wrong*, not just
less capable), the content sets `minGezelVersion` and older builds skip that
version. Authoring paths (`craftbook_write`, gilde validation, the exporter)
stay strict.

**Live gilde updates (opt-in, default off).** Between app releases, the
daemon can pick up newer gilde content on its own:
[GildeUpdateManager](packages/service/src/gilde-updates/manager.ts) checks
registry.npmjs.org roughly daily for newer `@bendyline/gilde` **patch
releases on the bundled pin's minor line**, verifies the tarball against
the registry's `dist.integrity`, stages it under `~/.gezel/gilde/`, and
activates it only after an empirical no-regression gate
(`validateGildeContentUpgrade` in
[packages/catalog/src/live/](packages/catalog/src/live/)): every item
resolvable from the current content must still resolve from the candidate.
Activation is restart-free — the manager owns the effective content root,
`CatalogService` reads it through a provider closure
(`BundledSourceOptions.dataDir` accepts a function), and catalog reads are
lazy, so the flip is visible on the next read; live chat sessions re-resolve
tuning via the `catalogContentSnapshot` drift check in `ensureState`.
Controlled from Settings → About → Catalog content
(`config.gildeUpdates.enabled`, additionally gated by the security policy's
`allowAppNetwork`); surfaced at `/api/gilde-updates`. `GEZEL_GILDE_DATA_DIR`
keeps absolute priority — with it set the manager reports `overridden` and
never fetches, so dev/`link:gilde`/evals are unaffected. Line bumps (new
minor) deliberately ride app releases, and the identity pick-lists in
`mergeIdentityAndVersion` (source.ts) still drop manifest *fields* this
build doesn't know. Newer schema surface inside an existing item no longer
blocks activation: the tolerant read drops what this build cannot use, so
the item still resolves and the no-regression gate passes.

## Core concepts

### Gezel

A named AI agent. Fields worth knowing:

- **Frontmatter** (in `gezel.md`): `id, name, description?, role?, model?, provider?, reasoningEffort?, iconOverride?, character?` — see "Character, social mode, and growth" below
- **`about.md`**: injected verbatim into the model's system prompt when this gezel runs
- **`poppetje.json`**: a parametric carved-figure character. Body shape, skin, hair, hat, accessories, expression — see "Poppetje" below. The primary visual identity.
- **`icon.svg`**: an optional LLM-generated abstract sigil. When `iconOverride: true` in frontmatter, the UI shows this instead of the poppetje. Off by default.
- **Provider override**: when set, this gezel uses the named provider regardless of global default

Create via `POST /api/gezels`. The poppetje is generated synchronously and deterministically from the gezel id at create time (~1ms, pure math). `about.md` and the optional `icon.svg` are generated in the background via one-shot LLM calls (non-blocking — the dialog closes immediately).

### Poppetje

The carved wooden-figure character for a gezel. A `Poppetje` is a plain struct (`packages/core/src/poppetje/schema.ts`) — body archetype + figure scale + skin/hair/shirt colors + slots (hat, dress, accessory, mark, expression). The renderer ([packages/ui/src/poppetje/](packages/ui/src/poppetje/)) turns it into SVG; the persistence layer ([packages/service/src/poppetje/manager.ts](packages/service/src/poppetje/manager.ts)) reads/writes one JSON file per gezel.

Critical invariants from the maintained [poppetje rendering strategy](docs/poppetje-rendering.md):

- **`key` is the wood-grain anchor.** Pinned to the gezel id; same key always produces the same `feTurbulence seed`. The wood-grain pattern is stable across rerolls, renames, and process restarts.
- **Slots are persisted explicitly.** The persistence contract is: *"generated values get persisted as explicit fields on save, not re-derived from the seed at render time."* This lets us add catalog entries or tune slot odds later without drifting existing characters.
- **The renderer reads one struct.** Variants (`full`, `headshot`, `icon`) are different `viewBox` crops of the same SVG content tree — no duplicated geometry.
- **No body-shape-to-identity mapping.** Shapes, skin, and hair mix freely across the cast — never bound to gender or craft.
- **Whorls are organic, not identity markers.** ~25% of figures get knot marks deterministically from the seed; never assign one to a specific gezel as an identity stamp.

### Character, social mode, and growth

**Social mode** (`config.social`) decides how much personality shows. `resolveSocialMode(config, host)` in [core character/](packages/core/src/character/index.ts) is the only reader: the person's choice, else on for phones and off for the desktop. The desktop's config response returns it resolved; the phone's returns raw config. Off must reproduce the plain register exactly — no character block in any prompt, no Growth tab or level badges, no visit card, no growth announcements in chat. It is a separate switch from "Show gezel names and poppetjes"; never merge them.

**`character`** is a frontmatter record `{ temperament, quirk, style, sociability: 0-4 }` from a small fixed vocabulary in [schemas/character.ts](packages/core/src/schemas/character.ts). It follows the poppetje contract: seeded from the id at creation (`seedCharacter`), **persisted explicitly**, backfilled once by `ensureLayout` on both hosts, so adding values later never changes an existing gezel. The schema is lenient (`.catch(undefined)`), so a bad hand edit drops the field rather than hiding the gezel. Every value has one effect line in `TEMPERAMENT_EFFECTS` / `QUIRK_EFFECTS` / `STYLE_EFFECTS`; those lines ARE the `### Character` prompt block (at most 60 tokens, stable band after traits, kept at the `minimal` footprint) and what the character editor shows, so the UI and the model cannot disagree. Mechanical effects: sociability and the temperament/quirk length factor cap a turn tool's `say` through `withCharacterChatCap`. `traits` (growth-learned rules) and `voice` (the TTS id) are different fields — don't reuse them.

**Growth** (XP, levels, user-approved proposals, cosmetics) lives in [core growth/](packages/core/src/growth/): XP math, the refresher, proposal generation over injected `GrowthProposalSources`, and the level-up transitions as pure functions. The desktop's [service growth/](packages/service/src/growth/) files are shims and adapters (store, MemoryManager, `oneShotCompletion`); the phone runs the same code through `PortableGrowth` ([runtime/growth-engine.ts](packages/core/src/runtime/growth-engine.ts)), counting consultations from messages with `from` (the phone keeps no history log) and generating proposals with a Klerk one-shot in the engine's background ambient lane, aborted on suspend. The phone has no sweep, so a completed task is what creates a pending level-up there. Growth keeps accruing with social mode off; only its display and announcements are held. A person's own progress (a Spanish level, a streak) is project data, never gezel XP.

### Earned notifications

A notification must be earned by something durable that happened. The sources are: a question (`question_asked`), work the person asked for finishing (`task_settled`, owner-launched only: `isOwnerLaunchedCompletion`), a level-up (social mode only), the night's review card, a project reminder, and a lookout the person set up (`lookout_fired` with an alert — the one kind that skips the 4 s grouping and the daily cap, bounded instead by each lookout's own limits; see [docs/lookouts.md](docs/lookouts.md)). The policy lives once in [core notifications/](packages/core/src/notifications/). `earnedItemFor` decides what an event is worth and in which register (social mode names the gezel, otherwise plain status text). `NotificationGate` folds what arrives within 4 s into one notification, stays quiet while the person is watching, and holds the rest once `config.notifications.dailyCap` (default 3, 0 = off) is spent. The cap is enforced through a per-host ledger that also dedupes replays. `EarnedNotifier` feeds the gate from the event stream and keeps reminders scheduled. Nothing fires on the clock alone, and the gate tests pin that. Two hosts run it:

- **Electron main** ([earned-notifications.ts](packages/app/src/earned-notifications.ts) `startEarnedNotifications`) owns desktop notifications, so they arrive with the window closed. Its ledger is `notification-ledger.json` in Electron's userData. The renderer never raises one.
- **The phone's UI** ([useHostNotifications.ts](packages/ui/src/components/useHostNotifications.ts)) drives `window.__GEZEL__.earnedNotifications`, the mobile bridge over `@capacitor/local-notifications` ([mobile/src/notifications.ts](packages/mobile/src/notifications.ts)). Its ledger is localStorage. It asks the OS for permission the first time something earned happens while the person is in the app, and clears the tray when they return.

**Reminders** are the only time-based source, and the time must come from the project's own state. A script with the `reminders` capability calls `gezel.reminder.set({ at, title, body })` / `clear()`; `parseReminderRequest` enforces a future time at most 30 days out. The host stores one per project (`projects/{id}/reminder.json` through `Store` / `PortableStore`), announces `reminders_updated`, and `GET /api/reminders` lists them. `planReminders` schedules the week ahead, at most the cap per day. The desktop arms one timer and re-checks on resume; the phone hands them to the OS. Flashcards 1.1.2 is the reference content.

### Device connectors and lookouts

A **device connector** (`driver: 'device'`; `camera-local` first) binds a project to local
hardware. It never enters the connector sync loop: `LiveConnectorHost`
([connectors/live/](packages/service/src/connectors/live/)) keeps it running (reconcile on
change, backoff, awake-time watchdog, restart on wake) and the sync loop filters it out. One
ffmpeg per physical camera pipes 160x90 grayscale to a pure-TS motion/presence detector
([core camera/](packages/core/src/camera/)) and MJPEG to storage and review. Raw frames go to
the private sidecar (`projectCapturesDir`), never artifacts; what happened becomes one
ordinary connector record per episode with at most three keyframes. The on-device vision
model looks only when an episode is underway, one review at a time across the install. A
camera's pixels reach the person's app and on-device sessions only; cloud sessions get a
local description unless the binding's `allowCloudModels` is on (`cameraPixelsWithheld`).
Gate with `projectAcceptsLiveWork`, never `projectAllowsAmbientWork` (auto-`stable` would make a
camera go deaf). Contract: [docs/device-connectors.md](docs/device-connectors.md), [ADR 0025](docs/decisions/0025-device-connectors.md).

A **lookout** is the person's standing instruction: "when the Mud room camera sees X, then
Y". The engine ([lookouts/manager.ts](packages/service/src/lookouts/manager.ts), pure rules in
[core lookouts/](packages/core/src/lookouts/)) never calls a model: the camera's structured
review answers each lookout's yes/no question, and actions fire on those answers, never on
vision prose (camera text is untrusted: sanitized, quoted, never a recipient, parameter, or
instruction). Once per episode, cooldown, daily limit, install-wide ceilings on disk; every
action gated and recorded with a plain reason. Gezels only **propose** (stored disabled);
session tokens cannot create, edit, test, or approve. Contract: [docs/lookouts.md](docs/lookouts.md),
[ADR 0026](docs/decisions/0026-lookouts.md).

### Interest areas

What the person said they want help with: `config.interests.areas`, ids from
`InterestAreaIdSchema` in [core interests/](packages/core/src/interests/)
(software, data, work, business, content, home, learning, play; health and
legal are held, with ids but no key). The welcome asks only a new install
(`shouldAskInterests`: a `firstUseAt` within the week, not yet answered or
skipped); Settings → General holds the same picker. The answer **orders** what
is offered (the welcome's `firstProjectsFor`, Make something's `pickWithRange`,
New Task's For you shelf, New Project's rail, Knowledge's suggestions through
`orderByInterests`) and **never hides** anything or enters a prompt. An item's
areas come from its gilde `category` through one map, unless its identity
declares `interests` (`interestAreasForCraftbook` / `interestAreasForProjectType`;
knowledge catalogs by id family). Read config through `resolveInterestAreas`:
it keeps raw ids a newer build wrote and drops held or unknown ones. Contract
in [docs/ux.md](docs/ux.md) ("Interests order; they never hide").

### Craftbooks on the phone

The phone runs a craftbook when it has every tool, script and gate check the
book uses. That verdict has one owner, `craftbookHostGap`
([core runtime/craftbook-host-gap.ts](packages/core/src/runtime/craftbook-host-gap.ts)):
the phone build bundles runnable books whole and the rest as summaries with a
plain `unavailableReason`, which every launcher shows on a disabled card
rather than hiding the book. The parts both hosts must agree on live once in
core: the step's turn steering (`stepTurnSteering` — the step the loop's
correctives name, an exact-action step's terminal tool and request shape),
the mid-turn deliverable check (`completionGateWorkspaceFiles`), the chat
launch's dedupe key (`chatLaunchInvocationKeyAsync`, pinned equal to the
desktop's by `chat-launch-key.test.ts`), and the start card
(`craftbookStartCardForTask`). Fanout, `branches`, `requireChange` and
desktop-only gates are still gaps there, reported by the same function.

### Project

A scoped workspace. Always present: a `default` project that fills in when the user hasn't chosen one. A project can optionally point at an external `workingDir` — otherwise an internal fallback directory is used. Artifacts (reports, scripts, outputs the agent produces) live under the project and are separate from the codebase. Each task gets its own working folder inside the drawer — `artifacts/tasks/<num>/`, auto-created at task creation, stamped on the task as `artifactDir`, and inherited by fanout children so batch shards share the host's namespace. Craftbooks reach it through the reserved `{{task.dir}}` interpolation token (conventionally via a `workPath` param defaulting to `{{task.dir}}`), and ad-hoc task sessions are told the folder in their injected task context. It joins `notes/`/`reviews/`/`reports/` in `ACCESSORY_ARTIFACT_PREFIXES` ([packages/catalog/src/artifact-surface.ts](packages/catalog/src/artifact-surface.ts)).

A craftbook that works *on* files — notes to compile, photos to cull — declares an **input** param (`"input": { "kind": "folder" }` on a paramSchema property). At launch the user picks a workspace folder or file (read in place) or files from their computer (uploaded, then adopted into `artifacts/tasks/<num>/inputs/<param>/`); `TaskManager.create` resolves it before interpolation, writes a manifest, stamps `Task.inputs`, and every step's prompt names the drawer and the tools that open it. Contract in [docs/craftbook-inputs.md](docs/craftbook-inputs.md); decision in [ADR 0014](docs/decisions/0014-craftbook-inputs.md).

A **project type** (gilde `data/project-types/`) outfits a project with a crew, script-backed tools, seeds and an Output page. One manifest runs on the desktop and on phones; the rules both hosts must agree on (template rendering, crew reuse, the model/page tool split, page-read scopes, reaction seeds) live once in [core/project-types/composition.ts](packages/core/src/project-types/composition.ts), and a host that cannot run a type says why (`projectTypeHostGap`) instead of running it. Only v1 (`window.gezel`) pages run in a phone's snapshot preview. See [docs/project-types.md](docs/project-types.md).

**Every session belongs to a (gezel, project) pair.** There is no "gezel-only" session — the `default` project is the implicit bucket.

**Mapping a document or folder to a project goes through one place.** `POST /api/projects/infer-for-path` ([projects/infer-project.ts](packages/service/src/projects/infer-project.ts), rules in [core/src/project-inference/](packages/core/src/project-inference/)) reuses the project that owns the path, creates a read-only folder project for the folder it infers (well-known folders like Documents, a sibling-grouping parent like `engineeringdocs/`, or the document's own folder), or answers the Default project for folders gezel must never own (home, drive roots, AppData, temp). VS Code, the CLI, and the app SDK call it through `ensureProjectForFolder` in `@bendyline/gezel-client/node`; never add another copy. Read-only comes from leaving `managedWorkspaceWritePolicy` unset on an external `workingDir` — inference must never set it. See [ADR 0015](docs/decisions/0015-project-inference.md).

Each project also carries:

- **`about`** — `documents/about.md` inside the project. Free-form prose describing what the project is, who it's for, what's in scope. Read lazily by `Store.getProject` and **injected into the system prompt** for any chat session scoped here, under the heading `### About this project`.
- **`missionObjectives`** — `documents/missionObjectives.md`. Concrete success criteria. Same lifecycle as `about` and same prompt injection (under `### Mission objectives`). Use this for the kind of bullet list you'd put in a team brief.
- **`voormanGezelId`** — optional pointer to the gezel who acts as the project's voorman (Dutch for foreman / crew lead). Stored in `project.json`. When set, the system prompt for any session here notes "The voorman of this project is **{Name}**." This is informational only — it doesn't change any access or routing — but the model knows whom to defer to.

The per-project `documents/` folder is **distinct from the global `~/.gezel/documents/` library** and holds only `about.md` + `missionObjectives.md`. Project docs are injected into chats scoped to that project; the shared library is a project in its own right (below).

All three fields are settable via the unified `PUT /api/projects/:id` endpoint and the MCP `update_project` tool, so the Meester (and any project voorman gezel) can adjust them in conversation.

### The shared document library

Cross-project knowledge — mission, guidelines, policies, house style — lives in
the shared library, and **the library is a project**: a canonical `shared`
project whose `workingDir` IS the documents root. That is what gives it the
whole per-project stack (content index, office-doc shadow conversion,
embeddings + hybrid search, the fs watcher, idle enrichment) instead of a
second, thinner pipeline. The Documents area, `/api/documents/*`, and the
`*_document` MCP tools are a facade over it.

Rules that bite if you miss them:

- **Identify it with `isSharedLibraryProject(project)`, never by id.** A user
  project can own the `shared` id first; the library then takes a different one
  and records it in `config.sharedProjectId`. `Store.sharedProjectId()` resolves
  the live id.
- **Nothing gezel-derived may be written into the library folder.** It is the
  user's, and often cloud-synced: the index is forced home-side and conversions
  land in the shared project's `artifacts/shadow/`. Outside-in editing twins
  (`report.docx_files/`) are the deliberate exception — they are the user's
  editable copy.
- **It is not a jobsite.** No voorman, no meester check-ins, no review tier;
  the Boekwachter is its resident gezel and the AI-tier opt-in.
- Undeletable, unarchivable, not git-linkable; its location moves through
  Settings → Folders, and `workingDir` is derived on every boot.

Full contract — indexing rules, freshness, audit, cloud-sync limitations, and
the per-project `documents/` stance — in [docs/documents-library.md](docs/documents-library.md);
the decision and its alternatives in [ADR 0006](docs/decisions/0006-shared-library-project.md).

### Session

A persistent chat thread. Stored on disk at `~/.gezel/gezels/{id}/sessions/{sid}.json`. Holds: `messages[]`, `providerState` (Copilot `sessionId` or OpenAI `previous_response_id`), title (first user message, truncated), createdAt, lastActivityAt, `archived`, `resumeFailed`.

On first send after process restart, `ChatManager.ensureState` tries to **resume** the provider-side state. Copilot has a real `resumeSession(sessionId)` API. OpenAI uses `previous_response_id` as a seed on a fresh session. On failure (Copilot session garbage-collected, OpenAI response past 30-day TTL), we fall back to a **fresh** provider session and set `resumeFailed: true` so the UI shows a warning banner — the local message history stays on screen for the user to read.

The UI auto-opens the **most recent non-archived** session for the active (gezel, project).

### Meester

The currently-designated "guildmaster" gezel. Stored as `config.meesterGezelId`. On service boot, `Store.ensureDefaultMeester` enforces:

- **Pointer is valid → no-op.** Respect the user's choice.
- **Pointer stale or unset, gezels exist → auto-designate the first** (don't leave the user stranded with no front-door figure).
- **Zero gezels → create a fresh Meester** with a random first name (see `packages/service/src/meester/prompt.ts`), role `Meester`, and the curated `MEESTER_ABOUT_MD` that explicitly teaches the model to use the team-management MCP tools.

Changing the meester from Settings **does not touch that gezel's `about.md`**. If a user deliberately picks their existing "Reviewer" gezel to wear the hat, their prompt stands. The Meester's *power* comes from prompt text (which teaches the model when to reach for team tools), not from special access — the tools are registered on the MCP server for every session.

### Provider

`LLMProvider` / `LLMSession` is the abstraction in `packages/inference/src/providers/types.ts`; the on-device providers live beside it, while the cloud providers and the MCP bridge stay in `packages/service/src/providers/`. Three implementations:

- **CopilotProvider** — wraps `@github/copilot-sdk`. Supports `resumeSession`. Compaction is SDK-internal. Expensive first-call latency (~30–90s on cold start); our timeouts are 120s. **The SDK is an on-demand system toolset — it is not installed at boot.** The user installs it from Settings → GitHub Copilot, or already has a Copilot CLI of their own (`COPILOT_CLI_PATH`, or one on PATH); [copilot-availability.ts](packages/service/src/providers/copilot-availability.ts) resolves that ladder and is what every UI gate reads. `loadSdk()` dynamic-imports from `~/.gezel/system-toolsets/` in packaged builds and falls back to the workspace devDependency in dev; when neither exists, `initialize()` raises an actionable "install it in Settings" error rather than an `ERR_MODULE_NOT_FOUND`.
- **OpenAIProvider** — wraps `openai` package's Responses API with `store: true` + `previous_response_id` for server-side state. **Owns an MCP bridge per session** because OpenAI's hosted MCP is HTTP-only; we run stdio ourselves.
- **MockProvider** — deterministic, scriptable, no external deps. Used by tests and by the `GEZEL_MOCK_PROVIDER=1` env flag so Electron E2E and CI work without real credentials.

Per-install default via `config.provider`. Per-gezel override via frontmatter. `ChatManager.providerFor(gezelId)` resolves the precedence.

When `config.provider` is unset, [default-provider.ts](packages/service/src/providers/default-provider.ts) resolves it — **to the on-device engine wherever we bundle one** (`mlx` on Apple Silicon, `llama-cpp` on the other platforms in the native build matrix), falling back to `copilot` only where no engine ships (notably Intel Mac). It reuses `isSupportedOnDevicePlatform` / `resolveFirstRunTarget` from the first-run bootstrap so the default and the first-run model pin can't disagree. Use it instead of writing `config.provider ?? 'copilot'`: that literal predates Copilot becoming an opt-in download and now points at something a fresh install has no way to run.

### OpenAI-compatible endpoints (Integrations)

Gezel serves third-party local apps through a public inference facade, controlled from Settings → Integrations and stored under `config.openaiEndpoints`:

- **`/v1/*`** on the main daemon port (canonical 6228) — OpenAI-shaped chat/models/embeddings, gated by bearer auth + the per-app consent flow (`/v1/apps/register`). Stateless: one fresh provider session per request; callers replay their own history. Requests resolve `<provider>:<model>` or `gezel:<ref>` targets; unknown model strings fall back to the configured **serving gezel** (persona + frontmatter tuning apply). Embeddings are the exception: `gezel:embeddings` (or the embedder's model id) runs the on-device text embedder, a provider model uses its own `createEmbedding`, and nothing falls back ([embeddings.ts](packages/inference/src/http/openai-compat/embeddings.ts)). Per-model resolved tuning always applies, with the caller's per-request sampling/`response_format`/`tool_choice` overlaid on top ([request-tuning.ts](packages/inference/src/http/openai-compat/request-tuning.ts)); the behavior **profile** (ramble detection, transcript shaping) is gated by the `supportingBehaviors` switch. Tools are caller-executed (advertise-and-halt via `SessionOpts.externalTools`); providers that run their own tool loop (Copilot, CLI providers) reject tools loudly and get history flattened into the prompt (they ignore `priorMessages`).
- **`/ollama/v1/*`** — the same engine speaking Ollama's dialect (tags/chat/generate/show/embed/ps, object-form tool arguments, bare-base64 images).
- **Ollama emulation** ([ollama-emulation.ts](packages/service/src/http/ollama-emulation.ts)) — an opt-in (`emulateOllama`, default OFF), **unauthenticated** plain-HTTP loopback listener on port 11434 so apps that auto-discover Ollama find gezel. Inference surfaces only; refuses to bind when real Ollama owns the port. Never mount product `/api/*` routes there.

**Office and LibreOffice** are not facade clients: they open real sessions in a project and offer document tools through the app-tool relay. The Office pane also declares the document as its registration's `subject`, which makes its threads conversations about that document — a prompt section in place of the file-placement layers, a small tool core, the selection opening each turn, and a focused chat in the pane ([docs/office-integrations.md](docs/office-integrations.md) "Document focus"). Prompt text about the item is written by core's `app-subject.ts`, never by the app. The Word/Excel/PowerPoint pane is served by the daemon itself on a second, stable-port TLS listener with a per-user, name-constrained CA the desktop app installs into the user's trust store; `/v1/apps/register` admits a browser request from exactly that origin. The LibreOffice `.oxt` is a native Python/UNO client. Neither asks for a connection code when Gezel set it up: Gezel's own add-ins (these two and the VS Code extension) prove they run as the owner — the Office pane with the enrollment key in its 0600 manifest (`/v1/apps/office/enroll`), native add-ins by trading the owner credential in `runtime/auth-token` (`/v1/apps/local-connect`, the app SDK's `gezelAddIn`) — and the code stays their fallback and still gates every other app. See [docs/office-integrations.md](docs/office-integrations.md), [ADR 0016](docs/decisions/0016-office-host.md), and [ADR 0018](docs/decisions/0018-local-add-in-grants.md).

Completed app turns land in history as `v1.chat.completion` and feed the UsageTracker via `ChatManager.recordExternalUsage`. A master `enabled: false` gates every surface plus new app registrations ([openai-endpoints-gate.ts](packages/service/src/http/openai-endpoints-gate.ts)).

**Gezel's tools in other AI apps** run the other way: Claude Code, Codex, Cursor, Claude Desktop and VS Code start `gezel-mcp --harness <client>` (a separate small entry, `dist/harness.js`, that never imports `server.js`), which trades the owner credential at `POST /v1/apps/harness-connect` for an ephemeral `harness` token bound to the project for the app's folder. `harnessRouteGuard` ([harness-route-guard.ts](packages/service/src/http/harness-route-guard.ts)) admits only that profile's routes, the sinks apply `config.harnessTools` (memory saves stamped `{app:<client>}`, on-device images unless allowed, no workspace writes, no photo locations), and Settings → Integrations / `gezel mcp` write each app's `gezel` entry through `/api/harness-tools`. A new tool joins the guard's allowlist first. Never answer "not a session" with owner leeway: sinks ask `isOwnerCaller` positively. Setup alone does not get the tools used: Claude Code called them in 0 of 38 trials until the folder's CLAUDE.md told it to, then in 23 of 24. So each app's setup shows `harnessAgentFileLine` for the person to paste into the folder's CLAUDE.md or AGENTS.md; Gezel never writes it. Contract in [docs/harness-tools.md](docs/harness-tools.md), decision in [ADR 0023](docs/decisions/0023-harness-tools.md).

**Issue triage** lets the person, a gezel or such an app judge the night shift's BW issues: `fixed`, `confirmed`, `not_a_bug` (with a reason), `nit`, `wont_fix`, `duplicate`, `unsure`, from core [issue-triage/verdicts.ts](packages/core/src/issue-triage/verdicts.ts). Every surface goes through `applyIssueVerdicts` ([service issue-triage/](packages/service/src/issue-triage/)), the author comes from the credential, and each verdict appends to `projects/<id>/boekwachter-verdicts.jsonl`. Keep `nit` (true but minor) apart from `not_a_bug`: frontier models reject low-grade leads, and that must not count as the reviewer being wrong. Apps get `list_issues`, `report_issue_verdicts` and the prompts `triage_issues` / `fix_issues`; apps without them get `reports/issue-handoff.md` and Import answers. A reworded lead is linked to the one it repeats (`echo.ts`), the review prompt lists up to five leads already judged not worth reporting (person-written notes only, `prior-verdicts.ts`), and calibration orders the queue and sets aside a category only on 40 verdicts with a worth-fixing rate whose 95% upper bound is under 15% (never a major issue). A set-aside issue stays listed as `lowConfidence` and leaves only the counts and badges. Contract in [docs/issue-triage.md](docs/issue-triage.md), decision in [ADR 0027](docs/decisions/0027-issue-triage.md).

### MCP Bridge

Each OpenAI or Mock session that has `mcpServer` set spawns the `@bendyline/gezel-mcp` subprocess via stdio, lists its tools, and translates them into OpenAI function-tool shape. When the model emits a `function_call`, the bridge invokes it and feeds the string result back as a `function_call_output`. The gezel-mcp server itself talks back to the running service over HTTP via the env vars it's given (`GEZEL_BASE_URL`, `GEZEL_TOKEN`, `GEZEL_AGENT_ID`, `GEZEL_PROJECT_ID`, `GEZEL_HOME`).

Tool categories (`packages/mcp/src/server.ts`):

- **Memory**: `search_memory`, `save_memory`, `list_memories`
- **Workspace** (read-write workspace files): `list_dir`, `read_file`, `stat`, `write_file`, `delete_path`, `make_dir`, `rename`, `copy_path`
- **Photos** (`image-intel`, read from the index): `list_photos`, `photo_groups` (events, byte-identical duplicates, lookalikes). Locations are returned only to the person's app and to sessions on an on-device provider
- **Artifacts** (read-write, project-scoped): `list_artifacts`, `read_artifact`, `write_artifact`
- **Documents** (shared library): `list_documents`, `read_document`, `write_document`, `delete_document`
- **Execution**: `run_nodejs_script`, `run_playwright_script`, `npm_install`, `list_packages`
- **Team / projects** (Meester surface): `list_gezels`, `create_gezel`, `update_gezel`, `list_gilde`, `create_gezel_from_gilde`, `ensure_gezel`, `message_gezel`, `list_projects`, `create_project`, `update_project`, plus the suggested-work toggles (`list_suggested_work`, `enable_suggested_work`, `disable_suggested_work`) that surface role- and project-type-recommended recurring craftbooks ([suggested-work/](packages/service/src/suggested-work/))
- **Tasks**: `list_tasks`, `get_task`, `create_task`, `update_task`, `set_task_status`, `assign_task`, `add_task_step`, `advance_task_step`, `read_task_notes`, `write_task_note`, plus `manage_task` (pause / resume / cancel). `manage_task` is the Meester's `task-oversight` kit, for the runs it launches in Default, which has no voorman. It has no `complete`: finishing stays with the assignee and its gates. Its resume goes through the retry route, which the scope guard opens to a coordinator session only while `ChatManager.isUserDirectedTurn` holds. A model can restart a paused task when the user asks, never on its own initiative.
- **Other**: `ask_user_question`, `search_history`, `render_image`

Eligible MCP calls are auto-approved only after the role/security surface and
call-time guards admit them; mutation sinks still enforce project consent and
the resolved security policy. Copilot's SDK-native built-ins (`bash`,
`web_fetch`, file operations, and `grep`) are denied by default so they cannot
bypass those layers. An explicit install-level or per-gezel
`sandboxCopilot: false` is the deliberate compatibility escape hatch.

### Factual writing

A gezel that states facts for people cites its evidence and does not fill
gaps from memory. Factual mode is resolved per session by
`resolveFactualWriting` ([core grounding/factual-writing.ts](packages/core/src/grounding/factual-writing.ts)):
the gezel's `factualWriting` setting, else a fact-stating role (writer,
researcher, reviewer, journalist, historian, …; fiction excluded), else any
session that can write into a person's document (the Office and LibreOffice
`doc_insert_text` / `doc_replace_selection` / `slide_insert`). The session's
[EvidenceLedger](packages/service/src/chat/evidence-ledger.ts) numbers every
retrieval row and evidence-tool result as `[n]` (session-wide, through the
bridge's `grounding` hooks). It refuses a document write that states a name,
date, number or quote no evidence shows (twice per tool per turn, then it
writes and warns). It also stamps `ChatMessage.grounding` on each reply.
The check is literal and model-free ([core grounding/citations.ts](packages/core/src/grounding/citations.ts)):
it catches invention, not a wrong source copied faithfully. Never put this
guidance in about.md. It is runtime text, gated by role like the other
layers. Contract in [docs/factual-writing.md](docs/factual-writing.md).

### Launching a craftbook from chat

Two surfaces turn a person's words into a craftbook task, and they share one
owner for the parts that must agree. The chat composer's **attached task**
(`POST /api/sessions/:id/launch-task`, [routes/sessions.ts](packages/service/src/http/routes/sessions.ts))
creates the task deterministically — no coordinator model turn — with the
message as the description and a synthetic `craftbook-launch` receipt in the
thread; the MCP `invoke_craftbook` tool is the model's path. Both call
[core/craftbook-launch.ts](packages/core/src/craftbook-launch.ts)'s
`composeCraftbookLaunch` (verbatim message first, padded only below the
create minimum; `topic` filled from the message when the book declares one and
no source form was given) and go through
[tasks/launcher.ts](packages/service/src/tasks/launcher.ts)'s `TaskLauncher`
(invocation-key dedupe, in-flight coalescing, entry dispatch). The launch is
parked on the prompt draft as `taskLaunch` ([schemas/task-launch.ts](packages/core/src/schemas/task-launch.ts))
so it survives a restart; a send carrying `turnIntent: 'off'` tells the daemon
the person dismissed the suggested task for that text, and the turn-intent
prelude and `invoke_craftbook` clamp stand down for that one turn.

Suggestions come in two tiers, both from `ChatManager.previewTurnIntent`.
The exact-format routes (pptx/docx/pdf/slideshow) are high confidence and
still drive the prelude for model-routed sends. The catalog tier
([chat/craftbook-trigger-route.ts](packages/service/src/chat/craftbook-trigger-route.ts))
matches a book's declared `triggers` on word boundaries against the text,
proposes only books the message alone can start, and is advisory: no
prelude, no clamp, just the strip. Which parameter carries the message is
the `fromMessage: true` annotation on a paramSchema property, read only by
`mainContentParamKey`; a book without one falls back to a property named
`topic`. Adding the annotation to a gilde book needs no schema regeneration —
`paramSchema` is an open record.

Launch forms ask a person only for what a person can answer. A param whose
default is a runtime template (`{{task.dir}}`, `powerpoint/task-{{task.num}}`)
is never shown, because the daemon resolves it at create. `askUser: false`
hides a param another screen or the task description fills (the Review
panel's `reviewId`, the night-fix planner's `issueRefs`), and `askUser: true`
forces one back. Every form reads this through `withoutUnaskedParams` /
`launchFormParamSchema` in [core/craftbook-launch.ts](packages/core/src/craftbook-launch.ts),
so a book with nothing left to ask opens no form at all; the terminal still
accepts every param. Never ask a person for an artifacts-drawer path — default
it, derive it, or give it an `input` picker.

A book launched with a subject gets a **reference list**: `TaskLauncher`
searches knowledge catalogs and the shared library for it before dispatch.
The subject is the main content param, else the opening of the task
description (`craftbookReferenceSubject`) — except for code-shelf books, whose
descriptions only find namesakes there
([tasks/references.ts](packages/service/src/tasks/references.ts)), keeps at
most five subject-grounded citations as the service-stamped
`Task.references`, and every step's task block renders them as untrusted
evidence. Never write retrieved text into the task's `about.md` — it is the
person's request, rendered unlabeled beside the authoritative parameters.
Contract in [docs/project-retrieval.md](docs/project-retrieval.md).

### Diffpack (change proposal)

A bundle of file edits a gezel drafted **without touching the project**. The
gezel edits normally; the runtime collects the result into a reviewable pack in
the artifacts drawer; the user reads it and clicks Apply. Nothing reaches the
workspace until that click — which is what lets a developer gezel work on a
folder gezels hold no write grant for, and what lets the night shift produce
work you review in the morning instead of waking up to a mutated tree.

Three pieces make it work:

- **The sink moves, the tools do not.** A task with `diffpackId` set puts its
  session in drafting mode: `write_file`, `replace_in_file`, `replace_lines`,
  `insert_at_marker`, and `delete_path` keep their names and their arguments
  but land in `artifacts/diffpacks/<packId>/after/`, and `read_file` falls
  through to the real file until the pack has its own copy. Every prompt,
  behavior, and hard-won error string still applies because the transforms
  are literally the same functions ([workspace/edit.ts](packages/service/src/workspace/edit.ts)'s
  `computeReplaceInFile` and friends, shared with the workspace path).
  `apply_patch` is withheld from a drafting roster — a hand-authored unified
  hunk is the one edit shape models reliably get wrong, and the runtime derives
  the diff from before/after anyway. The step prompt says plainly that this is
  a proposal, because a gezel that believes it edited the workspace writes
  "fixed" into its task notes and that claim flows into the issue lifecycle
  and the review card.
- **Sealing.** When the drafting task completes, the settle hook diffs every
  drafted file against the workspace *as it stands then*, writes the sidecars,
  and records each file's sha256 as `baseHash`. Identity drafts are dropped;
  a pack that proposed nothing is `failed`, not `ready`.
- **Drift and overlap are computed at read time, never stored.** Both are
  functions of the current workspace and the other live packs, so persisting
  them would need a writer on every external edit — and the edit that matters
  is the one made outside gezel. Same call the Boekwachter issue's `stale` bit
  makes.
- **Moves, copies and new folders are proposed too.** While drafting,
  `rename`, `copy_path` and `make_dir` record an operation in the pack's
  `operations.json` instead of touching the tree ([diffpack/draft-store.ts](packages/service/src/diffpack/draft-store.ts)'s
  `proposeOperation`). They seal as `files` rows with `change` of `move`,
  `copy` or `mkdir` and a `from`, carry a `stat:<size>:<mtime>` source
  fingerprint rather than a hash (a photo tidy-up can name thousands of large
  files), apply after every content edit in the order drafted, and never
  replace an existing file whatever `allowDrifted` says. An edit to a path an
  operation lands on is refused: edit the file where it is now.

Applying passes `userInitiated` to `Store.assertWorkspaceWritable`, which
waives **only** the external-consent branch: the gezel never wrote, so the
user's click is the write. That flag must never be passed from an MCP tool or
any other model-reachable surface — [http/routes/diffpacks.ts](packages/service/src/http/routes/diffpacks.ts)
is its only caller.

Boekwachter issues follow the proposal, not the task that drafted it
([diffpack/issue-lifecycle.ts](packages/service/src/diffpack/issue-lifecycle.ts)):
a drafting task that completes leaves its claimed issues in progress while a
live proposal covers their file and reopens the rest; applying a file resolves
the issues on it; dismissing a proposal reopens what no other live proposal
from the same run covers. The link is the file path, because a pack records
only the first issue that seeded it.

Ids are always the drafting task's `num`, including a fanout shard's — nothing
to mint, and no second numbering scheme beside `BW-n`. A shard addresses its
own pack through the `{{diffpack.dir}}` token, **not** `{{task.num}}`, which
`TaskManager.create` already froze to the host's number when it snapshotted
the spawn template.

Overnight, [diffpack/night-fix-planner.ts](packages/service/src/diffpack/night-fix-planner.ts)
runs as each project's index catch-up drains (so it plans against tonight's
findings) and hands each qualifying project's open Boekwachter issues to its
developer. The gate is crew composition, per the `resolveProjectAutonomousGezel`
convention: a **Boekwachter** and a **developer** on the roster, plus
`projectAllowsAmbientWork`, the `nightlyFixesEnabled` opt-out (missing =
on), and a **code folder** (`gezel.folderKind` of `code`, else a detected coding
type or a linked GitHub repo — a review of a Word file is not a fix anyone
asked for). It never recruits — conjuring the gezel that unlocks the feature
would make the gate meaningless. Crew is added only when the person adds a
folder: `recruitCrewForFolder` ([projects/recruit-crew.ts](packages/service/src/projects/recruit-crew.ts))
runs for a `recruitCrew: true` request from the app's own credential
(`isFirstPartyCaller`; dropped from model, CLI and add-in callers), once per
project, and gives a code folder the Builder, a photo folder the **Curator**
(gilde template `curator`, only where the catalog carries it), and every other
kind a Boekwachter lead ([ADR 0021](docs/decisions/0021-read-only-folders.md)). The
developer clusters the issues and the runtime fans out one shard, and
therefore one proposal, per cluster. Adding a folder also arms its resident
night work ([suggested-work/arm.ts](packages/service/src/suggested-work/arm.ts)):
only report- and proposal-only books on a per-kind allowlist, only where the
sponsor runs on an on-device model (cloud ones come back as `needsOk` for the
person to approve), once per project. The folder's one off-switch is the
`gezel.nightWork` property (`setFolderNightWork`, `POST /api/projects/:id/night-work`,
the Overview's "Work on this folder overnight"): off stands the nightly sweep,
fix planning and the folder's night hosts down, and on resumes only the hosts
the switch paused.

Each project's drained night work also writes a **model-free report** by kind,
read from the index so it runs on any machine and costs nothing: a photo
folder gets `reports/photos-<date>.md` (recent outings, on this day, byte-for-byte
duplicates; never a location), a documents or mixed folder
`reports/documents-<date>.md` (what changed, each with its Boekwachter summary),
a code folder `reports/codebase-<date>.md` (hotspots by churn × findings ×
dependents, load-bearing files, open issues by severity). One per day, nothing
written when there is nothing to say, never for the shared library; the
morning review finds them under `reports/`. A code folder also keeps one
undated `reports/codebase-map.md` ([index-store/codebase-map.ts](packages/service/src/index-store/codebase-map.ts)):
every folder's purpose and key files, the most-imported files and the test
commands, rewritten only when it changes and served as JSON at
`GET /api/projects/:id/index/codebase-map`, which the project Views tab's
**Guide** view reads ([project-views/guide/](packages/ui/src/views/project-views/guide/)). It is assembled from the
area pass ([area-pass.ts](packages/service/src/index-store/area-pass.ts)),
which maps any folder over 30 summarized files through its subfolders and
summarizes each parent from its children, so every folder on the way up has a
purpose. Tests, fixtures, samples, translations and vendored code are never
split: on Brackets they were half of the areas.

**Albums are Squisq slideshows.** The `photo-library-nightly` book writes
`artifacts/albums/<date>-<slug>.md`: frontmatter (`title`, `squisq-theme`,
`album-from`/`album-to`), the `#` title and story as the cover, then one slide
per moment (`{[imageWithCaption]}` or `{[photoGrid]}` with `ambientMotion` and
`transition`). The person plays it, edits it and exports it to video in the
ordinary document editor, which reads images only from the document's
companion folder — so the gezel links photos by their workspace path and
[index-store/photo-albums.ts](packages/service/src/index-store/photo-albums.ts)'s
`storeAlbumPhotos` replaces each link with a 2048px copy in `<stem>_files/`
(`makePhotoRendition`: upright, re-encoded, no EXIF and so no location — `sips`
alone keeps GPS) and records the copy's original under the
`gezel-photo-originals` frontmatter key. It runs after a gezel writes an album
(the artifact write route), when a listing finds one still linking the
workspace, before the UI opens one (`POST /albums/prepare`), and in the
night's drained work. "Copy to a folder…" copies the full-size *originals*
into the workspace — a `userInitiated` write the scope guard closes to session
tokens, which never replaces a file.

**Squisq syntax is taught from one place.** A craftbook step that writes a
Squisq document declares `authoring: 'squisq'` or `'squisq-slideshow'`, and
the task prompt appends the matching note from
[core transform/squisq-dialect.ts](packages/core/src/transform/squisq-dialect.ts)
(`squisqAuthoringNote`) after the step's procedure, ending with a line that
the procedure decides heading levels and slide breaks (a deck splits slides on
`#`, a report uses `##` sections, and an example in the note must never
override that). Books declare the format instead of copying syntax:
`photo-library-nightly`, `narrated-slideshow`, `powerpoint-deck`, `report-pdf`
and `research-to-document` do. A Squisq change is one edit here; verify any new
syntax against squisq's `docs/SquigglySquare.md` and template registry first.

### Generalist mode

One switch — `config.generalistMode: 'auto' | 'on' | 'off'` (Settings → Artificial Intelligence → "Run in generalist mode") — decides how much orchestration wraps a piece of work. Resolvers live in [core/src/generalist-mode.ts](packages/core/src/generalist-mode.ts); the full contract is in [docs/generalist-mode.md](docs/generalist-mode.md).

- **Task execution.** A task runs `generalist` (one owner gezel pinned on every step, one continuous session across steps, the union of every step's tools, the whole outline in the prompt, every step gate still enforced, no per-step model routing) or `stepwise` (a specialist per `suggestedRole`, a fresh session per gezel change, a per-step kit). `auto` is generalist for hosted frontier providers (copilot, anthropic, anthropic-cli, openai, codex-cli) and stepwise for every on-device model until the eval says otherwise. Resolved **once** at create (or draft activation) by `TaskManager.applyExecutionMode` through the closure `product-service.ts` wires, stamped as `Task.executionMode`, inherited by fanout children, never re-evaluated. An explicit assignee stays the owner; only role resolution is overridden, and `assignee.kind === 'user'` steps are never re-pinned. An auto-assigned generalist task gets the **Generalist** gezel (gilde template `generalist`, canonical role `generalist`, one per install, reused by template id). The solo-project persona stays the **Builder**.
- **Kickoff.** The Meester's `start_project` routes to a solo Builder-led project when generalist kickoff is on: `auto` there also keeps the measured local-`medium` exception (paired A/B 2026-07-17). The MCP child reads `GEZEL_GENERALIST_KICKOFF=on|off` (was `GEZEL_EXECUTION_DENSITY`).
- **Continuity rules** (`ChatManager.startHandoffSession`): a generalist task continues its one transcript even with a queued send (the re-pin waits for the queue to drain) and whatever the handoff was labelled; a provider/model change opens a fresh session with a `generalist continuity broken` warning; a retry whose transcript ended in a context overflow or compaction-loop halt starts fresh instead of replaying the failure. The runner passes no `capabilityFloor` for generalist tasks.
- **Migration.** `executionDensity` (`flat` ≙ `on`, `scaffold` ≙ `off`) is migrated once by `Store.ensureLayout`; the schema still declares it (a non-strict object would otherwise strip it before the migration saw it). Evals: `--generalist auto|on|off` replaces `--render-mode`.
- **Log marker.** `[tasks] <ref> generalist-mode resolved=<mode> setting=<s> provider=<p> tier=<t>` at create — the eval harness reads it; keep the shape.

### History (audit log)

A first-class, append-only log of meaningful events across the install. Stored as JSONL at `~/.gezel/history.jsonl` (global) and `~/.gezel/projects/{id}/history.jsonl` (per-project). `HistoryManager` (in `packages/service/src/history/manager.ts`) owns both writes and reads.

Event kinds include `gezel.created`, `gezel.renamed`, `gezel.settings.updated`, `project.created`, `project.updated`, `project.about.updated`, `project.mission.updated`, `project.voorman.changed`, `icon.generated`, `icon.reverted`, `document.created`, `document.deleted`, `tool.called`, `meester.changed`. Emission is wired inside `Store` mutation methods (via an optional `history` option) and inside `ChatManager` via a session `onToolCall` callback that the MCP bridge invokes. **Tool calls only surface for OpenAI and Mock providers** — the Copilot SDK runs tools inside its subprocess, so those invocations are currently invisible to the bridge.

Chat sessions are **not** stored as events. Instead, `listEntries` derives a session entry per existing `ChatSession` record at query time (duration = `lastActivityAt - createdAt`, message count from `messages.length`). This dodges the "when does a session end?" problem and avoids duplicate storage.

The log is exposed three ways:

- **HTTP**: `GET /api/history?project=…&gezel=…&kind=…&from=…&to=…&q=…&limit=…`.
- **UI**: a History tab with filter bar + expandable rows (`packages/ui/src/views/HistoryView.tsx`).
- **MCP**: `search_history` tool on `@bendyline/gezel-mcp`. This is the primary intended audience — gezels debugging "when did X happen?" or "did anyone change the mission recently?".

No rotation in MVP; explicit events are small and even a year of heavy use stays well under a few MB.

### Usage & quotas

`UsageTracker` records normalized `TurnUsage` events per-provider (`recordTurn(providerName, turn)`). `UsageSummary` has a `providers: { copilot?, openai? }` shape with token totals and a `quotaBuckets[]` list per provider. Copilot's `assistant.usage` event returns **multiple quota buckets** keyed by quota class (chat, premium interactions, etc.); we surface them all so a Pro+ user sees their actual monthly cap, not the always-unlimited "chat" bucket.

## Key files

- [`packages/core/src/paths.ts`](packages/core/src/paths.ts) — every path helper; renaming a directory starts here.
- [`packages/core/src/schemas/`](packages/core/src/schemas/) — the single source of truth for wire types. Zod parse + type inference + re-export via [`schemas/index.ts`](packages/core/src/schemas/index.ts).
- [`packages/service/src/fs/store.ts`](packages/service/src/fs/store.ts) — every disk read/write. If you're tempted to read a file from anywhere else, add a method here instead.
- [`packages/service/src/chat/manager.ts`](packages/service/src/chat/manager.ts) — session lifecycle, persistence, resume, `ensureOrCreateSession`, `oneShotCompletion`.
- [`packages/service/src/providers/`](packages/service/src/providers/) — the pluggable LLM layer plus the MCP bridge.
- [`packages/core/src/runtime/provider-queue.ts`](packages/core/src/runtime/provider-queue.ts) and [`session-send-queue.ts`](packages/core/src/runtime/session-send-queue.ts) — the queued execution model the daemon and the phone runtime share: the per-engine scheduler (lanes, affinity, cancel/reorder, pause) and the per-conversation send list (queued chat, nudge, interrupt). The service's `providers/queue.ts` re-exports the first.
- [`packages/core/src/local-loop/`](packages/core/src/local-loop/) — the local-model turn loop the daemon and the phone share (`@bendyline/gezel/local-loop`): `LlamaCppSession`, tool-call salvage, turn policy, repeat/failure trackers, and the contract hosts implement (`provider-contract.ts`, `engine-host.ts`). The service's `providers/*` files for these are one-line re-export shims; change the code here. The phone serves the loop's llama-server requests from the in-app engine in [`runtime/local-loop-host.ts`](packages/core/src/runtime/local-loop-host.ts).
- [`packages/service/src/meester/prompt.ts`](packages/service/src/meester/prompt.ts) — the curated Meester about.md and name list.
- [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) — every MCP tool. Add new capabilities here.
- [`packages/service/src/diffpack/`](packages/service/src/diffpack/) — change proposals: the copy-on-write draft store, the record/seal/apply manager, and the night planner.
- [`packages/ui/src/views/`](packages/ui/src/views/) — one file per top-level tab; the entire user-facing surface.

## Conventions

- **The user owns all git management — agents must not touch it.** Do not create branches, do not create worktrees, and do not open pull requests. Work on the user's current branch in the main checkout. Commit or push only when explicitly asked. Branching, PRs, and worktree setup are the user's responsibility, not yours.
- **Git vs GitHub naming.** Anything mechanically `git` (status, changes, diffs, commits, branches, sync, merge, code reviews) is named host-agnostically — `Git*` types, `GitManager`, [packages/service/src/git/](packages/service/src/git/), routes under `/api/projects/:id/git/*`. Anything that talks to the GitHub web service (PRs, checks, OAuth/identity, repo browse) is named `GitHub*` with a **capitalized H** — `GitHubPrs`, [packages/service/src/github/](packages/service/src/github/), routes under `/:id/github/*`. Wire/JSON keys (`project.github`, `githubToken`) and the gilde requirement value `'github'` are frozen — never rename serialized names. The old `Github*` (lowercase h) exports live on as deprecated aliases in core/client until a deliberate breaking release; the legacy `/:id/github/<git-op>` route mounts exist for older HTTP clients and follow the same rule.
- **Any UI work goes through [docs/ux.md](docs/ux.md) first.** This applies to every agent and human touching `packages/ui` or any other user-visible surface: read the guidelines before styling anything and follow them — the typography scale, the radius tokens, and the "keys in trays" standard for choice controls (mostly-square, small radii; no pill buttons; fully-rounded is reserved for true circles). If you introduce a new control shape or visual pattern, extend docs/ux.md in the same change so the guidelines never lag the code.
- **Schemas live in `packages/core/src/schemas/`.** If you need a new wire shape, add the Zod schema there, export the inferred type, and re-export from `schemas/index.ts`. Both UI and service import from `@bendyline/gezel`.
- **Anything a published package ships must survive `npm pack`.** Cross-package deps stay on `workspace:*` — `pnpm publish` rewrites them at pack time, which is why [scripts/publish-package.mjs](scripts/publish-package.mjs) shells out to pnpm instead of letting `@semantic-release/npm` run `npm publish`. Three habits follow: (1) if you resolve a sibling *by string* (`require.resolve`, `import.meta.resolve`), the subpath must be in that package's `exports` map **and** listed in [tests/published/criticalSubpaths.test.ts](tests/published/criticalSubpaths.test.ts) with the right `mode` — `require.resolve` matches the `require` condition, `import.meta.resolve` matches `import`, and a package exporting only `import` is unreachable from CJS; (2) if you stage files into `dist/` from a build hook, add them to [tests/published/bundledAssets.test.ts](tests/published/bundledAssets.test.ts) — a hook that stops running fails silently and only breaks for people who installed from npm (this is exactly how the handboek content lookup broke: `dist/bin/gezeld.js` probed the wrong relative directory, and the repo's `docs/handboek` fallback masked it); (3) run `pnpm check:packages`, which installs the real tarballs into a non-pnpm, non-workspace project — the only place a hoisted-dependency or native-prebuild failure is visible. Full contract in [docs/npm-release.md](docs/npm-release.md).
- **A client built separately from its daemon judges it by `apiCompat`, never by version.** The CLI, the app SDK (and every app on it), the VS Code extension and the store builds ship on their own schedules, so a version difference is the normal case. They decide through `evaluateApiCompat` ([core api-compat.ts](packages/core/src/api-compat.ts)): a daemon is usable when the `apiCompat` range on its `/api/health` includes `GEZEL_API_GENERATION`, and one that publishes no range predates the handshake and is declined — which is how an August 1.26226.50 autostart daemon reads to a 1.26279.87 CLI. A daemon the client spawned itself is never probed. A declined daemon is never silently replaced by another home's: the SDK's `connectOrHost` hosts its own instead, everything else fails with `daemon_incompatible` and says which side to update. Bump the generation only for a breaking wire change. The desktop app's per-user path keeps its exact-version check, because its UI ships with that service.
- **Commit messages should be Conventional Commits, and nothing checks them.** `multi-semantic-release` derives every published npm version bump from them, so a subject without a type (`UX fixes` rather than `fix: UX fixes`) releases nothing for that change. There is no local git hook and, deliberately, no CI job: the `commitlint` job was removed so a malformed message never sits red beside real failures.
- **Don't bypass the Store for gezel/project/session/memory state.** Anything that represents user-facing state under `~/.gezel/gezels/`, `~/.gezel/projects/`, `~/.gezel/documents/`, or `~/.gezel/config.json` is read/written through `Store`. This gives us one atomic-write pattern and one migration point. The following subtrees are **deliberate carve-outs** owned by the feature module that creates them — they don't share Store's atomic-write contract because they're either binary blobs, append-only logs, or external working copies:
  - `~/.gezel/bin/`, `~/.gezel/service/`, `~/.gezel/runtime/` — supervisor-owned (extracted runtimes, bundle, daemon handshake state). `bin/<runtime>.stamp.json` records that node, pnpm, duckdb or the MXC launcher was hashed after install, so later launches check file metadata instead of bytes ([install-stamp.ts](packages/app/src/supervisor/install-stamp.ts)); deleting one costs one re-hash
  - `~/.gezel/engines/native-payload/verified.json` — per-file record of an installed Electron native payload that hashed to its source pins (`nativePayloadVerificationPath`), written by [electron-native-reuse.ts](packages/inference/src/engines/electron-native-reuse.ts) for the dev supervisor, the system service's boot and the CLI fallback. Only unchanged files skip the hash; the listing that rejects an unpinned DLL runs every time. Safe to delete
  - `~/.gezel/apps/<appId>/` — a **complete gezel home** owned by a third-party app hosting the daemon in-process through `@bendyline/gezel-app-sdk/host`. Deliberately isolated: the user's own daemon never reads it, so an app's projects and gezels stay out of their workshop and the two never contend for one `runtime/` directory. The only thing that crosses is models, one way and read-only, through `GEZEL_READONLY_MODEL_HOMES` ([models/storage-roots.ts](packages/inference/src/models/storage-roots.ts)). Shared night-shift and indexing across app homes is deliberately not built
  - `~/.gezel/integrations/office/` — the Word/Excel/PowerPoint integration: the per-user Office CA and listener leaf (`ca.key`/`leaf.key` 0600), the generated add-in manifests, and `setup.json`, owned by [office-setup/manager.ts](packages/service/src/office-setup/manager.ts) + [office-host/tls-identity.ts](packages/service/src/office-host/tls-identity.ts). Deleting it removes the integration; the desktop app must also remove the CA from the user's trust store (Settings → Integrations does both). `~/.gezel/integrations/libreoffice/` holds the LibreOffice extension's token and setup record, owned by [libreoffice-setup/manager.ts](packages/service/src/libreoffice-setup/manager.ts) and the extension itself. `~/.gezel/integrations/{codex,opencode,pi,vscode}/` hold each local-model harness setup's record, token and generated profile or catalog, owned by that setup's manager ([codex-setup/manager.ts](packages/service/src/codex-setup/manager.ts) and its siblings). `~/.gezel/integrations/mcp/` (`launch.mjs` plus `current.json`, rewritten at every start) and `integrations/<client>/tools-setup.json` (what Gezel wrote into that app's MCP settings) belong to [harness-tools/manager.ts](packages/service/src/harness-tools/manager.ts); deleting `tools-setup.json` only makes Gezel treat its own entry as one it did not write
  - `~/.gezel/.transactions/` — private durable operation journals and isolated staging state, owned by the transaction coordinator that creates each subtree; never expose this through `runtime/`
  - `~/.gezel/logs/` — owned by the logger / log-rotator; `logs/perf/stall-*.cpuprofile` (newest 20) by [perf/responsiveness.ts](packages/inference/src/perf/responsiveness.ts); `logs/prompts/<sessionId>/` (debug mode only: the newest 5 compiled prompts per session, swept after 7 days) by [chat/prompt-record.ts](packages/service/src/chat/prompt-record.ts)
  - `~/.gezel/history.jsonl` and `~/.gezel/projects/{id}/history.jsonl` — append-only, owned by [HistoryManager](packages/service/src/history/manager.ts)
  - `~/.gezel/keurmeester/` — append-only JSONL intervention case records plus generated digest reports, owned by [KeurmeesterManager](packages/service/src/keurmeester/manager.ts)
  - `~/.gezel/eval-runs/` — in-app eval runs (Settings → Benchmarks): `jobs/<jobId>/job.json` + `harness.log` and the harness's own per-trial directories beneath them, plus the preflight cache (`.preflight/`) and a shared MLX venv (`.cache/uv/`). Owned by [EvalService](packages/service/src/eval/service.ts); the harness writes trial directories and the daemon only reads them. Safe to delete — the results history goes with it
  - `~/.gezel/ambient/` — ambient-dashboard PNGs (dated `dashboard-*.png` + stable `latest.png`) with the generator's `state.json`, owned by [AmbientDashboardGenerator](packages/service/src/ambient/dashboard-generator.ts); plus the Electron wallpaper applier's `applied-a/b.png` slots and `display-state.json`, owned by [ambient-display/runtime.ts](packages/app/src/ambient-display/runtime.ts). Regenerable, safe to delete — except `display-state.json`, which holds the restore record for the user's pre-gezel wallpaper
  - `~/.gezel/ai-apps/` — installed AI App (.gezapp) packages: `registry.json` (the atomic activation point) plus immutable `{appId}/{version}/` slices with receipts, owned by [project-type/gezapp.ts](packages/service/src/project-type/gezapp.ts) (`importGezapp`/`listGezapps`/`setGezappEnabled`/`removeGezapp`, all serialized on its install lock); surfaced at `/api/ai-apps` and `gezel app`
  - `~/.gezel/gilde/` — opt-in live catalog content cache (`versions/<v>/` holding extracted `@bendyline/gilde` releases + `state.json`), owned by [GildeUpdateManager](packages/service/src/gilde-updates/manager.ts); rebuildable, safe to delete — the bundled pin is the permanent fallback
  - `~/.gezel/gezels/{id}/memories/index/` and `~/.gezel/memories/index/` — sqlite-vec indexes (`mem.db`), owned by [MemoryManager](packages/service/src/memory/manager.ts)
  - `~/.gezel/index/global.db` — home-scoped FTS mirror of session transcripts and the history log, owned by [GlobalIndexManager](packages/service/src/index-store/global-index-manager.ts); rebuildable cache, safe to delete. Documents are NOT here: the shared library is a project and its content lives in that project's index (ADR 0006)
  - `~/.gezel/index/suggest-vectors.json` — the embedded craftbook and project-type texts that suggestions rank against, keyed by a hash of each text and stamped with the embedder profile (a model swap discards it), owned by [craftbook/suggest-vector-cache.ts](packages/service/src/craftbook/suggest-vector-cache.ts). Spares a restarted daemon ~5 s of re-embedding on its first suggest; rebuildable cache, safe to delete
  - `~/.gezel/projects/{id}/index/` — the project's content index (`index.db` + WAL), owned by [ContentIndex](packages/service/src/index-store/content-index.ts). Home-side for **every** project, so adding a folder writes nothing into it; earlier builds' `<workingDir>/.gezel/index/` is moved here once at boot by [index-placement.ts](packages/service/src/index-store/index-placement.ts) — moved, never rebuilt, because it holds hours of model output. When both copies exist the richer one goes live and the other stays beside it as `index.db.superseded-<ts>`; never delete an index because another copy exists. Set-aside copies (superseded, corrupt, orphaned `-wal`) are swept at boot (newest superseded kept, all removed after 30 days) and face wipe / forget-person reach them ([preserved-indexes.ts](packages/service/src/index-store/preserved-indexes.ts)). Device-tier, excluded from backups. `~/.gezel/projects/{id}/quarantine/` beside it holds connector content the scanner refused (`Store.projectQuarantineDir`). See [ADR 0021](docs/decisions/0021-read-only-folders.md)
  - `~/.gezel/projects/{id}/artifacts/shadow/` — the reserved shadow-file cache: markdown twins of workspace content (sandboxed squisq conversions of office docs from the static index pass; vision descriptions and STT transcripts from the AI tier), laid out as `<parent>/<basename>_files/<stem>.md` and owned by the content indexer ([index-store/docs.ts](packages/service/src/index-store/docs.ts) + [index-store/ai-shadow.ts](packages/service/src/index-store/ai-shadow.ts)). Lives under artifacts — never the (possibly read-only) workspace — write-denied through the artifact store, hidden from listings, orphan-swept, regenerable, safe to delete. See [ADR 0005](docs/decisions/0005-indexing-3.0.md).
  - `~/.gezel/projects/{id}/digest-state.json` — weekly-digest idempotency state, owned by [ProjectDigestGenerator](packages/service/src/digest/generator.ts)
  - `~/.gezel/projects/{id}/captures/<corpus>/` (`projectCapturesDir`, the per-account private sidecar) — pictures a camera binding saved under its storage policy, owned by [connectors/live/camera/captures-store.ts](packages/service/src/connectors/live/camera/captures-store.ts). Bounded by the binding's `keepDays` and `maxGigabytes`, paused when the disk runs low, deleted with the binding unless the person keeps them. Never in artifacts (which may be cloud-synced or machine-shared) and never written through Store (which would mark the project active on every frame)
  - `~/.gezel/projects/{id}/lookouts.json` and `lookout-state.json` — the person's lookouts and the daemon's counters plus last 25 firings, owned by [LookoutManager](packages/service/src/lookouts/manager.ts) through `Store.listLookouts`/`writeLookouts`/`readLookoutState`/`writeLookoutState`; never in `project.json`, whose `updatedAt` reads as activity. `~/.gezel/lookouts/` holds the install-wide daily ceilings (`daily.json`), synthesized alert clips (`sounds/`) and spoken alerts (`speech/`); derived except `daily.json`
  - `~/.gezel/projects/{id}/thumbs/` (`projectThumbnailsDir`, the per-account private sidecar) — small JPEG thumbnails of workspace photos for grids, albums, search and the morning view, owned by [index-store/thumbnails.ts](packages/service/src/index-store/thumbnails.ts) and served by `GET /api/projects/:id/index/thumb`. Keyed by path, size, mtime and width (160/320/640), least-recently-served pruned past 512 MB, made by `sips` on macOS and pure JS elsewhere. Deliberately not under `artifacts/shadow/` (orphan-swept, readable by gezels) nor the workspace. Regenerable, safe to delete
  - `~/.gezel/handboek/narration/` — content-hash-keyed TTS narration WAVs + duration sidecars for Handboek articles, owned by [handboek/narration.ts](packages/service/src/handboek/narration.ts); derived cache, safe to delete
  - `~/.gezel/gezels/{id}/poppetje.json` — the resolved Poppetje struct (body shape, skin, hair, hat, etc.) driving the parametric figure renderer, owned by [PoppetjeManager](packages/service/src/poppetje/manager.ts). Persisted explicitly so adding new catalog entries or tuning slot odds later never drifts existing characters.
  - `~/.gezel/system-toolsets/` — two classes of pinned entry. **Eager** ones (Playwright + its Chromium) install at boot via [system-toolsets/bootstrap.ts](packages/service/src/system-toolsets/bootstrap.ts). **On-demand** ones (`onDemand: true` in the manifest — today only `@github/copilot-sdk`) install only when the user asks, through [system-toolsets/install-registry.ts](packages/service/src/system-toolsets/install-registry.ts). Read them back with `resolveInstalledSystemLibrary`, not `resolveSystemLibraryPath`: the strict resolver returns `null` on a version mismatch, which is right for eager entries the bootstrap upgrades in place, and would un-install every existing user of an on-demand entry the moment its pin moved.
  - `~/.gezel/knowledge/` — installed `.gezk` knowledge catalogs: `registry.json` (the authoritative per-user record of installed/enabled catalogs), immutable extracted versions under `catalogs/<publisher>/<catalog>/<version>/<digest16>/`, and resumable `downloads/`. Owned by [KnowledgeRegistry](packages/inference/src/knowledge/registry.ts) + [KnowledgeManager](packages/inference/src/knowledge/manager.ts); catalog SQLite is only ever opened read-only+immutable, on the knowledge worker thread
  - `~/.gezel/git-clones/` and per-project checkouts (`workingDir`, `<workingDir>/gh/`, or the project workspace) — git working copies, owned by [git/manager.ts](packages/service/src/git/manager.ts)'s `resolveCheckout`
  - `~/.gezel/projects/{id}/diffpacks.json` plus `artifacts/diffpacks/<packId>/` — change proposals a gezel drafted but never applied, owned by [diffpack/manager.ts](packages/service/src/diffpack/manager.ts). The pack folder holds `after/` (the copy-on-write draft tree the re-rooted workspace-write tools land in), `files/` (the sealed single-file unified diffs), `notes.md`, and `manifest.json`. `after/` and `files/` are written straight to disk by [diffpack/draft-store.ts](packages/service/src/diffpack/draft-store.ts) and are write-denied through the artifact store (`isReservedDiffpackArtifactPath`), so a model cannot forge a diff it never drafted; `notes.md` stays writable because explaining the fix is the model's job
  - `~/.gezel/projects/{id}/artifacts/prompts/<draftId>/` — **chat prompt drafts**: `message.md` (the prompt), `message_files/` (its uploads, referenced document-relatively as `message_files/<name>` while editing and rewritten to `artifacts/prompts/<draftId>/message_files/<name>` at send time), and `draft.json` (thread association, status, sent stamps). Owned by [prompt-drafts/manager.ts](packages/service/src/prompt-drafts/manager.ts); surfaced at `/api/projects/:id/prompt-drafts`. `draftId` is `YYYY-MM-DD-NNNN` — the date is decoration, the zero-padded project-wide sequence is the identity, allocated by scanning folder names under a per-project `KeyedLock` so there is no counter file to corrupt. The manager never calls `touchProject`: autosave writes here about once a second and `project.updatedAt` is read elsewhere as "the project saw activity". Readable by gezels and write-denied to them via `isReservedPromptDraftArtifactPath`, which is **gezel-conditional** (like the connector-corpus guard, unlike `shadow/`) because the composer writes `message_files/` through the ordinary artifact raw route. Sent drafts are swept after `config.promptDrafts.keepSentDays` (default 90, `0` = forever) by [prompt-drafts/sweeper.ts](packages/service/src/prompt-drafts/sweeper.ts); that also removes bytes an old transcript still displays, which is why the window is generous. Unsent drafts are never auto-deleted, and a draft with no text and no files is deleted on save. `artifacts/attachments/` is deprecated for new uploads but still read
  - `~/.gezel/projects/{id}/input-staging/<stagingId>/` — `meta.json` + `files/`: craftbook-input uploads the user picked from their computer but has not launched yet, owned by [InputStagingManager](packages/service/src/tasks/inputs/staging.ts). The client streams the bytes in (the daemon never opens a host path it was handed), and launch adopts the folder into `artifacts/tasks/<num>/inputs/<param>/` with one same-volume rename — which is why it sits beside `artifacts/`, not under it. That adopted folder is **gezel-conditionally write-denied** (`isTaskInputArtifactPath`, like `prompts/`): a run that could edit its own source could make any gate pass. Unlaunched staging is swept after a day. Session tokens cannot reach the staging routes. See [docs/craftbook-inputs.md](docs/craftbook-inputs.md)
  - `~/.gezel/projects/{id}/artifacts/data/{corpus}/tables/` — **observation
    corpora**: the tabular connector shape, mirrored as Hive-partitioned Parquet
    (plus not-yet-compacted NDJSON) with a per-table `manifest.json` semantic
    layer and `state.json` bookkeeping, owned by
    [observations/writer.ts](packages/service/src/observations/writer.ts) and
    [observations/compactor.ts](packages/service/src/observations/compactor.ts).
    Deliberately NOT underscore-prefixed, so it inherits
    `isProtectedConnectorCorpusPath`'s existing gezel-write denial rather than
    needing a second guard. Never text- or vector-indexed — `artifacts-indexer.ts`
    skips the subtree at the directory level, which protects the project's other
    corpora as much as it saves work. Gezels read it only through
    `list_tables` / `describe_table` / `query_table`. See
    [docs/observation-corpora.md](docs/observation-corpora.md) and
    [ADR 0009](docs/decisions/0009-observation-corpora.md)
  - `~/.gezel/projects/{id}/artifacts/tabular/` — **workspace tables**: Parquet
    derived from spreadsheets and large data files in the project *workspace*,
    laid out as `<parent>/<basename>_tables/tables/<table>/` and owned by
    [observations/workspace-tables.ts](packages/service/src/observations/workspace-tables.ts)
    + [workspace-xlsx.ts](packages/service/src/observations/workspace-xlsx.ts).
    A **snapshot** of one file, not a stream: rebuilt wholesale when the source's
    content hash moves, swept when it is deleted, so no sealing, partitioning,
    rollups or retention apply. Write-denied unconditionally (unlike a connector
    corpus, whose guard is gezel-only) because a hand edit would simply be
    overwritten. Never text- or vector-indexed. Regenerable, safe to delete. See
    [ADR 0011](docs/decisions/0011-workspace-tables.md)
  - `~/.gezel/projects/{id}/code-reviews.json` — durable code-review records (kickoff → task ref → settled outcome), owned by [git/reviews.ts](packages/service/src/git/reviews.ts)'s `CodeReviewManager`; the snapshot inputs and reports live in the project artifacts drawer under `reviews/<reviewId>/`
  - `~/.gezel/sandbox/` — legacy; nothing writes it now. Sandboxed runs ([sandbox/runner.ts](packages/service/src/sandbox/runner.ts)) use an OS-temp `gezel-task-*` folder removed after each run; the storage registry still lists this one so an older copy can be reclaimed
  - `~/.gezel/python/` — uv runtime, owned by [python/uv-runtime.ts](packages/inference/src/python/uv-runtime.ts)
  - `~/.gezel/engines/face-models/` — sha256-pinned ONNX face models (YuNet detection + AuraFace embeddings), downloaded on the face-recognition opt-in and owned by [index-store/face/catalog.ts](packages/service/src/index-store/face/catalog.ts); safe to delete, re-downloaded on the next face-tier run
  - `~/.gezel/engines/relevance-models/<id>/` — sha256-pinned ONNX cross-encoders for the optional relevance check, laid out like their Hugging Face repo with an `installed.json` marker written last, owned by [relevance/install.ts](packages/inference/src/relevance/install.ts) (`GEZEL_RELEVANCE_MODELS_DIR` repoints it — evals share one copy). Downloaded when the check is on (first run turns it on for new installs; the boot step fetches a missing model) and only when the security policy allows app network; safe to delete
  - `~/.gezel/engines/hf-cache/onnx-community/embeddinggemma-2-ONNX/<revision>/` — the media-search model (EmbeddingGemma 2, q8 text model + vision encoder, and the audio encoder on first video/audio work), every file sha256-pinned in [media-search/install.ts](packages/service/src/media-search/install.ts) and written into the transformers cache's pinned-revision layout, so the catalog profile embedder (`embeddinggemma-2-512@1`) and the workspace media lane share one verified copy; `.gezel-media-installed.json` is written last. Owned by [MediaSearchManager](packages/service/src/media-search/manager.ts), downloaded only when Settings → Image recognition has media search on and the security policy allows app network, and on a new install not before its first project finishes or the first-use hold releases (`first-run/optional-downloads.ts`, which also defers the image reader first run's model install skips); the workspace lane loads local files only, so an index pass never starts a download. Vectors land in each project index's `media_vectors` (photos, and 30-second video/audio windows cut by the system ffmpeg). Safe to delete; see [ADR 0019](docs/decisions/0019-multimodal-embeddings.md)
  - `~/.gezel/engines/duckdb/<version>/` — the vendored DuckDB CLI, pinned in [duckdb-pin.ts](packages/core/src/native/duckdb-pin.ts) and written by **two** installers that share the directory on purpose: the Electron supervisor's [extract-duckdb.ts](packages/app/src/supervisor/extract-duckdb.ts) and, for npm/CLI installs, the engine resolver's vendored download path. DuckDB is redistributed exactly as the DuckDB Foundation signed and notarized it, so it is NOT part of the `native/` build pipeline and has no artifact in the native release — it is a bundled runtime beside node and pnpm. Safe to delete; either installer recreates it.
  - `~/.gezel/engines/mxc/<version>/` — Windows only: Microsoft's signed MXC launcher `wxc-exec.exe` plus `.verified.json`, pinned in [mxc-pin.ts](packages/core/src/native/mxc-pin.ts) and written by the supervisor's [extract-mxc.ts](packages/app/src/supervisor/extract-mxc.ts) or, for npm/CLI installs, the engine resolver's `resolveVendoredMxc`. Read by [sandbox/windows-mxc.ts](packages/service/src/sandbox/windows-mxc.ts) when `GEZEL_MXC_EXEC` is unset. Redistributed exactly as Microsoft signed it, like DuckDB. Safe to delete; either installer recreates it
  - Native binary trees (`~/.gezel/bin/llama-cpp/`, `sd-cpp/`, `uv/`) — owned by the matching provider; see [native/README.md](native/README.md) for the upstream fetch + bundle pipeline.

  If you're writing code that touches state outside this list, it goes through `Store`.
- **Path-safety primitives live in [packages/inference/src/fs/safe-paths.ts](packages/inference/src/fs/safe-paths.ts).** Anything that constructs a path from user/model input must funnel through `safeJoin` or `realpathContained` — the file's header explains the three latent bugs the naive `normalize(join(base, p)).startsWith(base)` pattern hides.
- **`ChatManager` owns sessions.** HTTP handlers should be thin wrappers. Tests that inject a pre-seeded `providers` map are the way to exercise chat flow deterministically.
- **MCP tools are how agents act.** If you find yourself teaching a gezel to "describe" doing something, consider adding a tool instead.
- **about.md is for character, not tool listings.** A gezel's about.md (role templates live in [bendyline/gilde](https://github.com/bendyline/gilde) under `data/gezel-templates/`) describes role, expertise, working style, preferences — the part that gives the gezel personality. The tool listing is auto-injected at session-build time as a `## Tools available this turn` block in the system prompt, sourced from the post-allowlist MCP bridge tools and the installed third-party toolset ids. Renderer in [chat/tools-block.ts](packages/service/src/chat/tools-block.ts), wired in [chat/manager.ts](packages/service/src/chat/manager.ts)'s `buildInstructions`. Don't enumerate tools in default about.md templates — they drift, the runtime doesn't, and the staleness is invisible until a model fabricates a call to a tool that doesn't exist (the McKinley Park weather incident: about.md said `browser_navigate`, `@playwright/mcp` wasn't loaded, the model emitted `<browser_navigate ... />` markup the salvage layer correctly refused to promote). The decision and its regression surface are recorded in [ADR 0001](docs/decisions/0001-runtime-tool-inventory.md).
  - Power-user override: a per-gezel `~/.gezel/gezels/{id}/tools.md` file fully **replaces** the auto-injected listing when present. The gezel's owner accepts responsibility for keeping it accurate. Path helper: [`gezelToolsPath`](packages/core/src/paths.ts). Drift in this file is detected by `ensureState`'s rebuild check the same way `about.md` drift is.
- **Editing prompts.** Read [docs/prompt-stack.md](docs/prompt-stack.md) first — it maps every layer of the system prompt, the per-turn prelude/nudge channel, and how delivery differs per provider (local vs cloud). Prompt text lives in exactly two homes: universal/standing text in `buildInstructions` in [packages/service/src/chat/manager.ts](packages/service/src/chat/manager.ts) (which also holds `CONTINUATION_NUDGE`, `VOORMAN_IDLE_NUDGE`, `CLOSING_SUMMARY_NUDGE`), and model-conditional text as a behavior in [packages/service/src/model-profile/behaviors/](packages/service/src/model-profile/behaviors/) (tier defaults in [defaults.ts](packages/inference/src/model-profile/defaults.ts), toggleable per daemon via `GEZEL_FORCE_BEHAVIORS`/`GEZEL_REMOVE_BEHAVIORS`). These prompts compound — guardrail + about + project context can pass 2000 tokens before the user's question — so verbosity costs attention at depth, especially on small local models. Imperative over explanatory, and ask "is this for the model or for a future engineer?" before adding a block. Measure real sizes with `GEZEL_PROMPT_BREAKDOWN=1`.
- **Supervisor branches extract their disk/process logic into a sibling helper with its own test.** [extract-bundle.ts](packages/app/src/supervisor/extract-bundle.ts), [extract-node.ts](packages/app/src/supervisor/extract-node.ts), [extract-pnpm.ts](packages/app/src/supervisor/extract-pnpm.ts), [native-bin.ts](packages/app/src/supervisor/native-bin.ts), and [llama-backend.ts](packages/app/src/supervisor/llama-backend.ts) are the exemplar pattern. New supervisor branches follow the same shape so [index.ts](packages/app/src/supervisor/index.ts) stays an orchestrator.
- **A local engine never uses Node's global `fetch`.** undici caps `headersTimeout`/`bodyTimeout` at 5 minutes, and an engine routinely exceeds that before its first byte — a 72k-token prefill on a 27B at 7 tok/s is a quarter of an hour. Every engine provider already owns its real deadline via an `AbortController` budget scaled to prompt size; undici's 300s is a second, invisible deadline underneath it and always the shorter one. The zero-timeout dispatcher has exactly one owner, [patient-fetch.ts](packages/inference/src/providers/patient-fetch.ts) — never write a second copy. Provider *classes* keep `opts.fetchImpl ?? fetch` on purpose: that fallback is the seam their test suites stub `globalThis.fetch` through. The obligation sits one level up on the **builder** — a `*factory.ts` / `build-provider.ts` under `providers/` must pass `fetchImpl: patientFetch()`, or carry a file-level `// patient-fetch-exempt: <reason>` (remote APIs, downloads, and in-process engines are legitimately exempt because they *should* time out, or have no request at all). Enforced by `scripts/check-patient-fetch.mjs`. This exists because the fix was rediscovered and copy-pasted five times while the sixth engine (MLX) was missed: six turns died at ~300s against declared budgets of 595–900s, each reported as "the engine crashed or ran out of memory — retry the turn", which could not work, since the same prompt hit the same wall every time. The guard found a seventh candidate on its first run.
- **Long-running deadlines budget in AWAKE time, not wall clock.** Anything that can outlive a laptop nap — engine turns, one-shots, MCP tool calls, engine idle eviction — measures its budget with [`AwakeBudget`](packages/core/src/suspend-clock.ts) / `createAwakeTimeout`, never `Date.now() + ms` or `AbortSignal.timeout`. A host suspension freezes the daemon, the engine subprocess, and the socket between them alike, so wall clock spent asleep is time the work could not possibly have used; charging it produces failures like `afterMs=1002151 [Mac AI] timed out after 180s`, where the 822 s difference was macOS dark-wake sleep. Suspension is self-detected by a heartbeat that notices its own gap (`startSuspendMonitor`, started in `startService`), so it works identically embedded, spawned, and as a system service — Electron's `powerMonitor` is a refinement on top, never the mechanism. Two rules follow: poll a deadline rather than arming a single timer (an armed timer fires on the wake-up burst, which IS the bug), and dispose the poll when the work finishes — a per-call timer left running for a 35-minute budget is the sort of background wakeup that stops a CPU idling.
- **Use the logger, not `console`.** Production code logs through [packages/core/src/log.ts](packages/core/src/log.ts) (`createLogger('chat')`, `.debug/.info/.warn/.error`). Levels are gated by `GEZEL_LOG_LEVEL` (`debug|info|warn|error|silent`, default `info`). `console.*` is reserved for one-shot CLI output and tests.
- **Electron changes require a full rebuild**. The service is bundled into the Electron bundle at build time; `pnpm app` does `pnpm build && electron .`.
- **No emojis in committed files** unless a user explicitly requested one (the ⭐ Meester badge in the sidebar is the exception — the user asked for it).
- **American English spelling in anything a person reads** — UI, Handboek, prompts (*practice*, *color*, *organize*, *labeled*). Input matchers still accept British spellings. See [docs/ux.md](docs/ux.md).
- **No trailing comments explaining what code does.** Prefer naming + structure. Reserve comments for *why* — hidden constraints, past incidents.

## Development

- A pnpm stale-dependency warning is informational and never authorizes dependency mutation. Use existing binaries for ordinary checks; do not install or repair merely to remove a warning.
- `pnpm deps:status` — read-only diagnosis. `pnpm deps:install` installs only genuinely missing dependencies. `pnpm deps:repair` is the explicit, confirmed reconciliation path. Bare `pnpm install` is rejected because concurrent installs can corrupt the shared `node_modules` tree.
- `pnpm build` — full workspace build; required before `pnpm test:e2e` or `pnpm app`.
- `pnpm build:bundle` — build the relocatable service bundle via `pnpm deploy --prod`. Output at `packages/app/dist/service-bundle/`. Needed before packaging a distributable.
- `pnpm build:packaged` — shortcut: `build` + `build:bundle`.
- `pnpm typecheck` — runs `tsc --noEmit` across every package.
- `pnpm test` — Vitest across every gezel package. ~3m45s on an 18-core workstation, ~12 min on CI. The service suite is ~90% of that on its own; scope to one package (`pnpm --filter @bendyline/gezel-ui run test`) while iterating.
- `pnpm test:ci` — same suites, one package at a time. What CI runs: the 4-vCPU runner cannot absorb several package worker pools at once, and the contention starves fixed test timeouts. Use locally only to reproduce a CI-only timing failure.
- `pnpm test:e2e` — Playwright Electron suite. ~25s.
- `pnpm app` — build, then launch the Electron shell (embedded mode by default). Between the two, [ensure-native-binaries.mjs](scripts/ensure-native-binaries.mjs) checks `packages/app/native-bin/` against the pinned native release with the supervisor's own verifier and fetches the pinned version when it does not match, so a native bump reaches dev launches without a manual `fetch:native`. It never blocks the launch; `GEZEL_NATIVE_FETCH_SKIP=1` opts out. `app:clean` and `app:new` run it too.
- `pnpm app:new` — the same, against a brand-new home (`~/.gezel-new`, wiped every run) to walk first-run flows as a new install sees them; `-- --keep` relaunches into it without wiping, `-- --home=<path>` moves it. Models download fresh unless `GEZEL_READONLY_MODEL_HOMES=$HOME/.gezel-dev` is set. ([scripts/app-new.mjs](scripts/app-new.mjs))
- `pnpm dev` — watch-mode build across every gezel package.

### Supervisor env flags

- `GEZEL_EMBEDDED=1` — force embedded mode (no separate daemon). Set in every existing E2E spec for speed and determinism. Use during dev when iterating on service code.
- `GEZEL_SERVICE_HOST=utility|in-process` — where an embedded service runs. Unset, development launches use a utility process and packaged builds and E2E (`GEZEL_E2E=1`) run in-process; see the Embedded branch above.
- `GEZEL_SPAWN=1` — dev-mode opt-in to spawn `gezeld` from `packages/service/dist/bin/gezeld.js` as an attached child. Exercises the real supervisor path locally. Exercised by [supervisor-spawn.spec.ts](packages/app/e2e/supervisor-spawn.spec.ts).

### Bundled runtimes

The Electron app ships two binary runtimes asar-unpacked alongside the service bundle, so packaged-mode users don't need system Node or pnpm:

- **pnpm** — build-time fetch [fetch-pnpm.mjs](packages/app/scripts/fetch-pnpm.mjs) + runtime extract [extract-pnpm.ts](packages/app/src/supervisor/extract-pnpm.ts) land the pinned ordinary, platform-neutral pnpm npm package at `~/.gezel/bin/pnpm-runtime/`. Supervisor sets `GEZEL_PNPM_PATH` to `bin/pnpm.mjs`; `resolvePnpmCommand` launches it through `GEZEL_NODE_PATH` on Windows, macOS, and Linux, falling back to `pnpm` on PATH when unset. Gezel does not redistribute pnpm's standalone executable. Version + package/license pins live in [pnpm-version.ts](packages/app/src/pnpm-version.ts); bump via `node scripts/bump-pnpm.mjs <version>`. Placeholder (zeros) shas are a hard build error — set `GEZEL_PNPM_SKIP=1` at build time to opt out (dev iteration without bumping).
- **Node.js** — same shape: [fetch-node.mjs](packages/app/scripts/fetch-node.mjs) + [extract-node.ts](packages/app/src/supervisor/extract-node.ts) land the pinned `node[.exe]` binary at `~/.gezel/bin/node[.exe]`. Supervisor sets `GEZEL_NODE_PATH`; the sandbox runner prefers it over bare `node` on PATH. Version pin in [node-version.ts](packages/app/src/node-version.ts); bump via `node scripts/bump-node.mjs <version>`. Placeholder shas hard-fail; `GEZEL_NODE_SKIP=1` opts out. On Windows we download a standalone `node.exe`; on macOS/Linux we extract only the `bin/node` binary out of the official tarball via the `tar` package.
- **Windows script sandbox (MXC launcher)** — Windows only: [fetch-mxc.mjs](packages/app/scripts/fetch-mxc.mjs) + [extract-mxc.ts](packages/app/src/supervisor/extract-mxc.ts) land Microsoft's signed `wxc-exec.exe`, taken byte-for-byte from the `@microsoft/mxc-sdk` npm tarball, at `~/.gezel/engines/mxc/<version>/`. When packaged, the supervisor replaces any inherited `GEZEL_MXC_EXEC` with that verified copy; npm/CLI installs download it through `resolveVendoredMxc` at boot when App network is allowed. Pin in [mxc-pin.ts](packages/core/src/native/mxc-pin.ts); bump via `node scripts/bump-mxc.mjs <version>`; `GEZEL_MXC_SKIP=1` opts out. See [ADR 0022](docs/decisions/0022-windows-mxc-sandbox.md).

Both runtime paths are exposed via `process.env` (`GEZEL_PNPM_PATH` / `GEZEL_NODE_PATH`) to spawned children that inherit the env. pnpm launches must go through `resolvePnpmCommand` (or core's `resolvePnpmInvocation`) so the script and Node runtime stay paired.

### Home directory per launch

`GEZEL_HOME` resolution is layered. Machine services use installer-owned system homes: `C:\ProgramData\Gezel` on Windows, `/Library/Application Support/Gezel` on macOS, and `/var/lib/gezel` on Linux. User-context spawn/embedded launches resolve `GEZEL_HOME` in this order: `--gezel-home=<path>` CLI arg → `GEZEL_HOME` env var → `~/.gezel-dev` (dev) → `~/.gezel` (packaged fallback). The `--gezel-home=<path>` flag additionally forces embedded mode.

### Driving a real daemon from a separate shell

`pnpm dev` + `pnpm app` give you an embedded service by default — fast but skips the real HTTP transport. To exercise the full daemon-mode architecture locally:

```bash
# terminal A — run gezeld attached, on a known port
pnpm --filter @bendyline/gezel-cli exec gezel start --port 8080 --foreground

# terminal B — point the Electron shell at that daemon
# (after running pnpm build once)
GEZEL_EMBEDDED=1 pnpm app   # still embedded — to hit the foreground daemon,
                             # set service.url in ~/.gezel/config.json
```

`gezel start --port N --foreground` spawns gezeld with inherited stdio (Ctrl+C stops it) and a specific port. With just `--port N` (no `--foreground`), it detaches as usual. With neither flag, it's the old "ensure running on ephemeral port" behavior.

For automated coverage, [packages/cli/src/daemon-integration.test.ts](packages/cli/src/daemon-integration.test.ts) spawns a real `gezeld` and drives it with the real `GezelClient` — the one test that would catch token/transport bugs the in-process integration tests miss. Runs in ~0.5s.

### Testing patterns

- **Isolation**: `await mkdtemp(join(tmpdir(), 'gezel-…'))` + `GEZEL_HOME=<dir>`. Always `rm` on cleanup. The Store is instantiated per-test.
- **No real credentials in tests.** Use `MockProvider` directly (injected via `ChatManager({ providers: [['copilot', mock]] })`) or set `GEZEL_MOCK_PROVIDER=1` for integration tests that boot the full service.
- **Memory is stubbed** in unit tests via a no-op `MemoryManager`-shaped object — the real one pulls in a sentence-transformer model on first use.
- **MCP coverage**: `packages/service/src/providers/mcp-bridge.test.ts` spawns the real gezel-mcp server and exercises `callTool` end-to-end. `packages/service/src/chat/manager-mcp.test.ts` scripts tool calls through MockProvider to prove the full chat → bridge → server → disk loop.
- **Service test workers run with `--no-wasm-tier-up`** ([packages/service/vitest.config.ts](packages/service/vitest.config.ts), guarded by [src/test-pool.test.ts](packages/service/src/test-pool.test.ts)). Without it a fork occasionally dies with "Worker exited unexpectedly" *after* its tests pass — V8 hits a fatal zone OOM tier-up-compiling a hot web-tree-sitter grammar in the background. Vitest 4 removed `poolOptions`, so `execArgv` is a top-level option and must be set per project.

## Gotchas

- **MCP package exports must include `./dist/server.js`.** The service uses `require.resolve('@bendyline/gezel-mcp/dist/server.js')` to find the stdio entrypoint. If someone shrinks the mcp package's `exports` field, chat sessions silently run without tools (no error — just log line `@bendyline/gezel-mcp not found`).
- **Service package exports must include `./dist/bin/gezeld.js`.** Same pattern as above: the supervisor and CLI use `require.resolve('@bendyline/gezel-service/dist/bin/gezeld.js')` to spawn the daemon. Modern Node's `exports`-strict resolution will throw `ERR_PACKAGE_PATH_NOT_EXPORTED` without this entry, breaking spawn mode across the board (dev, packaged, and the CLI's `gezel start`). Both this and the MCP entry above are now covered by [tests/published/criticalSubpaths.test.ts](tests/published/criticalSubpaths.test.ts), along with every other by-string resolution in the repo.
- **`dist/` assets staged by a build hook are invisible to the build's own success.** `packages/service/tsup.config.ts` copies `packages/ui/dist` → `dist/ui/` and `docs/handboek` → `dist/handboek-content/` in an `onSuccess` hook. If a probe path is wrong the daemon just *warns* and serves less, and in this repo the source-checkout fallbacks hide it entirely — `findHandboekContent()` looked for `handboek-content` beside the running module, which is correct for `dist/index.js` but not for `dist/bin/gezeld.js`, the one entry point an npm install runs. It silently degraded for every npm consumer while working fine in dev. `pnpm check:packages` boots the daemon from an installed tarball and fails on those warnings.
- **The in-app Handboek is a `.gezk` the service build makes, not the docs tree, and it is never committed.** Knowledge → Handboek reads `dist/handboek.gezk`, which the service build stages from `packages/service/assets/handboek/handboek.gezk`, a git-ignored local cache beside its `handboek.gezk.lock.json` ([scripts/handboek-gezk-lock.mjs](scripts/handboek-gezk-lock.mjs)). The committed copy conflicted on nearly every merge that touched the docs, and v1.26273.82 shipped one built a commit before its What's-new article was renamed. The lock hashes the inputs (docs/handboek, the Handboek engine, the catalog loader, the builder, the Gilde pin) and the rendered articles: a build with no archive builds one (~1 min, plus the BGE model's first download), and a build whose inputs moved re-renders (~14 s) and re-embeds only when the articles changed (~50 s). A local build that cannot embed warns and stages no Handboek (the daemon runs without one); under CI it fails, and `build-service-bundle` refuses a tree without one. CI restores the archive, lock and model from the Actions cache in `setup-workspace` (`handboek-cache: 'false'` for jobs that never build the service); an older entry is safe because the lock re-checks it. The builder writes the archive beside itself and drops the lock before swapping it in, because the next build trusts the archive on the lock's word. The archive is not keyed on the service version on purpose: release tooling bumps that on its own.
- **A GitHub token is optional for engine downloads, and must stay optional.** `bendyline/gezel` is public. [engines/resolver.ts](packages/inference/src/engines/resolver.ts) uses a token only to lift GitHub's 60-request/hour unauthenticated API limit. Do not reinstate a hard token gate: users who installed from npm have no `gh` login, and requiring one makes on-device engines unreachable for everyone outside this repo.
- **Copilot SDK needs time on first call.** Cold-start ~30–90s. Timeouts below 120s flake. The SDK also sometimes rejects `sendAndWait` with "Timeout waiting for session.idle" *after* the model has already streamed a full response — we buffer deltas and fall back to the buffered content when that happens. See `copilot.ts`/`openai.ts` `CopilotSession.sendAndWait`.
- **A packaged build with Copilot not installed fails *fast*, not slow.** Don't diagnose it as a cold-start timeout. The SDK is an on-demand toolset and is stripped from the shipped bundle by `pnpm deploy --prod`, so `loadSdk()` throws immediately; the error says "install it in Settings" and carries `isActionable = true`. That marker is load-bearing — without it `ChatManager.ensureProvider` rewrites the message into "check your credentials", pointing at the wrong problem.
- **OpenAI's native MCP is HTTP-only.** The OpenAI Responses API's `tools: [{type: 'mcp', ...}]` shape only accepts HTTP remote servers, so it can't talk to stdio MCP servers like `@bendyline/gezel-mcp`. We work around this by running the bridge ourselves: [packages/service/src/providers/mcp-bridge.ts](packages/service/src/providers/mcp-bridge.ts) is a unified MCP client that dispatches between `StdioClientTransport` and `StreamableHTTPClientTransport` (plus SSE for older servers) via the `isHttpSpec()` discriminator on the spec. Both `OpenAIProvider` and `AnthropicProvider` consume the same `McpBridgePool` — there's no per-provider bridge ownership. Don't try to plug stdio specs into OpenAI's native MCP tool shape; route everything through the pool.
- **Textual tool-call markup cannot carry nested arguments.** Every salvage format in [local-tool-call-salvage.ts](packages/inference/src/providers/local-tool-call-salvage.ts) — Hermes `<parameter=KEY>`, Claude `<parameter>`, GLM `<arg_value>`, XML attributes, shell-style — is a flat KEY→text map, so a parameter declared `object`/`array` arrives as a *string*. Invisible while every wired tool took flat scalars (`path`, `content`, `url`); the first toolset with non-scalar top-level args (DocBlocks `convert_document.source`/`targets`, `save_artifact.destination`) turned it into an unbreakable loop — the validator says `got string, expected object`, the model re-emits the identical correct JSON, the markup flattens it again. Wild-caught at 19 consecutive failed attempts on one craftbook step, after which the gezel rationalized past the gate on a two-day-old artifact. Two defenses, both schema-gated so a genuine string arg (a JSON file's `content`) is never reinterpreted: [tool-arg-schema-coercion.ts](packages/inference/src/providers/tool-arg-schema-coercion.ts) repairs args against the declared schema in `McpBridge.callToolRich` (covers every provider) and again where each local provider's salvage passes merge (so logs, history, and the UI show the real shape); and the MLX Hermes grammar holds an object/array parameter's value to JSON inside its own tag (`<parameter=params>{"topic": …}</parameter>`, the way the Qwen template renders one), keeping the `<tool_call>{json}</tool_call>` envelope only as an accepted fallback (`json-escape=on` in the `[tool-grammar] active` log line). Never *prompt* the envelope: told to use it, a qwen3.8-27b Meester wrote it, closed the XML its template expects, and looped `</function>` to max_tokens (2026-09-23). Prompt text about call syntax comes from [tool-call-idiom.ts](packages/service/src/model-profile/tool-call-idiom.ts), whose examples fixture both the salvage parser test and the token-level grammar test read. If you add a salvage format, route its args through the same coercion — don't teach the coercers to parse JSON blindly.
- **A model-facing tool argument must not be the wire struct when the struct has an optional discriminant partner.** `assignee` published the persisted shape — `{kind:"gezel", gezelId?}` — which reads as two independent choices: pick a kind, then optionally name someone. A 27B Meester routing a PPTX request duly sent `assignee: {kind:"gezel"}` to mean "have a gezel do it", `invoke_craftbook` threw `assignee.kind="gezel" requires gezelId`, and the craftbook route was lost for the turn. The intent was already the default: a craftbook resolves its owner from the entry step's role, so the runtime had nothing to ask for. [assignee-arg.ts](packages/mcp/src/assignee-arg.ts) now publishes a flat string — a gezel id, display name, role name, or `"user"` — with the object form still accepted, and a kind without an id (or a placeholder like `"gezel"` / `"any"`) normalizing to "no one in particular" rather than an error. Only `assign_task`, whose entire contract is *pin a name*, refuses, and it names the roster when it does. Two rules generalize: an argument whose every branch has a sane default should never be able to fail validation, and the model-facing shape is a separate design decision from the persisted one — `list_tasks({ assignee })` had taken the flat string all along.

- **A fixed-function gezel never fills a role.** The direct image gezel forwards one message to one tool, so it cannot read a brief, write the SVGs a book asks for, or make the three renders a `fileCount` gate wants. Role matching skips fixed-function gezels and templates everywhere it happens: `resolveGezelTemplateForRole` (core `gezels/templates.ts`), `ensureGezel`'s roster reuse, and the phone's `recruit`. They are installed only by template id (`resolveGezelTemplateById`; Settings' image gezel hint). Image work for tasks and delegations goes to the gilde **Illustrator** (role "Illustrator", which the matcher reads "image generator" as). `write_file`, `append_to_file` and `write_artifact` refuse raster image paths, so the image role keeps file writes without reopening the petshop fabrication of prose written into `logo.png`. Before this, gilde 9fdf339 (2026-09-01) had denied `images` on the image step of all ten image books, and the direct gezel could not run any of them.
- **A repeated, unresolved tool-validation failure hard-blocks `advance_task_step`.** [unresolved-tool-failure-ledger.ts](packages/core/src/local-loop/unresolved-tool-failure-ledger.ts) (re-exported from `packages/service/src/providers/`) is a session-scoped ledger owned by [McpBridgePool](packages/service/src/providers/mcp-bridge-pool.ts) and shared by every bridge in the session — it has to be pool-scoped because the failing tool normally lives on a third-party bridge while the task tools live on gezel-mcp. Two *identical* validation rejections on the same tool with no later success, and `McpBridge.callToolRich` refuses `advance_task_step` before dispatch with a message naming the blocker. Any success on that tool clears it; a *different* validation error restarts the count (the model changed something real); transport faults, timeouts, and permission denials never count. The refusal tells a blocked step session to record the blocker with `write_task_note` (or in its reply when that tool is not on the roster) and end its turn — never to pause: a step session cannot resume its own paused task and `advance_task_step` refuses a paused one, so a self-pause locks the step out for good (the cap-blocker escalation learned the same thing). `set_task_status` stays ungated because pausing remains the user's and a coordinator's move. This exists because phase gates check the deliverable, not the attempt: on task `default/3` the PPTX from attempt 15 was still on disk, so attempts 16–19 passed the gate while `convert_document` rejected every call, each note teaching the next attempt that the blocker was unfixable.
- **A runtime hint may only name tools the turn actually wired — and only for the right drawer.** The cap-truncation steer in [local-tool-call-salvage.ts](packages/inference/src/providers/local-tool-call-salvage.ts) hardcoded `replace_in_file` / `replace_lines`, which are *workspace* tools. On a writes-off project whose only payload tool is `write_artifact`, it forbade the one call the session could make and prescribed two it could not; the model planned a six-turn replace sequence against an artifact and the task died. The remedy is now roster-checked, and an over-cap artifact write (no incremental artifact writer exists) routes to `write_task_note` + `set_task_status` instead. Same rule for behavior prompts: `filterPromptToolDirectives` is a *lexical* backstop that only drops lines reading as directives, so `prompt.derive-by-execution`'s "write a small Node script and execute it — `derive_file(…)`" survived on a roster with no execution tool at all. Behaviors that steer toward a specific tool gate positively on `PromptCtx.availableToolNames` and return null when it is absent. Same failure class as the McKinley Park incident in [ADR 0001](docs/decisions/0001-runtime-tool-inventory.md), one layer down.
- **A runtime hint may only name a tool for the branch that actually applies this run.** The same rule as above, one layer deeper: `firstAvailableProcedureTool` ([instructions.ts](packages/service/src/chat/instructions.ts)) scans a step procedure for the first backticked tool name and pins it as "First action (once only)" — the last line of the system prompt, and for a reasoning-leaking model the highest-attention one. Its `isGuardedToolMention` companion skips mentions inside conditional or negated clauses, but computed ONE clause for both, bounded at the nearest colon. A condition governs its whole sentence; a negation binds only to the phrase it opens. So powerpoint-deck's step 1 — "When *(empty)* is non-empty, your FIRST source action is to read that exact path: use `read_doc_as_markdown` …" — lost its condition at the colon, and a topic-only Valencia run was ordered to open a document it had no path for while the applicable branch named `search`. The researcher's reasoning kept correctly deriving "call `search` first" and never emitted it — thirteen calls, none of them either tool, ending in a repeat-loop abort. The guard now takes the sentence for conditions and the clause for negations, and treats a sentence containing an empty inline-code span (a craftbook parameter that interpolated to nothing) as a branch this run does not take. Two rules generalize: no anchor beats a wrong anchor, since the surrounding footer already says "begin with the FIRST tool action the procedure names"; and a craftbook branch that interpolates to empty is still *text in the prompt*, so every lexical pass over a procedure has to reason about which branch is live.
- **`read_file` on an office document reroutes to `read_doc_as_markdown`; it never decodes the container as text.** A DOCX read used to return `1→PK\x03\x04…[Content_Types].xml…` — line-numbered ZIP bytes — and the model believed it had the source. Wild-caught on the first binary-source PowerPoint eval: two gezels each "read" the brief that way and the run shipped no deck. The step prompt's "never interpret binary bytes as text" was unenforceable while the tool did exactly that. [cross-drawer-read-tools.ts](packages/mcp/src/cross-drawer-read-tools.ts)'s `rerouteBinaryDocumentRead` now converts and returns a `[Rerouted …]` notice, following the sibling artifact-collision path rather than erroring — a small model handed an error retries the same call, which is the loop shape the repeat tracker exists to kill. Conversion failure falls through to the ordinary read so a corrupt container still reports its real error. Same defect family as the retrieval-hydration binary bug, one layer up: anything that turns a path into text owes a check on what the bytes actually are.
- **Every layer that answers "can this step do what the book asks?" must agree, and five of them did not.** One craftbook — powerpoint-deck with a `.docx` source — was blocked independently by: the eval harness's per-gezel toolset override (which REPLACES the worker's role kit, so the worker had no `doc-intel` and no `search`); [step-tool-kit.ts](packages/service/src/chat/step-tool-kit.ts)'s read core (no `read_doc_as_markdown`); the MCP `read_file` (decoded the container as UTF-8); the `researchEvidence` gate (counted only `read_file` as reading the source, so the researcher opened the .docx correctly and was told three times that no source acquisition ran); and the same kit's WRITE core (no `copy_artifact_to_workspace`, the only non-text workspace writer, so a `.pptx` deliverable had no tool that could deliver it). Each was individually invisible and each blocked the run completely. Two rules generalize. **A tool a step's procedure names must survive every narrowing** — kit intersection, step policy, tier cap, and the gate that judges the result; `promptMandatedTools` exists for this and not every clamp consults it. And **a book's contingency can cause the condition it handles**: "copy it with `copy_artifact_to_workspace`. If that tool is missing, record the blocker" reads to `promptMandatedTools` as an availability fallback, which stops the tool being mandated, which makes it missing. The matcher for "did the assignee open the supplied source" now has one owner in [research-evidence-match.ts](packages/service/src/tasks/research-evidence-match.ts).
- **A tool that writes gate receipts is not a duplicate of a shell.** The Claude CLI and Codex CLI providers hide gezel-mcp tools that overlap their built-ins (`GEZEL_MCP_EXCLUDE`), and that list once included `run_package_script` / `run_npx` because Bash runs the same commands. But a `commandEvidence` gate counts only the `workspace.script.run` / `workspace.npx.run` receipts those runners write — a Bash run leaves none — so every book that proves its work by running the suite was unpassable on both providers: codemod-sweep's verify step rejected "no `npm run test` run was observed" while Opus had already run the suite through Bash, and its search for the runner the gate named found nothing (2026-09-19, both execution modes). The exclusion lists in [anthropic-cli/excluded-mcp-tools.ts](packages/service/src/providers/anthropic-cli/excluded-mcp-tools.ts) and [codex-cli/excluded-mcp-tools.ts](packages/service/src/providers/codex-cli/excluded-mcp-tools.ts) now keep the receipt-bearing runners, pinned by a test. The rule: before hiding a tool as redundant, check whether a gate, a ledger, or a receipt depends on that specific tool having been called.
- **A stepwise craftbook step's `consumes` list is the whole of its working memory.** Every step of a stepwise task runs in a fresh session that knows only what its prompt tells it to open, so a fact an earlier step recorded but the current step does not consume does not exist for it. invoice-run's `scope` step wrote "Ondaatje Books was excluded" into `scope.md`; `collect` consumed only `billables.json` (billable clients by construction) and was asked to "name any client skipped this month", so three small-model runs wrote "No clients were skipped" — while the generalist arm passed the same step 3/3 because the owner had written `scope.md` itself (2026-09-20). The defect is invisible under generalist mode, which remembers, and it is the dominant shape in the catalog: of 206 latest gilde books whose first step writes a scope/plan file, 187 never route it into a later step. The runtime now backs this up for stepwise tasks ([core/tasks/inferred-step-inputs.ts](packages/core/src/tasks/inferred-step-inputs.ts)): a finished step's file that the active procedure names is treated as a required input, and the prompt lists the other files earlier steps left. That catches a named-but-unconsumed file, not a fact the procedure never points at, so `consumes` stays the contract. When authoring or reviewing a stepwise book: every upstream artifact a step's output depends on goes in that step's `consumes` (the runtime renders it as a required input and the small-model first-action anchor), a handoff fact gets a fixed section heading the downstream step can gate with `contains`, and a review step's verdict needs a gate (`checkTaskNoteContains` on PASS/FAIL) or a small model writes "Evaluation Complete" and routes to finish. And a routing decision must not live in a tool argument the model has to remember: the same book's `evaluate` defaulted its edge to the revise loop and asked for `next: "finish"` in prose; one added sentence about writing the verdict note made gemma-12b omit `next` in 7 of 8 advances and cycle for an hour. Route on a written verdict through the gate (`contains PASS` plus `notContains FAIL`, `onReject` to the revise step, `maxAttempts`) and make the forward edge the default.
- **A damper keyed on one input caches verdicts about the others.** The gate's repeat-reject damper skipped re-evaluation whenever the `advanceWhen` file was byte-identical to the last rejection. invoice-run's `scope` step checkpoints on `billables.json` and also gates `scope.md`: an owner that wrote `billables.json` first was auto-advanced, rejected for the missing `scope.md`, then wrote `scope.md` three times and heard "not found" three more times until the plateau ladder paused the task (2026-09-20). The scripted-gate carve-out had fixed the same defect one layer down. [gate-damping.ts](packages/service/src/tasks/gate-damping.ts) now hashes every file the gate reads and never damps a check that reads beyond one file. The rule: a cache key must cover every input the cached verdict depends on, or the cache manufactures stale verdicts on exactly the resubmits that changed something. A review gate, one whose rejections route to another step (`routesRejectionAway` in [gate-escalation.ts](packages/service/src/tasks/gate-escalation.ts)), is never damped and never gets the ladder's edit or rewrite stages: its file is a verdict, where FAIL is the review working. On week-plan those stages told the report writer to rewrite `verdict.md` until "contains FAIL" cleared, while each pass was finding a different, real gap (2026-10-22). The pause on the fourth failed review stays, since a loop back to an earlier step restarts the gate's attempt count.
- **A gate loop-back into a fanout host whose crew has settled runs a revision pass.** The fanout step was idempotent per *task*: any existing child skipped the spawn, so the step stamped its manifest and advanced on the spot. invoice-run's `evaluate` → `draft` loop was therefore a no-op — "Gate looped … back to Draft the invoices", `draft` completed in the same millisecond, and `collect` re-ran over invoices nobody had touched (qwen3.8-27b, 2026-10-01). [fanout-revision.ts](packages/service/src/tasks/fanout-revision.ts) makes it idempotent per *activation*: a re-fire of the same activation, or a re-activation while an earlier crew is still out, never double-spawns (the post-fanout barrier waits); a fresh activation reached through a gate whose `onReject` names the fanout step, after every child settled, re-spawns the template over the current items with a `# Revision pass N` note carrying the gated step's own deliverable (the verdict), inlined because shards rarely have an artifacts reader. Never the gate's message: it is written to the reviewer ("Add that content"), and a shard that obeyed it would write into the reviewer's file. Any other re-activation keeps the old advance-through. The loop stays bounded by the gate's `maxAttempts` because `carryFanoutLoopGateAttempts` keeps `gateAttempts` when the task re-enters a gated step whose rejections route into a fanout — an ordinary upstream loop still earns a clean budget, but each fanout pass buys a whole crew, so the third failed review pauses on `evaluate`, where Try again resets it.
- **A task-step session whose pass is over cannot move its task.** A step session serves one activation (`ChatSession.stepActivationId`, see [session-step-activation.ts](packages/service/src/chat/session-step-activation.ts)); once the task moves on or loops back, its turn answers for work the task already judged. The end-of-turn auto-advance had refused such a session since R4, but its explicit calls had not: invoice-run's reviewer, looped back from `evaluate` and re-prompted anyway, set the task active twice, tried to advance `evaluate`, then paused the whole run (2026-10-01). `sessionRouteGuard` ([scope-guard.ts](packages/service/src/http/scope-guard.ts)) now refuses `POST …/tasks/:num/status` and `…/steps/:id/complete` from a session token whose live record is bound to a stale activation of that task, answering `{ error: 'stale_task_step', hint }` with the message from [stale-step-session.ts](packages/service/src/tasks/stale-step-session.ts) ("Don't change the task — end your turn"); `set_task_status` and `advance_task_step` return the hint verbatim and non-retryable. The binding decides, not the role: an unbound session (the Meester's front door running `manage_task`), a session on another task, and the current pass are unchanged, and first-party clients never reach the guard. There is deliberately no user-turn exemption — the incident's leftover turn was answering its own `ask_user_question`, which `isUserDirectedTurn` counts as the user's. Task notes stay open: a blocker note is the honest exit. The pass's pending plain questions are withdrawn when it ends ([tasks/finished-pass-questions.ts](packages/service/src/tasks/finished-pass-questions.ts), run from the status-change and step-activation hooks): a silent close the card shows as "No longer needed", because answering one started a turn that could change nothing and held the only engine slot (week-plan, 2026-10-21).
- **A loop-breaker corrective must not contradict the step's own output contract.** `ToolRepeatTracker.buildAbortMessage` appended generic ship advice — "do not use `write_artifact`; artifacts are for plans/scratch" — from nothing but "an artifact writer is wired and this was a read loop". On the Valencia research step, whose primary result IS `tasks/18/sources.md` in the artifacts drawer, the same message named `write_artifact` as a required next call and then forbade it two sentences later. The generic hints are now suppressed whenever `activeStep` is set: the step hint already points at the procedure, which is the authoritative answer. Same reason the suggestion list excludes the tool being aborted on — a corrective that argues with itself teaches nothing.
- **A craftbook step must never ask a model to retype data the runtime already has.** Pull Request Review's scope step told the assignee to copy the corpus manifest's batch array into `pr-review/batches.json` — 25 KB / ~7.3k tokens of arguments against a 6144-token cap, i.e. arithmetically impossible. Two cap-length attempts were rejected; a third landed *valid but truncated* JSON with 10 of 21 batches, which `json-valid` + `minBytes` happily passed, silently dropping 259 changed files and deadlocking the downstream merge gate eight attempts later. Deterministic work belongs in an `onEnter` stdlib script ([publishCorpusBatches](packages/script-stdlib/scripts/publishCorpusBatches.ts)), and the fanout input is verified against its source by the `corpusBatches` gate check. Two lessons generalize: a gate that checks *syntax* cannot detect truncation, so gate fanout inputs against the artifact they were derived from; and step-hook `inputs` are interpolated alongside prompts and gates in `interpolateStepsContext` — a hook left out of that walk receives the literal `{{param}}`.
- **A typed project's first draft must be made by its own tools, and the kickoff holds the lead to it.** A Meester `start_project` that routes to a project type hands the lead one "First draft" step with file tools withheld ([kickoff-text.ts](packages/mcp/src/kickoff-text.ts) `typedKickoffWatch`, `runTypedKickoff` in [server.ts](packages/mcp/src/server.ts)). It watches every JSON data file the Output page reads (for a folder page, the store's seeded index inside it) and carries a `totalMinBytes` completion gate at seed + 64 bytes, because `advanceWhen` only auto-advances: Job Hunt and Social Feed leads on Gemma 4 E4B called `advance_task_step` over an untouched board and "finished" with nothing on it, and the eval counted it (2026-10-14). A turn that ends short of the file gets one re-prompt (`unmetGrowthGate` → `buildDeliverableGrowthNudge` in [manager.ts](packages/service/src/chat/manager.ts)). Prose cannot tell that apart from a finish, since the kickoff asks for "the one thing you need from them next". Content rules follow: a type whose first draft needs files staged by hand cannot pass (Social Feed's `create_post` takes the post itself from 1.0.2), and a page-dealt game must let the lead's first look deal (Word Clues' `board` from 1.0.1). Routing ([brief-route.ts](packages/core/src/project-types/brief-route.ts)) never counts a phrasing word (`planning`, `go`, `words`, …) as a type's tag, reads a plural tag in its singular, and lets the person's own sentence settle a brief the meester worded into a tie. The welcome's typed starters open with "Start a project to…" so the build prelude fires, and carry what the lead needs (a company, the clients and amounts); `first-projects.test.ts` pins the prelude.
- **A live `resetClient()` must never force-evict the engine pool.** A pooled engine is a model process keyed by (provider, modelId, replica) — it holds no credentials and no tool surface, so no config change makes the *process* unsafe; only the sessions and MCP children around it, which the reset already disposes. The hard path used to call `pool.shutdown()` (`evict(force: true)`, which skips the bounded 30s drain), so flipping the security posture in Settings SIGTERM'd both resident 27B models and a background craftbook turn four minutes into its first step died with "[Mac AI] the on-device engine dropped the connection" — wording that sends you hunting for an OOM that never happened. `resetClient` now takes `engines: 'release-idle' | 'force'`, defaulting to release-idle ([provider-pool.ts](packages/inference/src/providers/native/provider-pool.ts)'s `releaseIdle`); only emergency stop and service shutdown force. Two rules follow: the router is *kept* on a live reset (dropping it while an engine is resident orphans that process outside the broker's accounting — the reason the old code killed everything), and a message for a dead stream must say whether *we* stopped the engine (`buildMidStreamDropMessage`), since a planned teardown and a crash are the same bare `TypeError: terminated` on the wire.
- **A keyword arm's `relevance` is derived from RANK, not from match quality — so the injection floor cannot be tuned to fix retrieval noise.** RRF scores a rank-0 hit at its arm weight (0.9–1.0) in [index-store.ts](packages/service/src/index-store/index-store.ts)'s `searchCode`, and `ftsRankRelevance(0)` is 0.6, against `INJECTION_MIN_RELEVANCE` floors of 0.18–0.29. The top rows of any arm that returned anything at all clear the floor unconditionally, and raising it just moves which rank survives. "Can you create a PowerPoint about France" injected a heading called "All About DocBlocks" at relevance 0.95 and `strong` tier whose only matched token was `about` — because the sentence reached FTS5 as `"can"* OR "create"* OR "powerpoint"* OR "about"* OR "france"*`, where `france` matched zero rows and the filler matched 25–66 each. Two defenses, and neither is the floor: `queryTerms` drops generic vocabulary before the query is built, and `isGrounded` ([project-retrieval.ts](packages/service/src/search/project-retrieval.ts)) requires a keyword hit to contain a term the user typed in the text it is about to inject. Vector hits are exempt by design — they share no words by nature and have their own cosine floor. If you add a corpus arm, label it `arm: 'vector' | 'fts'` or it is silently exempt from grounding. Knowledge catalogs are the stricter case: grounding is useless against an encyclopedia ("Olive Oil Times" grounds "What is 17 times 23?"), so an unjudged catalog hit is injected only when it is `vector`, and `vector` means it cleared its catalog's measured cosine floor in [knowledge/vector-floors.ts](packages/inference/src/knowledge/vector-floors.ts) — keyed by catalog, then embedding profile, because bge-small's genuine matches sit at 0.57 in project docs and 0.69 in the Handboek. A new catalog or embedder gets measured with `pnpm --filter @bendyline/gezel-evals run knowledge-calibration`, not guessed. The optional relevance model ([search/relevance-stage.ts](packages/inference/src/search/relevance-stage.ts), [ADR 0017](docs/decisions/0017-relevance-model.md)) is the one absolute score in retrieval: a candidate a *calibrated* model scored is kept or dropped on that score and skips the floor and grounding (a knowledge passage must reach `KNOWLEDGE_FILTER_MIN_RELEVANCE`, 0.5, on filter surfaces), and a model without thresholds may reorder but never drop. Its score maps to relevance in logit space between drop and strong; mapped linearly, every raw score from 3e-5 to 0.05 landed on 0.30–0.32. Off or cold must stay identical to no model — `relevance-stage.test.ts` pins it.
- **Hash with a reused buffer, never a big read stream, in anything Electron's main process runs.** A 16 MB `highWaterMark` stream allocates a fresh 16 MB buffer per chunk. In plain Node that is harmless; in Electron main (the supervisor, an in-process embedded service) each allocation cost ~44 ms, and hashing the 1.7 GB Windows CUDA payload left V8 collecting garbage for ~20 s afterwards. Every step behind it starved, and the splash sat at "Starting Gezel" for 36–43 s on a warm dev launch, of which `startService` was 1.3 s. A read loop into one pooled buffer hashed the same payload in 1.1 s with no storm. And a binary that was verified once does not need re-hashing: the installers stamp what they verified ([install-stamp.ts](packages/app/src/supervisor/install-stamp.ts)), and the native verifier keeps a per-file cache (`cacheFile`), so a launch re-hashes only what changed. Several model and engine hash sites in inference and service still use the 16 MB stream, which matters wherever the service runs embedded.
- **`quotaSnapshots` from Copilot is a map, not a single value.** Pro+ users have multiple quota buckets (chat = unlimited, premium interactions = limited). Picking `Object.values(snapshots)[0]` hides the limited one. We surface all buckets and sort most-constrained first.
- **Squisq editor is an external package** ([`bendyline/squisq`](https://github.com/bendyline/squisq)) — some integration points live in that repository, whose local checkout location is not fixed. Use `pnpm link:squisq` when testing a sibling checkout. When a new capability belongs in Squisq (for example, the chat composer's `submitOnEnter` prop), change it there and rebuild before updating Gezel's pinned package versions. One caveat while linked: `pnpm build:bundle` lifts the squisq/gilde `link:` overrides out of `pnpm-workspace.yaml` for the duration of the `pnpm deploy` and restores them afterwards — pnpm cannot materialize a `link:` dep into a deployed tree, so the bundle always reflects the registry pins, not your sibling checkout.
- **Proofing ships harper's WASM, and both binaries are load-bearing.** Spelling/grammar in the squisq editors is the harper.js engine, an *optional peer dependency* squisq reaches only through a dynamic `import('harper.js')`. There is no CDN fallback by design, so the host serves the engine or the feature does not exist: gezel declares `harper.js` in [packages/ui/package.json](packages/ui/package.json) and [scripts/vite-harper-wasm.ts](packages/ui/scripts/vite-harper-wasm.ts) publishes it under `dist/harper/`, from where it rides into `service/dist/ui/` and `app.asar.unpacked/dist/ui/` with the rest of the UI. Four things there are not incidental: (1) **both** binaries ship — the full engine finds its slim sibling by literal filename substitution on its own URL, so a hashed or lone copy 404s inside the worker, which is also why the plugin stubs out `harper.js/binary` (Vite would emit a second, content-hashed, permanently-unloadable 15.8 MB copy); (2) the daemon serves `.wasm` as `application/wasm` — a `.wasm` answered as `200 text/html` by an SPA fallback surfaces as a confusing compile error rather than a clean 404, which is why the static route goes through [http/mime.ts](packages/service/src/http/mime.ts); (3) `script-src` carries `'wasm-unsafe-eval'` in **both** CSPs ([http/server.ts](packages/service/src/http/server.ts) and [app/src/main.ts](packages/app/src/main.ts)) or compilation is refused and the status sticks on "Proofing…" — cross-origin isolation stays off, harper is single-threaded and does not want the SharedArrayBuffer headers that left with the browser ffmpeg encoder; (4) the provider is built lazily and handed to `EditorShell` as an **instance**, never a factory — squisq disposes a factory's provider on unmount, and the editors remount on every document switch against a ~5s cold WASM setup. Which squiggles are shown is a host decision, not an engine one: Settings → General → Documents (`config.inlineSpellChecking` / `inlineGrammarChecking`) drives a category filter inside gezel's own provider wrapper ([proofing.ts](packages/ui/src/components/SquisqIntegration/proofing.ts)), and with both off [useProofingCapability](packages/ui/src/components/SquisqIntegration/useProofingCapability.ts) hands `EditorShell` a `null` capability so no WASM is ever fetched. That hook is also what makes a live toggle reach an open document — squisq keeps its provider once built, so the capability drops to `null` for one tick to make the shell re-lint. Cost is ~15 MB compressed in the service tarball and the installer. Host-integration contract: `docs/proofing.md` in the squisq repo.

- **The published scorecard is HTML on the site and markdown everywhere else.** `::handboek-model-scorecard` renders every recorded round as one raw-HTML block in `site` mode ([renderScorecardFilterHtml](packages/service/src/handboek/macros.ts)), stamped with `data-hb-*` attributes that [handboek-site-scorecard.ts](packages/cli/src/handboek-site-scorecard.ts)'s browser script reads back to filter by machine, model, class, or date, and to carry that choice in the URL. Three things bite. Squisq's markdown sanitizer **drops `select`, `button`, and `script` with their content** and keeps `div`/`table` plus every `data-`/`aria-` attribute — which is why the content is stamped by the renderer and the controls are built at runtime, and why the emitted block must contain **no blank line** (a blank line ends a CommonMark HTML block and the closing tags are dropped as orphans, silently flattening the round containers). The attribute and query-parameter names are constants in [scorecard/filter.ts](packages/core/src/scorecard/filter.ts) and are interpolated into both sides, because a rename that lands on one side is a filter that matches nothing with no error to say why. And the script lives inside a TS template literal, so a stray backtick truncates it and a stray `${` swallows a chunk of the program — both guarded by a parse test in [handboek-export.test.ts](packages/cli/src/handboek-export.test.ts).
- **Gilde content is external** ([`bendyline/gilde`](https://github.com/bendyline/gilde)) — same shape as squisq: sibling checkout at `../gilde` and `pnpm link:gilde` / `pnpm unlink:gilde`. CI and release workflows run `pnpm check:local-links` before dependency installation so a committed `link:` override fails with a clear message. That guard only *enforces* when `CI` is set (or `GEZEL_ENFORCE_LOCAL_LINKS=1`) — a local `pnpm validate` / `pnpm all` just warns, so the full gate stays runnable while linked, and hard-fails only when a link points at a checkout that is not on disk. Content correctness gates run in gezel CI against the *pinned* `@bendyline/gilde` version (the catalog package's data-contract tests), so a bad content release fails here at bump time, before it ships.
- **`@bendyline/gilde` must keep `./package.json` exported.** The catalog loader locates the content root via `createRequire(...).resolve('@bendyline/gilde/package.json')` ([gilde-data.ts](packages/catalog/src/gilde-data.ts)). If a gilde release ships an `exports` map without that subpath, resolution throws and the service boots with an **empty catalog** — no error, just no models/templates/craftbooks. Guarded by `packages/catalog/src/gilde-data.test.ts` (mirror of the mcp `./dist/server.js` gotcha).
- **`gilde/schemas/*.schema.json` are generated from core's Zod schemas.** Regenerate with `pnpm gilde:export-schemas` whenever `packages/core/src/schemas/*` changes, and PR the result to gilde. Drift never fails gezel CI: [gilde-schema-freshness.test.ts](packages/catalog/src/gilde-schema-freshness.test.ts) reports it on stderr and in the GitHub job summary, because the runtime reads content tolerantly (see "not in schema lockstep" above) and a stale snapshot only limits what gilde content can *use*. Gilde CI validation is deliberately *looser* than the runtime (Zod refinements don't survive `z.toJSONSchema`); gezel's `.parse()` of the pinned content stays authoritative. The exporter throws on unrepresentable constructs (e.g. `z.transform`) rather than silently weakening gilde CI. **Forgetting to regenerate is quiet, not silent data loss:** gilde's validation flags content that uses the new value, and the legacy `index.json` (read only by builds that predate `raw-index.json`) drops the item (`build-index --verbose` → `skip … invalid-identity`). Current builds list from `raw-index.json`, which carries the files verbatim, so nothing reaches the daemon through gilde's schema copy.
- **The Default project runs real work — never early-return on it in a task path.** Code written when Default was the "untitled, no real work" bucket skipped it outright, and the Meester now runs craftbooks there. The end-of-turn auto-advance returned early for `projectId === 'default'`, and an artifact-checkpoint step ends the provider turn on its `write_artifact`, so nothing could ever advance the step: `default/11` paused after three identical, valid `sources.md` writes (2026-09-23). The audit that followed found the same assumption in the assigned-tasks prompt block, @mention ranking, approval previews, the stuck-step sweep and retrieval. Two things about Default *are* structural. First, the Meester's front-door chat is a Default session with no `taskRef`, so voorman-style nudges must not treat a casual reply there as a lead stalling. Second, Default always holds the Meester's Night Shift oversight task, active between runs, so "is there live work?" checks exclude scheduled (`cron` / `nightShift`) tasks. Default has no voorman. For "who picks up unowned work here?", use `projectLeadGezelId`, which answers the Meester for Default. Never feed that id to voorman nudges or the voorman tool filter: as an ordinary voorman, the Meester would re-prompt every casual turn and lose its delegation tools. Managing Default's runs goes through the Meester's own `task-oversight` kit instead: `manage_task`, `assign_task` and `write_task_note`.
- **The MCP server runs as a child process** with a fresh Node environment. Env variables we pass are its only connection to the running service — don't rely on anything else being inherited implicitly.
- **The embedded fallback loads from the unpacked service-bundle, not from `app.asar/node_modules/`.** [supervisor/index.ts](packages/app/src/supervisor/index.ts)'s `startEmbeddedRaw` dynamic-imports `app.asar.unpacked/dist/service-bundle/dist/index.js` via a `file://` URL when that file exists (packaged mode), and only falls back to bare-specifier `import('@bendyline/gezel-service')` for dev (workspace symlink). The reason: electron-builder's pnpm dep walker copies `@bendyline/gezel-service` into `app.asar` but doesn't follow its transitive deps — about 100 packages get silently dropped, so any embedded boot from there crashes with `ERR_MODULE_NOT_FOUND` on whichever transitive (zod-to-json-schema, @octokit/endpoint, etc.) is imported first. The service-bundle (built by `pnpm deploy --prod --legacy`) has a complete pnpm tree and is the same source the spawned daemon uses. Net effect: one canonical service tree on disk, consumed by both spawn and embedded paths.

  Practical implication: **don't add `@bendyline/gezel-service` (or its transitive deps) to [packages/app/package.json](packages/app/package.json)**. Doing so would re-introduce a parallel tree in `app.asar` that the embedded path no longer reads from, just bloating the installer.
- **The Windows script container has four non-obvious rules** ([sandbox/windows-mxc.ts](packages/service/src/sandbox/windows-mxc.ts), [ADR 0022](docs/decisions/0022-windows-mxc-sandbox.md)).
  - Keep `ui.disable: false`: with Win32k off, node.exe dies at DLL init (0xC0000142).
  - Never grant a drive or share root, even read-only. It cascades to the whole volume (a read-only `C:\` grant read `~/.gitconfig`), whatever MXC's docs say; `buildMxcRequest` refuses it.
  - Every ancestor of a grant is unreadable inside the container, and `fs.realpathSync.native` is refused, so runs use `--preserve-symlinks(-main)` plus the `MXC_RESOLVE_HOOK` preload, which follows links by hand. Without the hook, pnpm's junction layout loses transitive dependencies (`express()` → "Cannot find module 'body-parser'"). Don't "fix" this by hoisting installs or granting ancestors.
  - The container passes only stdin/stdout/stderr and blocks host loopback, so script RPC rides stdio with a nonce marker (`stdio-rpc.ts`, `packages/sdk/src/rpc.ts`); a script can never call the daemon over HTTP. A Session 0 caller cannot start Node in a container at all; the probe reports it unavailable.

## Where to look when things break

| Symptom | First place to look |
|---|---|
| Chat messages disappear on restart | `Store.writeSession` + `ChatManager.send`'s `store.writeSession` call |
| After an upgrade the app reports an older service version, or `~/.gezel/logs/launchd-stderr.log` keeps growing | An autostart unit outside the handover. `launchctl print gui/$UID/com.bendyline.gezel` (or `systemctl --user cat gezeld-user.service`) shows the tree it runs and its `runs` count. A plist with a bare `KeepAlive` `<true/>` or a `~/.gezel/service` path predates the handover; the next packaged launch rewrites it. `Autostart is standing down` in `launchd-stderr.log` is expected while the app owns the home. The supervisor's own `[supervisor] autostart` lines go to Electron's console only — launch the app from a terminal to see them |
| The window freezes, Windows shows "Not Responding", or switching views pauses | Grep the service log for `[perf]`. `main thread blocked for …` names what was running during a daemon stall, and its `(cpu …, N page faults: …)` says what the thread was doing: `running code` is a real hot path, `paging` means the machine is short of memory (its CPU profile will be nearly empty), `blocked waiting` is synchronous I/O or a lock; `slow request` lines time individual endpoints; `ui:` lines are the renderer's view of each slow navigation (slowest request, with the daemon's own share from `Server-Timing`). With debug mode on or `GEZEL_PERF_PROFILE=1`, every block also saves `logs/perf/stall-*.cpuprofile` — open it in Chrome DevTools or VS Code for the actual culprit. `GET /api/system/perf` returns all of it as JSON. With an in-process embedded service (the packaged fallback, E2E, or `GEZEL_SERVICE_HOST=in-process`) the daemon IS Electron's main thread, so a daemon stall freezes the window; `pnpm app` runs it in a utility process, where a stall only delays requests; a `[power] host resumed after Ns suspended` line while the machine was awake is a stall over 10 s the suspend clock misfiled as sleep |
| Icons show as initial-letter placeholders | `oneShotCompletion` logs for timeouts; check credentials |
| MCP tools don't fire | `[chat] @bendyline/gezel-mcp not found` log; mcp package exports |
| "Unlimited" shown for a user with a real cap | `CopilotProvider.parseUsage` — look at the raw event |
| Provider switch doesn't take effect | `ChatManager.resetClient` gets called on credential change; check `config.ts` reset-fields list |
| E2E fails "waiting for…" | Usually `GEZEL_MOCK_PROVIDER=1` not set, or the Electron window didn't reach `domcontentloaded` in time |
| Spelling/grammar stuck on "Proofing…", or no squiggles at all | Fetch `/harper/harper_wasm_bg.wasm` — it must be `200 application/wasm`, and `harper_wasm_slim_bg.wasm` must sit beside it. Then check `script-src` carries `'wasm-unsafe-eval'`; a CSP violation in the console is the giveaway. A markdown doc must be active with proofing effective — Settings → General → Documents, `squisq-proofing: false` frontmatter, and the View-menu toggle all win over the default (with both Documents checkboxes off the engine is never loaded at all) |
| The model scorecard's dropdowns are missing, or do nothing | The static site is the only surface that has them. Check `assets/scorecard.js` is written and the page carries `<script defer src="…/scorecard.js">` — `pageScripts` links it from the presence of `data-hb-scorecard` in the rendered body, so a macro that stopped emitting the widget silently stops linking the script too. In the app and in agent mode the article is a fixed stack of rounds by design |
| A document isn't findable in search | Is the `shared` project indexing? `GET /api/projects/<sharedId>/index/status`. Check the path isn't filtered as an outside-in twin or sync junk ([fs/sync-junk.ts](packages/service/src/fs/sync-junk.ts)). For a keywordless query, the match may be falling under `VECTOR_ARM_MIN_SIMILARITY` ([index-store.ts](packages/service/src/index-store/index-store.ts)) — that floor is embedder-specific and does not survive a model swap unmeasured |
| Search returns the same documents for every query | The vector arm lost its floor. KNN always returns its k nearest rows, and rank fusion scores a rank-0 vector hit at a flat 1.0, so an unfloored arm outranks genuine keyword matches with the whole corpus |
| A chat turn injected indexed context that has nothing to do with the request | Read the turn's `retrieval.context-injected` history event — it lists every hit with its score and the per-arm timings. Injection is round-robin across corpora ([project-retrieval.ts](packages/service/src/search/project-retrieval.ts)'s `diversify`), so a corpus that returned anything gets a slot; the guards are `clearsInjectionFloor` and, for keyword arms, `isGrounded`. If the hit is keyword-derived, check what the query actually became — `queryTerms` ([query-terms.ts](packages/service/src/index-store/query-terms.ts)) applies the one stopword list, `QUERY_STOP_WORDS` ([query-stopwords.ts](packages/gezk/src/query-stopwords.ts), shared with the knowledge-catalog reader and the phone's memory recall), and FTS5 sees an OR of prefix terms, not the sentence. For a knowledge hit, the trace's `similarity` against its catalog's floor in [knowledge/vector-floors.ts](packages/inference/src/knowledge/vector-floors.ts) says whether the floor or the relevance model let it through |
| The relevance check is on but changes nothing | The service log's `[relevance] resolved enabled= model= source= surfaces= installed=` line, then the event's `relevanceModel.status`: `cold` means the model was still loading (it never holds a turn — the next one gets scores), `unavailable` means it failed its load-time self-check or its graph pin. An uncalibrated model (registry `thresholds: null`) only reorders; nothing is dropped until the bench has calibrated it |
| A `.gezel/` dir, `*.db`, or any new file appeared in a folder the person added | Something wrote into a read-only workspace. The index belongs home-side (`projectContentIndexDbFile`); a stale `.gezel/index/` that survives a boot is one the migration could not take sole ownership of (another process held it — look for `[index] <id>: workspace index copied`/`left-in-place`). Anything else is a new write path: `index-store/read-only-promise.test.ts` is where to reproduce it (ADR 0021) |
| A spreadsheet or big CSV never became a table | Check `tabular_state` in the project index: `blocked` is terminal for that content hash (empty file, unreadable, unsafe path), `deferred` means it was too large for the interactive pass and the night shift has it. A CSV under `MAX_INDEXABLE_BYTES` is deliberately left alone — it is already chunked and readable |
| A spreadsheet's numbers are wrong by 100x, or dates are text | Something read the markdown shadow instead of the typed path. `formattedNumberText` renders `0.15` as `"15.0%"`; the data path is squisq's `xlsxToTables` via `convertInSandbox(path, 'xlsx', 'tables')` |
| A gezel says a data table is empty, or `query_table` errors | Is there a corpus? `GET /api/projects/<id>/connectors` shows `tables[]` per binding. The tools are registered only when `GEZEL_TABLES_ENABLED` is set, which the chat manager does after probing for `artifacts/data/*/tables/` — a project with no tabular corpus has no query tools at all, by design |
| `query_table` refuses a query that looks read-only | The guard is DuckDB's own parser, not a keyword list, and it accepts only a single SELECT. `WITH … INSERT` and every `EXPLAIN` form are rejected on purpose — see [statement-guard.ts](packages/service/src/observations/statement-guard.ts) |
| Rows synced but a query returns none | Compaction has not run and the view lost its NDJSON arm, or the partition filter is wrong. Views union Parquet *and* `sealed-*`/`open-*.ndjson`, so fresh rows should be visible immediately; check `tables/<t>/state.json` for `lastError` from a refused compaction |
| A gezel's edits vanished — the file is unchanged | It was drafting a change proposal, not editing. Check `task.diffpackId`; the edits are in `artifacts/diffpacks/<packId>/after/` and land in the workspace only when the user applies from the project's Proposals tab |
| A drafting shard wrote into the wrong pack folder | Its step used `{{task.num}}`, which `TaskManager.create` froze to the HOST's number when it snapshotted the spawn template. Spawn steps address their own pack with `{{diffpack.dir}}` |
| Applying a proposal 409s with `drifted` | The target file changed since the proposal was sealed (`baseHash` mismatch). The UI names the files and offers to apply anyway; a hunk that genuinely no longer fits is still refused by the patcher |
| A timeout reports far less elapsed than the log shows | The host slept through it. Look for a silent gap in the service log followed by several unrelated timers firing within milliseconds of each other, then confirm with `pmset -g log \| grep -E "Entering Sleep state\|DarkWake"`. The budget should have been an `AwakeBudget` — see the awake-time convention above |
| An MLX chat says "Waiting for another chat to finish", or a task turn stalls while you chat | The sidecar runs requests in waves (see `docs/kv-prompt-caching-strategy.md` §5.2). Grep the MLX log for `[batch] queued`/`waiting`/`preempt`/`resume`/`admitted`: a background wave parks for an interactive request between steps, unless a `preempt held` line says memory was at the admission threshold or the running wave already serves a person. A request's priority comes from `engineTurnPriority` in chat/manager.ts — task steps and resumes are background |
| A chat says "Waiting for *name* to finish before switching models", or still fails with "did not drain within 30s" | Its model needs the memory of a model whose turn is still running, and the swap happens when that whole tool-loop turn ends. Grep the service log for `engine busy — draining (until idle)` (a turn waiting) and `waits, then rebinds` (a turn that stepped aside for it). Only a consultation the asker is blocked on and ambient chores keep the 30 s bound and can still fail — by design, see [chat/engine-swap-wait.ts](packages/service/src/chat/engine-swap-wait.ts) |
| A resident model unloads for no reason, and the next turn cold-loads | Idle eviction charged host sleep as idle time. `NativeEngineSupervisor` keeps `lastUsedAwakeAt` for the decision and `lastUsedAt` only for display; a re-arm (not an early return) is what keeps the eviction from leaking |
| A chat turn died at shutdown and never came back | Was it task-scoped? Those rehydrate through `TaskRunner.rehydrateFromStore`; plain sessions go through `ChatManager.resumeInterruptedTurns`, which only re-drives a turn whose `turnStartedAt` stamp survived — cleared for a user stop, an interrupt, an emergency stop, and any ordinary failure (that one keeps `lastTurnError` + Retry). It is also held whole while engagement is `off`/`reactive`, and capped per boot |
| A gezel on a paired server's model answered with this computer's model, or says the server "isn't reachable" | The server was judged unreachable by [remotes/reachability.ts](packages/service/src/remotes/reachability.ts): grep the service log for `[remote-reachability]` (`is not reachable` / `reachable again` / `moved from … to …`). Only a failure to *connect* counts — a server that answers with an error stays `online`. A session moves to the fallback (`resolveProviderRoute` in chat/manager.ts: the install's own provider, else this platform's engine, and only if it has a model) and back when the server returns, with a note on the reply. No fallback means the turn fails with the plain message instead. A server that moved to a new IP is followed only after it proves its pinned identity there |
| A JSON file is a building, or a config file is a campus of little houses | File use is path policy in [core/filemap/file-use.ts](packages/core/src/filemap/file-use.ts): data → field, config → signal tower, style → park, everything else code. The renderer resolves it in `townStyleForBlock` and every campus consumer reads `hasSymbolCampus`. Adding a config basename or pattern goes there, once, for both renderers and the service's weight cap |
| Every street in the Village is a dirt track, or a lane has a trolley on it | Road grades are server policy in [filemap/traffic.ts](packages/service/src/filemap/traffic.ts) (frontage + corridor + egress, capped by settlement); the renderer only maps `MapStreet.grade` → geometry in [FileMap/traffic.ts](packages/ui/src/components/FileMap/traffic.ts). No `grade` on the wire means a pre-traffic payload — the client falls back by tier. A village founded before the resolved graph is on edge policy 1 (relative imports only), where bare workspace imports (`@scope/pkg`) are not roads and inter-package boulevards carry only frontage; its "Update the village" key moves it to policy 2 (`VillageDomainState.edgePolicy`) |
| A project view or file pane shows no dependencies for a language, or a Village grew roads after an upgrade | The resolved graph is the `file_edges` table, rebuilt at the end of each static pass when the file set, an import row or `EDGE_RESOLVER_VERSION` changes ([index-store/edges/](packages/service/src/index-store/edges/)). `GET /api/projects/:id/index/graph` reports per-language `coverage` and `resolved: false` before the first resolution. Each edge records its `resolver`, so a bad heuristic can be found and switched off alone. An older JavaScript codebase whose bare `require("utils/x")` ids resolve to nothing needs a page that loads RequireJS (`data-main`, `require.config` `baseUrl`/`paths`): the `requirejs` resolver ([edges/requirejs.ts](packages/service/src/index-store/edges/requirejs.ts)) reads its setup from there, never guesses one. Villages read it only on edge policy 2 ([ADR 0024](docs/decisions/0024-resolved-file-edges.md)) |
| The Diagram shows a folder as one box where you expected its files, or a line you expected is missing | Folders open by default level by level while the drawing stays near 40 boxes (`defaultDiagramExpansion`), and the person's choice is remembered per project in localStorage (`gezel.diagram.open.*`; Reset forgets it). Lines are dropped on purpose by `shapeDiagram` ([core filegraph/shape.ts](packages/core/src/filegraph/shape.ts)): a shortcut a longer path implies, and every line into a hub nearly everything uses — the status line names both. Type-only imports are dashed, not dropped. A line between two files in one closed folder is internal and never drawn |
| A git repository's Timeline shows file dates instead of commits, or a file is missing from the Gallery | The Timeline reads `git_commits` / `git_commit_files` (index schema v16), written only by the git-stats ingest on an indexer tick ([git-stats.ts](packages/service/src/index-store/git-stats.ts)); until it runs, or when git is unavailable (`git_stats:state`), the view falls back to file dates, and an index from before the tables re-ingests once `git_stats:history` is missing. Both views show only what the Gallery shows ([gallery.ts](packages/service/src/index-store/gallery.ts) `hiddenFromGallery`): lockfiles, binaries, minified bundles and Git-ignored paths are left out on purpose |
| A task was created but nobody started it ("active", no chat) | Nothing resolved for the entry step, so `dispatchTaskEntry` returned `no-entry-gezel` — check the step's `suggestedRole`/`assignee`. A workspace SKILL.md names no role at all, which is why invocation goes through the voorman-triage scaffold in [skill-invocation.ts](packages/service/src/workspace/skill-invocation.ts) |
| A task recruited specialists although generalist mode is on, or ran stepwise on a frontier provider | `task.executionMode` is stamped once at create (or draft activation) and never re-evaluated — find the `generalist-mode resolved=` line in the service log for the setting, provider and tier it saw. An explicit assignee stays the owner (that is by design), and a Generalist pinned to a local model resolves stepwise under `auto` |
| An image or video model is missing from the download page, or its download answers "too large for this machine" | The daemon priced it with `wont-run`: read `GET /api/{image,video}-gen/models/fit` for its `bytes`, `gpuBytes`, `pool` and `reason`. Hidden means the launch path would refuse it too ([docs/media-model-memory.md](docs/media-model-memory.md)). `exact: false` means the gilde entry lacks its files' `tensors` facts (run gilde's `pin-weight-tensors`); otherwise a wrong verdict is a wrong constant in [media-memory.ts](packages/core/src/media-memory.ts) or a wrong pool |
| A local image model renders repeated fragments, burned color, mush or misspelled text | Size and guidance before the engine. A 1024px-trained model (SDXL, Flux, Krea, Animagine) asked for 512 tiles and repeats; a CFG above its card's burns; steps far below its recommendation blur. Check the `[sd-cpp] generate model= steps= size=` log line, the defaults in [sd-cpp.ts](packages/service/src/providers/image/sd-cpp.ts), then render the suite with `pnpm --filter @bendyline/gezel-evals run image-bench -- --models <id>` and read its HTML grid ([IMAGE-BENCH.md](evals/src/image-bench/IMAGE-BENCH.md)). Review grids as JPEG: a large PNG sheet can be palette-reduced on the way to your eyes and look posterized |
| Local models are slow and the rail says "Running on CPU", or a GPU llama build never starts | The llama-server quarantine: `~/.gezel/engines/llama-cpp/unusable.json` (`entries` are switched off, `strikes` count toward it). Only a crash before readiness that printed no classified fault counts ([unrunnable-build.ts](packages/core/src/native/unrunnable-build.ts)); three in a row of the same binary switch it off, and any start that reaches readiness clears the count ([llama-quarantine.ts](packages/core/src/native/llama-quarantine.ts)). Grep the service log for `build crashed before it was ready` / `quarantined the`. Settings → This PC (llama) shows it and turns it back on (`DELETE /api/engines/llama-cpp/quarantine/:backend`); a pinned backend ignores it |
| Local models are slow on a GPU machine, the rail says "Not using your GPU" / "Restart to use your GPU" / "Update your NVIDIA driver", or a CUDA machine runs the Vulkan build | `GET /api/engines/llama-cpp/backend-health` (engine-owner state, proxied to the machine engine). `cudaBlocker`: Linux discovery passed over the CUDA build because the NVIDIA kernel module is not loaded, does not match the installed library (restart pending), or predates the build's CUDA runtime ([nvidia-driver.ts](packages/core/src/native/nvidia-driver.ts)); re-checked every launch, nothing persisted. `gpuUnused`: a GPU build reached ready without a `using device` line — the Linux builds `dlopen` their GPU backend and ggml skips one that fails without a word ([gpu-startup-watch.ts](packages/inference/src/providers/llama-cpp/gpu-startup-watch.ts)). Grep the service log for `cuda build passed over` / `started without its GPU` |
| A Linux engine dies with SIGKILL, or a chat says the computer ran out of memory | Linux's out-of-memory killer: the supervisor compares `oom_kill` in `/proc/vmstat` across the child's life and labels the exit `host-out-of-memory` (never a quarantine strike, never the GPU→RAM ladder). `dmesg` names the victim when readable. On a GB10 or an AMD APU the GPU allocates from the same RAM, so another process holding memory is the usual cause; `backend-health`'s `outOfMemory` counts them since the engine owner started. An APU's fast pool is also capped at carve-out + GTT (`mem_info_gtt_total`, [gpu-carve-out.ts](packages/inference/src/system/gpu-carve-out.ts)) |
| On Windows, scripts exit 126 or `run_nodejs_script` is missing | The MXC container is off or unavailable. Grep the service log for `[sandbox] windows-mxc available` / `unavailable (…): <reason>`, or read `scriptSandbox` on `/api/health`. No launcher means the supervisor or `resolveVendoredMxc` did not install one; 0xC0000142 means a Session 0 caller (service, SSH logon); an older Windows build fails the probe. A run that dies with `[sandbox error] the Windows sandbox …` is a launcher failure, and the next run probes again |

# Gezel

Gezel is a local-first desktop app for assembling a **team of AI agents** — gezels — and putting them to work. The name is Dutch for "companion" or "journeyman." Everything the user creates lives on their disk, talks to whichever LLM provider they point it at, and is inspectable as plain files. No cloud service of our own stands between them and the model.

One of the other main value propositions of gezel is to simplify AI and make it accessible to all people, not just technical people. The name "gezel" is an example of this in itself: users work with gezels (craftsmen) rather than the cold and technical "agents". This project is a relentless pursuit to simplify AI and make "the good parts" accessible to all.

This document is for anyone (human or AI) extending gezel. It captures the mental model, the layering, and the conventions that aren't obvious from the directory structure alone.

For UX philosophy and the visual direction the app is heading — read [docs/ux.md](docs/ux.md) before touching UI.

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

4. **Local spawn (packaged)** — the supported per-user path and production fallback when the machine service is unavailable. Extract `app.asar.unpacked/dist/service-bundle/` to `~/.gezel/service/` and spawn it under the logged-in user. The Copilot login flow runs inside the app via `POST /api/system/copilot-login` under the bundled pnpm + Node — and presupposes that the user has already installed the Copilot SDK from Settings → GitHub Copilot, since it is an on-demand toolset (see **Provider** below).

5. **Local spawn (dev)** — `GEZEL_SPAWN=1` is set in dev mode. Spawn from `packages/service/dist/bin/gezeld.js` via `require.resolve`. No extraction. Watch-mode rebuilds of the service package aren't picked up until the child is restarted — if you're iterating on service code, set `GEZEL_EMBEDDED=1` instead.

6. **Embedded** (fallback or forced) — `GEZEL_EMBEDDED=1` env var is set, OR we're in dev mode and `GEZEL_SPAWN=1` is *not* set, OR any of the spawn branches above fail inside the health-wait budget. Boot the service in-process via `@bendyline/gezel-service`'s `startService()`. Fast iteration, no child process. When this branch is reached because of a spawn failure (not by force), the UI reports it as an **install-health notice** ([packages/ui/src/system-notices.ts](packages/ui/src/system-notices.ts)): one muted line in the navigation rail under Settings, with the full explanation in Settings → About. It is deliberately not a banner on Home — the state is neither urgent nor fixable without the installer — and the copy must never imply background work resumes on its own, because in this branch it does not.

The supervisor also runs a health-watch on spawned children (15s interval, 3 consecutive failures trigger a restart). Restart budget: 3 attempts in 60s, then fall back to embedded. On each restart, the BrowserWindow reloads so the UI picks up the rotated auth token via the preload's synchronous `ipcMain.on('gezel:current-connection')` bridge.

**Autostart** ([packages/app/src/autostart/](packages/app/src/autostart/)) is an opt-in toggle in Settings → Daemon. Writes a user-level LaunchAgent / systemd `--user` unit / Task Scheduler on-logon task — no admin required. Enabling it makes gezeld run independently of Electron, unlocking scheduled jobs and other "always on" features. Disabling uninstalls the unit. This is the "mode 2" of the original intent — packaged spawn (branch 4) is the foundation; autostart is the operational flip that keeps gezeld running when the app is closed.

**Remote mode (branch 1)** is wire-complete — the supervisor probes and connects — but the UI for configuring a remote URL is not yet built. The service-side work (TLS, non-loopback binding, stronger auth than a per-launch bearer token) is deliberately deferred.

Do not bake "the service is in-process" assumptions into new code — go through the HTTP API (via `@bendyline/gezel-client`) and you'll be fine across every branch.

## Directory layout on disk

```
~/.gezel/
├── config.json              provider creds, default meester, default model
├── runtime/                 pid, port, auth-token (cleared on restart)
├── .transactions/           private durable journals for crash-safe multi-file operations
├── service/                 extracted gezel-service bundle (packaged mode)
├── logs/                    service-YYYY-MM-DD.log — 7-day rolling, 10 MB cap
├── gezels/
│   └── {id}/
│       ├── gezel.md         frontmatter: name, role, provider?, model?
│       ├── about.md         system prompt prose
│       ├── icon.svg         current icon
│       ├── icons/           last 5 variants, archived by timestamp
│       ├── sessions/        {sessionId}.json — one per chat thread
│       ├── memories/        daily/YYYY-MM-DD.md + lessons.md + index/mem.db
│       └── resources/
├── projects/
│   └── {id}/
│       ├── project.json     name, description, workingDir?, packages
│       ├── finding-lifecycle.json  durable open/in-progress/resolved scanner findings
│       ├── report-actions.json  fired/dismissed lifecycle of report-embedded action requests
│       ├── artifacts/       read-write user/agent outputs
│       ├── workspace/       internal fallback when no external dir
│       └── memories/        same structure as gezel memories
├── documents/               cross-project shared library (mission, guidelines)
├── index/                   global.db — sqlite FTS cache over sessions, history, documents
└── tasks/history/           completed task records
```

Persisted user state uses **gezels/**, never **agents/**. Repository-only metadata such as `.agents/` and `.github/agents/` is not part of the on-disk product schema. `Store.ensureLayout` retains a one-shot migration for older installs that used an `agents/` state directory.

## Packages

| Package | Purpose |
|---|---|
| `packages/core` | Shared Zod schemas, path helpers, gezel-markdown parser. No runtime deps on node beyond built-ins; safe for UI + service to both import. |
| `packages/service` | The daemon: HTTP API, `Store`, `ChatManager`, providers, memory, chat events. |
| `packages/mcp` | The stdio MCP server. Gezels get this as their "hands" — list/read/write workspace, artifacts, documents, memories, and the **team tools** (`list_gezels`, `create_gezel`, `update_gezel`, `list_projects`, `create_project`, `update_project`) used by the Meester. |
| `packages/client` | Typed HTTP client wrapping every service endpoint. Also used internally by the MCP server to call back into the running service. |
| `packages/ui` | React/Vite web app. Served by the service at `/`. |
| `packages/app` | Electron shell. Holds the supervisor (machine-service adoption on every packaged platform, per-user spawn, and embedded fallback), loads the UI, and ships platform installer/autostart scaffolding. |
| `packages/cli` | `gezel` command-line for headless scenarios. |
| `packages/catalog` | Catalog *loader* (sources, install pipeline, authoring/generation scripts). The content itself — gilde templates, toolsets, craftbooks, chat-/image-/video-model catalogs — lives in the external [`bendyline/gilde`](https://github.com/bendyline/gilde) repo, consumed as the exact-pinned `@bendyline/gilde` npm package. Local content dev via `pnpm link:gilde`. See "The three-repo catalog architecture" below. |
| `packages/plugin-sdk` | Helpers for writing gezel plugins (legacy surface, kept for compatibility). |
| `packages/sdk` | Newer extension surface — typed entry points for external integrations and embedders. The plugin-sdk is the historical equivalent; treat `sdk` as the preferred surface for new work. |
| `packages/vscode` | VSCode extension that surfaces gezel features inside the editor. |
| `evals` (top-level, **not** under `packages/`) | End-to-end evaluation harness. Drives `gezeld` via `GezelClient` against scripted scenarios and reports success rates. Registered in `pnpm-workspace.yaml`; invoked via root `pnpm eval:run` / `pnpm eval:batch`. |

**Eleven of these are published to npm** as public API under semver: `core`, `client`, `sdk`, `app-sdk`, `plugin-sdk`, `catalog`, `connectors-spectral`, `script-stdlib`, `mcp`, `service`, `cli`. `app` and `vscode` are versioned and tagged by the release tooling but stay `private: true` — that flag is the only thing keeping them off npm. `ui`, `eval-viewer` and `evals` are excluded entirely; the UI ships *inside* the service tarball (`packages/service/tsup.config.ts` stages `packages/ui/dist` into `dist/ui/`). See [docs/npm-release.md](docs/npm-release.md).

Build order (enforced in root `package.json` script): `core` → `client` / `plugin-sdk` / `sdk` / `catalog` (parallel) → `mcp` → `service` → `ui` → `cli` / `app` / `vscode` (parallel). The MCP depends on `client`; the service depends on all of them and resolves `@bendyline/gezel-mcp/dist/server.js` at runtime — this subpath is **explicitly exported** from the mcp package's `package.json` for a reason (see "Gotchas" below).

## The three-repo catalog architecture

Catalog **content** is not in this repo. It lives across three repos:

- **gezel** (this repo) — the app plus the catalog *loader*
  (`packages/catalog`: `CatalogService`, sources, npm-toolset install
  pipeline) and the content *authoring* scripts
  (`packages/catalog/scripts/`: `build-manifest`, `generate-craftbooks`,
  `pin-revisions`, `import-mcp-registry`), which stay here because they
  import unpublished core Zod schemas.
- **[`bendyline/gilde`](https://github.com/bendyline/gilde)** — the
  content: `data/` (chat/image/video models, toolsets, connector types,
  project types, gezel role templates, craftbooks + `test.json` eval
  sidecars, and the bot-managed `data/community/` MCP-registry tier).
  Repo root **is** the npm package root of `@bendyline/gilde`, so the
  published package and the checkout are interchangeable. Gilde owns the
  canonical `tools/build-index.mjs` plus dependency-light PR validation
  (ajv against `schemas/*.schema.json`, which are **generated from
  core's Zod schemas** — see Gotchas). It takes open-source PRs.
- **[`bendyline/gilde-pipeline`](https://github.com/bendyline/gilde-pipeline)**
  — verifies gilde, publishes `@bendyline/gilde` to npm (patch version
  injected at publish; the committed gilde version is the minor line),
  and deploys the gezelgilde.com Pages site plus the versioned
  `catalog/v1/latest.json` update manifest (the contract the stubbed
  `RemoteSource` will eventually poll).

Gezel consumes the content as an **exact-pinned registry dep** of
`packages/catalog` (`"@bendyline/gilde": "x.y.z"`, squisq-style), resolved
at runtime through `gildeDataDir()` in
[packages/catalog/src/gilde-data.ts](packages/catalog/src/gilde-data.ts).
`GEZEL_GILDE_DATA_DIR` overrides resolution for tests/evals/operators;
authoring scripts locate the sibling checkout via `GILDE_DIR` (default
`../gilde`).

The content-change dance: edit or generate into the sibling `../gilde`
checkout (run `pnpm link:gilde` so the daemon/tests/evals see it) →
`pnpm --filter @bendyline/gezel-catalog build-index` → gilde PR → CI
validates → merge → the pipeline publishes → bump the pin in
`packages/catalog/package.json` **and** the `minimumReleaseAgeExclude`
entry in `pnpm-workspace.yaml` → `pnpm unlink:gilde`. Content regressions
gate in gezel CI against the *pinned* version via the catalog package's
data-contract tests.

**If your content edit uses a value newly added to a core Zod schema**
(a fresh `style.family`, behavior id, tool-grammar format, engine enum,
etc.), run `pnpm gilde:export-schemas` **before** `build-index` — else the
manifest fails gilde's generated `schemas/*.schema.json` ajv identity
check and `build-index` **silently drops the item from the index** (no
error; surfaced only by `node ../gilde/tools/build-index.mjs --verbose` as
`skip … invalid-identity`). The daemon then falls back to defaults as if
your edit never happened. See the `gilde:export-schemas` gotcha below.

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
build doesn't know — live updates deliver value changes and new items, not
new schema surface.

## Core concepts

### Gezel

A named AI agent. Fields worth knowing:

- **Frontmatter** (in `gezel.md`): `id, name, description?, role?, model?, provider?, reasoningEffort?, iconOverride?`
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

### Project

A scoped workspace. Always present: a `default` project that fills in when the user hasn't chosen one. A project can optionally point at an external `workingDir` — otherwise an internal fallback directory is used. Artifacts (reports, scripts, outputs the agent produces) live under the project and are separate from the codebase.

**Every session belongs to a (gezel, project) pair.** There is no "gezel-only" session — the `default` project is the implicit bucket.

Each project also carries:

- **`about`** — `documents/about.md` inside the project. Free-form prose describing what the project is, who it's for, what's in scope. Read lazily by `Store.getProject` and **injected into the system prompt** for any chat session scoped here, under the heading `### About this project`.
- **`missionObjectives`** — `documents/missionObjectives.md`. Concrete success criteria. Same lifecycle as `about` and same prompt injection (under `### Mission objectives`). Use this for the kind of bullet list you'd put in a team brief.
- **`voormanGezelId`** — optional pointer to the gezel who acts as the project's voorman (Dutch for foreman / crew lead). Stored in `project.json`. When set, the system prompt for any session here notes "The voorman of this project is **{Name}**." This is informational only — it doesn't change any access or routing — but the model knows whom to defer to.

The per-project `documents/` folder is **distinct from the global `~/.gezel/documents/` library**. Project docs are only injected into chats scoped to that project; the global library is referenced through MCP tools and the shared header listing.

All three fields are settable via the unified `PUT /api/projects/:id` endpoint and the MCP `update_project` tool, so the Meester (and any project voorman gezel) can adjust them in conversation.

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

`LLMProvider` / `LLMSession` is the abstraction in `packages/service/src/providers/types.ts`. Three implementations:

- **CopilotProvider** — wraps `@github/copilot-sdk`. Supports `resumeSession`. Compaction is SDK-internal. Expensive first-call latency (~30–90s on cold start); our timeouts are 120s. **The SDK is an on-demand system toolset — it is not installed at boot.** The user installs it from Settings → GitHub Copilot, or already has a Copilot CLI of their own (`COPILOT_CLI_PATH`, or one on PATH); [copilot-availability.ts](packages/service/src/providers/copilot-availability.ts) resolves that ladder and is what every UI gate reads. `loadSdk()` dynamic-imports from `~/.gezel/system-toolsets/` in packaged builds and falls back to the workspace devDependency in dev; when neither exists, `initialize()` raises an actionable "install it in Settings" error rather than an `ERR_MODULE_NOT_FOUND`.
- **OpenAIProvider** — wraps `openai` package's Responses API with `store: true` + `previous_response_id` for server-side state. **Owns an MCP bridge per session** because OpenAI's hosted MCP is HTTP-only; we run stdio ourselves.
- **MockProvider** — deterministic, scriptable, no external deps. Used by tests and by the `GEZEL_MOCK_PROVIDER=1` env flag so Electron E2E and CI work without real credentials.

Per-install default via `config.provider`. Per-gezel override via frontmatter. `ChatManager.providerFor(gezelId)` resolves the precedence.

When `config.provider` is unset, [default-provider.ts](packages/service/src/providers/default-provider.ts) resolves it — **to the on-device engine wherever we bundle one** (`mlx` on Apple Silicon, `llama-cpp` on the other platforms in the native build matrix), falling back to `copilot` only where no engine ships (notably Intel Mac). It reuses `isSupportedOnDevicePlatform` / `resolveFirstRunTarget` from the first-run bootstrap so the default and the first-run model pin can't disagree. Use it instead of writing `config.provider ?? 'copilot'`: that literal predates Copilot becoming an opt-in download and now points at something a fresh install has no way to run.

### OpenAI-compatible endpoints (Connected Apps)

Gezel serves third-party local apps through a public inference facade, controlled from Settings → Connected Apps and stored under `config.openaiEndpoints`:

- **`/v1/*`** on the main daemon port (canonical 6228) — OpenAI-shaped chat/models/embeddings, gated by bearer auth + the per-app consent flow (`/v1/apps/register`). Stateless: one fresh provider session per request; callers replay their own history. Requests resolve `<provider>:<model>` or `gezel:<ref>` targets; unknown model strings fall back to the configured **serving gezel** (persona + frontmatter tuning apply). Per-model resolved tuning always applies, with the caller's per-request sampling/`response_format`/`tool_choice` overlaid on top ([request-tuning.ts](packages/service/src/http/openai-compat/request-tuning.ts)); the behavior **profile** (ramble detection, transcript shaping) is gated by the `supportingBehaviors` switch. Tools are caller-executed (advertise-and-halt via `SessionOpts.externalTools`); providers that run their own tool loop (Copilot, CLI providers) reject tools loudly and get history flattened into the prompt (they ignore `priorMessages`).
- **`/ollama/v1/*`** — the same engine speaking Ollama's dialect (tags/chat/generate/show/embed/ps, object-form tool arguments, bare-base64 images).
- **Ollama emulation** ([ollama-emulation.ts](packages/service/src/http/ollama-emulation.ts)) — an opt-in (`emulateOllama`, default OFF), **unauthenticated** plain-HTTP loopback listener on port 11434 so apps that auto-discover Ollama find gezel. Inference surfaces only; refuses to bind when real Ollama owns the port. Never mount product `/api/*` routes there.

Completed app turns land in history as `v1.chat.completion` and feed the UsageTracker via `ChatManager.recordExternalUsage`. A master `enabled: false` gates every surface plus new app registrations ([openai-endpoints-gate.ts](packages/service/src/http/openai-endpoints-gate.ts)).

### MCP Bridge

Each OpenAI or Mock session that has `mcpServer` set spawns the `@bendyline/gezel-mcp` subprocess via stdio, lists its tools, and translates them into OpenAI function-tool shape. When the model emits a `function_call`, the bridge invokes it and feeds the string result back as a `function_call_output`. The gezel-mcp server itself talks back to the running service over HTTP via the env vars it's given (`GEZEL_BASE_URL`, `GEZEL_TOKEN`, `GEZEL_AGENT_ID`, `GEZEL_PROJECT_ID`, `GEZEL_HOME`).

Tool categories (`packages/mcp/src/server.ts`):

- **Memory**: `search_memory`, `save_memory`, `list_memories`
- **Workspace** (read-write workspace files): `list_dir`, `read_file`, `stat`, `write_file`, `delete_path`, `make_dir`, `rename`
- **Artifacts** (read-write, project-scoped): `list_artifacts`, `read_artifact`, `write_artifact`
- **Documents** (shared library): `list_documents`, `read_document`, `write_document`, `delete_document`
- **Execution**: `run_nodejs_script`, `run_playwright_script`, `npm_install`, `list_packages`
- **Team / projects** (Meester surface): `list_gezels`, `create_gezel`, `update_gezel`, `list_gilde`, `create_gezel_from_gilde`, `ensure_gezel`, `message_gezel`, `list_projects`, `create_project`, `update_project`, plus the suggested-work toggles (`list_suggested_work`, `enable_suggested_work`, `disable_suggested_work`) that surface role- and project-type-recommended recurring craftbooks ([suggested-work/](packages/service/src/suggested-work/))
- **Tasks**: `list_tasks`, `get_task`, `create_task`, `update_task`, `set_task_status`, `assign_task`, `add_task_step`, `advance_task_step`, `read_task_notes`, `write_task_note`
- **Other**: `ask_user_question`, `search_history`, `render_image`

Eligible MCP calls are auto-approved only after the role/security surface and
call-time guards admit them; mutation sinks still enforce project consent and
the resolved security policy. Copilot's SDK-native built-ins (`bash`,
`web_fetch`, file operations, and `grep`) are denied by default so they cannot
bypass those layers. An explicit install-level or per-gezel
`sandboxCopilot: false` is the deliberate compatibility escape hatch.

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
- [`packages/service/src/meester/prompt.ts`](packages/service/src/meester/prompt.ts) — the curated Meester about.md and name list.
- [`packages/mcp/src/server.ts`](packages/mcp/src/server.ts) — every MCP tool. Add new capabilities here.
- [`packages/ui/src/views/`](packages/ui/src/views/) — one file per top-level tab; the entire user-facing surface.

## Conventions

- **The user owns all git management — agents must not touch it.** Do not create branches, do not create worktrees, and do not open pull requests. Work on the user's current branch in the main checkout. Commit or push only when explicitly asked. Branching, PRs, and worktree setup are the user's responsibility, not yours.
- **Git vs GitHub naming.** Anything mechanically `git` (status, changes, diffs, commits, branches, sync, merge, code reviews) is named host-agnostically — `Git*` types, `GitManager`, [packages/service/src/git/](packages/service/src/git/), routes under `/api/projects/:id/git/*`. Anything that talks to the GitHub web service (PRs, checks, OAuth/identity, repo browse) is named `GitHub*` with a **capitalized H** — `GitHubPrs`, [packages/service/src/github/](packages/service/src/github/), routes under `/:id/github/*`. Wire/JSON keys (`project.github`, `githubToken`) and the gilde requirement value `'github'` are frozen — never rename serialized names. The old `Github*` (lowercase h) exports live on as deprecated aliases in core/client until a deliberate breaking release; the legacy `/:id/github/<git-op>` route mounts exist for older HTTP clients and follow the same rule.
- **Any UI work goes through [docs/ux.md](docs/ux.md) first.** This applies to every agent and human touching `packages/ui` or any other user-visible surface: read the guidelines before styling anything and follow them — the typography scale, the radius tokens, and the "keys in trays" standard for choice controls (mostly-square, small radii; no pill buttons; fully-rounded is reserved for true circles). If you introduce a new control shape or visual pattern, extend docs/ux.md in the same change so the guidelines never lag the code.
- **Schemas live in `packages/core/src/schemas/`.** If you need a new wire shape, add the Zod schema there, export the inferred type, and re-export from `schemas/index.ts`. Both UI and service import from `@bendyline/gezel`.
- **Anything a published package ships must survive `npm pack`.** Cross-package deps stay on `workspace:*` — `pnpm publish` rewrites them at pack time, which is why [scripts/publish-package.mjs](scripts/publish-package.mjs) shells out to pnpm instead of letting `@semantic-release/npm` run `npm publish`. Three habits follow: (1) if you resolve a sibling *by string* (`require.resolve`, `import.meta.resolve`), the subpath must be in that package's `exports` map **and** listed in [tests/published/criticalSubpaths.test.ts](tests/published/criticalSubpaths.test.ts) with the right `mode` — `require.resolve` matches the `require` condition, `import.meta.resolve` matches `import`, and a package exporting only `import` is unreachable from CJS; (2) if you stage files into `dist/` from a build hook, add them to [tests/published/bundledAssets.test.ts](tests/published/bundledAssets.test.ts) — a hook that stops running fails silently and only breaks for people who installed from npm (this is exactly how the handboek content lookup broke: `dist/bin/gezeld.js` probed the wrong relative directory, and the repo's `docs/handboek` fallback masked it); (3) run `pnpm check:packages`, which installs the real tarballs into a non-pnpm, non-workspace project — the only place a hoisted-dependency or native-prebuild failure is visible. Full contract in [docs/npm-release.md](docs/npm-release.md).
- **Commit messages are Conventional Commits, enforced in CI.** `multi-semantic-release` derives every published npm version bump from them, so a malformed subject on `main` silently changes what the next release publishes. There is no local git hook, deliberately — the `commitlint` job in [quality.yml](.github/workflows/quality.yml) checks pull requests and pushes to `main`.
- **Don't bypass the Store for gezel/project/session/memory state.** Anything that represents user-facing state under `~/.gezel/gezels/`, `~/.gezel/projects/`, `~/.gezel/documents/`, or `~/.gezel/config.json` is read/written through `Store`. This gives us one atomic-write pattern and one migration point. The following subtrees are **deliberate carve-outs** owned by the feature module that creates them — they don't share Store's atomic-write contract because they're either binary blobs, append-only logs, or external working copies:
  - `~/.gezel/bin/`, `~/.gezel/service/`, `~/.gezel/runtime/` — supervisor-owned (extracted runtimes, bundle, daemon handshake state)
  - `~/.gezel/.transactions/` — private durable operation journals and isolated staging state, owned by the transaction coordinator that creates each subtree; never expose this through `runtime/`
  - `~/.gezel/logs/` — owned by the logger / log-rotator
  - `~/.gezel/history.jsonl` and `~/.gezel/projects/{id}/history.jsonl` — append-only, owned by [HistoryManager](packages/service/src/history/manager.ts)
  - `~/.gezel/keurmeester/` — append-only JSONL intervention case records plus generated digest reports, owned by [KeurmeesterManager](packages/service/src/keurmeester/manager.ts)
  - `~/.gezel/gilde/` — opt-in live catalog content cache (`versions/<v>/` holding extracted `@bendyline/gilde` releases + `state.json`), owned by [GildeUpdateManager](packages/service/src/gilde-updates/manager.ts); rebuildable, safe to delete — the bundled pin is the permanent fallback
  - `~/.gezel/gezels/{id}/memories/index/` — sqlite-vec index (`mem.db`), owned by [MemoryManager](packages/service/src/memory/manager.ts)
  - `~/.gezel/index/global.db` — home-scoped FTS mirror of session transcripts, the history log, and the documents library, owned by [GlobalIndexManager](packages/service/src/index-store/global-index-manager.ts); rebuildable cache, safe to delete
  - `~/.gezel/projects/{id}/digest-state.json` — weekly-digest idempotency state, owned by [ProjectDigestGenerator](packages/service/src/digest/generator.ts)
  - `~/.gezel/handboek/narration/` — content-hash-keyed TTS narration WAVs + duration sidecars for Handboek articles, owned by [handboek/narration.ts](packages/service/src/handboek/narration.ts); derived cache, safe to delete
  - `~/.gezel/gezels/{id}/poppetje.json` — the resolved Poppetje struct (body shape, skin, hair, hat, etc.) driving the parametric figure renderer, owned by [PoppetjeManager](packages/service/src/poppetje/manager.ts). Persisted explicitly so adding new catalog entries or tuning slot odds later never drifts existing characters.
  - `~/.gezel/system-toolsets/` — two classes of pinned entry. **Eager** ones (Playwright + its Chromium) install at boot via [system-toolsets/bootstrap.ts](packages/service/src/system-toolsets/bootstrap.ts). **On-demand** ones (`onDemand: true` in the manifest — today only `@github/copilot-sdk`) install only when the user asks, through [system-toolsets/install-registry.ts](packages/service/src/system-toolsets/install-registry.ts). Read them back with `resolveInstalledSystemLibrary`, not `resolveSystemLibraryPath`: the strict resolver returns `null` on a version mismatch, which is right for eager entries the bootstrap upgrades in place, and would un-install every existing user of an on-demand entry the moment its pin moved.
  - `~/.gezel/git-clones/` and per-project checkouts (`workingDir`, `<workingDir>/gh/`, or the project workspace) — git working copies, owned by [git/manager.ts](packages/service/src/git/manager.ts)'s `resolveCheckout`
  - `~/.gezel/projects/{id}/code-reviews.json` — durable code-review records (kickoff → task ref → settled outcome), owned by [git/reviews.ts](packages/service/src/git/reviews.ts)'s `CodeReviewManager`; the snapshot inputs and reports live in the project artifacts drawer under `reviews/<reviewId>/`
  - `~/.gezel/sandbox/` — sandboxed script runs, owned by [sandbox/runner.ts](packages/service/src/sandbox/runner.ts)
  - `~/.gezel/python/` — uv runtime, owned by [python/uv-runtime.ts](packages/service/src/python/uv-runtime.ts)
  - Native binary trees (`~/.gezel/bin/llama-cpp/`, `sd-cpp/`, `uv/`) — owned by the matching provider; see [native/README.md](native/README.md) for the upstream fetch + bundle pipeline.

  If you're writing code that touches state outside this list, it goes through `Store`.
- **Path-safety primitives live in [packages/service/src/fs/safe-paths.ts](packages/service/src/fs/safe-paths.ts).** Anything that constructs a path from user/model input must funnel through `safeJoin` or `realpathContained` — the file's header explains the three latent bugs the naive `normalize(join(base, p)).startsWith(base)` pattern hides.
- **`ChatManager` owns sessions.** HTTP handlers should be thin wrappers. Tests that inject a pre-seeded `providers` map are the way to exercise chat flow deterministically.
- **MCP tools are how agents act.** If you find yourself teaching a gezel to "describe" doing something, consider adding a tool instead.
- **about.md is for character, not tool listings.** A gezel's about.md (role templates live in [bendyline/gilde](https://github.com/bendyline/gilde) under `data/gezel-templates/`) describes role, expertise, working style, preferences — the part that gives the gezel personality. The tool listing is auto-injected at session-build time as a `## Tools available this turn` block in the system prompt, sourced from the post-allowlist MCP bridge tools and the installed third-party toolset ids. Renderer in [chat/tools-block.ts](packages/service/src/chat/tools-block.ts), wired in [chat/manager.ts](packages/service/src/chat/manager.ts)'s `buildInstructions`. Don't enumerate tools in default about.md templates — they drift, the runtime doesn't, and the staleness is invisible until a model fabricates a call to a tool that doesn't exist (the McKinley Park weather incident: about.md said `browser_navigate`, `@playwright/mcp` wasn't loaded, the model emitted `<browser_navigate ... />` markup the salvage layer correctly refused to promote). The decision and its regression surface are recorded in [ADR 0001](docs/decisions/0001-runtime-tool-inventory.md).
  - Power-user override: a per-gezel `~/.gezel/gezels/{id}/tools.md` file fully **replaces** the auto-injected listing when present. The gezel's owner accepts responsibility for keeping it accurate. Path helper: [`gezelToolsPath`](packages/core/src/paths.ts). Drift in this file is detected by `ensureState`'s rebuild check the same way `about.md` drift is.
- **Editing prompts.** Read [docs/prompt-stack.md](docs/prompt-stack.md) first — it maps every layer of the system prompt, the per-turn prelude/nudge channel, and how delivery differs per provider (local vs cloud). Prompt text lives in exactly two homes: universal/standing text in `buildInstructions` in [packages/service/src/chat/manager.ts](packages/service/src/chat/manager.ts) (which also holds `CONTINUATION_NUDGE`, `VOORMAN_IDLE_NUDGE`, `CLOSING_SUMMARY_NUDGE`), and model-conditional text as a behavior in [packages/service/src/model-profile/behaviors/](packages/service/src/model-profile/behaviors/) (tier defaults in [defaults.ts](packages/service/src/model-profile/defaults.ts), toggleable per daemon via `GEZEL_FORCE_BEHAVIORS`/`GEZEL_REMOVE_BEHAVIORS`). These prompts compound — guardrail + about + project context can pass 2000 tokens before the user's question — so verbosity costs attention at depth, especially on small local models. Imperative over explanatory, and ask "is this for the model or for a future engineer?" before adding a block. Measure real sizes with `GEZEL_PROMPT_BREAKDOWN=1`.
- **Supervisor branches extract their disk/process logic into a sibling helper with its own test.** [extract-bundle.ts](packages/app/src/supervisor/extract-bundle.ts), [extract-node.ts](packages/app/src/supervisor/extract-node.ts), [extract-pnpm.ts](packages/app/src/supervisor/extract-pnpm.ts), [native-bin.ts](packages/app/src/supervisor/native-bin.ts), and [llama-backend.ts](packages/app/src/supervisor/llama-backend.ts) are the exemplar pattern. New supervisor branches follow the same shape so [index.ts](packages/app/src/supervisor/index.ts) stays an orchestrator.
- **Use the logger, not `console`.** Production code logs through [packages/core/src/log.ts](packages/core/src/log.ts) (`createLogger('chat')`, `.debug/.info/.warn/.error`). Levels are gated by `GEZEL_LOG_LEVEL` (`debug|info|warn|error|silent`, default `info`). `console.*` is reserved for one-shot CLI output and tests.
- **Electron changes require a full rebuild**. The service is bundled into the Electron bundle at build time; `pnpm app` does `pnpm build && electron .`.
- **No emojis in committed files** unless a user explicitly requested one (the ⭐ Meester badge in the sidebar is the exception — the user asked for it).
- **No trailing comments explaining what code does.** Prefer naming + structure. Reserve comments for *why* — hidden constraints, past incidents.

## Development

- `pnpm install` — bootstrap.
- `pnpm build` — full workspace build; required before `pnpm test:e2e` or `pnpm app`.
- `pnpm build:bundle` — build the relocatable service bundle via `pnpm deploy --prod`. Output at `packages/app/dist/service-bundle/`. Needed before packaging a distributable.
- `pnpm build:packaged` — shortcut: `build` + `build:bundle`.
- `pnpm typecheck` — runs `tsc --noEmit` across every package.
- `pnpm test` — Vitest across every gezel package. ~3m45s on an 18-core workstation, ~12 min on CI. The service suite is ~90% of that on its own; scope to one package (`pnpm --filter @bendyline/gezel-ui run test`) while iterating.
- `pnpm test:ci` — same suites, one package at a time. What CI runs: the 4-vCPU runner cannot absorb several package worker pools at once, and the contention starves fixed test timeouts. Use locally only to reproduce a CI-only timing failure.
- `pnpm test:e2e` — Playwright Electron suite. ~25s.
- `pnpm app` — build then launch the Electron shell (embedded mode by default).
- `pnpm dev` — watch-mode build across every gezel package.

### Supervisor env flags

- `GEZEL_EMBEDDED=1` — force in-process mode. Set in every existing E2E spec for speed and determinism. Use during dev when iterating on service code.
- `GEZEL_SPAWN=1` — dev-mode opt-in to spawn `gezeld` from `packages/service/dist/bin/gezeld.js` as an attached child. Exercises the real supervisor path locally. Exercised by [supervisor-spawn.spec.ts](packages/app/e2e/supervisor-spawn.spec.ts).

### Bundled runtimes

The Electron app ships two binary runtimes asar-unpacked alongside the service bundle, so packaged-mode users don't need system Node or pnpm:

- **pnpm** — build-time fetch [fetch-pnpm.mjs](packages/app/scripts/fetch-pnpm.mjs) + runtime extract [extract-pnpm.ts](packages/app/src/supervisor/extract-pnpm.ts) land the pinned ordinary, platform-neutral pnpm npm package at `~/.gezel/bin/pnpm-runtime/`. Supervisor sets `GEZEL_PNPM_PATH` to `bin/pnpm.mjs`; `resolvePnpmCommand` launches it through `GEZEL_NODE_PATH` on Windows, macOS, and Linux, falling back to `pnpm` on PATH when unset. Gezel does not redistribute pnpm's standalone executable. Version + package/license pins live in [pnpm-version.ts](packages/app/src/pnpm-version.ts); bump via `node scripts/bump-pnpm.mjs <version>`. Placeholder (zeros) shas are a hard build error — set `GEZEL_PNPM_SKIP=1` at build time to opt out (dev iteration without bumping).
- **Node.js** — same shape: [fetch-node.mjs](packages/app/scripts/fetch-node.mjs) + [extract-node.ts](packages/app/src/supervisor/extract-node.ts) land the pinned `node[.exe]` binary at `~/.gezel/bin/node[.exe]`. Supervisor sets `GEZEL_NODE_PATH`; the sandbox runner prefers it over bare `node` on PATH. Version pin in [node-version.ts](packages/app/src/node-version.ts); bump via `node scripts/bump-node.mjs <version>`. Placeholder shas hard-fail; `GEZEL_NODE_SKIP=1` opts out. On Windows we download a standalone `node.exe`; on macOS/Linux we extract only the `bin/node` binary out of the official tarball via the `tar` package.

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
- **A GitHub token is optional for engine downloads, and must stay optional.** `bendyline/gezel` is public. [engines/resolver.ts](packages/service/src/engines/resolver.ts) uses a token only to lift GitHub's 60-request/hour unauthenticated API limit. Do not reinstate a hard token gate: users who installed from npm have no `gh` login, and requiring one makes on-device engines unreachable for everyone outside this repo.
- **Copilot SDK needs time on first call.** Cold-start ~30–90s. Timeouts below 120s flake. The SDK also sometimes rejects `sendAndWait` with "Timeout waiting for session.idle" *after* the model has already streamed a full response — we buffer deltas and fall back to the buffered content when that happens. See `copilot.ts`/`openai.ts` `CopilotSession.sendAndWait`.
- **A packaged build with Copilot not installed fails *fast*, not slow.** Don't diagnose it as a cold-start timeout. The SDK is an on-demand toolset and is stripped from the shipped bundle by `pnpm deploy --prod`, so `loadSdk()` throws immediately; the error says "install it in Settings" and carries `isActionable = true`. That marker is load-bearing — without it `ChatManager.ensureProvider` rewrites the message into "check your credentials", pointing at the wrong problem.
- **OpenAI's native MCP is HTTP-only.** The OpenAI Responses API's `tools: [{type: 'mcp', ...}]` shape only accepts HTTP remote servers, so it can't talk to stdio MCP servers like `@bendyline/gezel-mcp`. We work around this by running the bridge ourselves: [packages/service/src/providers/mcp-bridge.ts](packages/service/src/providers/mcp-bridge.ts) is a unified MCP client that dispatches between `StdioClientTransport` and `StreamableHTTPClientTransport` (plus SSE for older servers) via the `isHttpSpec()` discriminator on the spec. Both `OpenAIProvider` and `AnthropicProvider` consume the same `McpBridgePool` — there's no per-provider bridge ownership. Don't try to plug stdio specs into OpenAI's native MCP tool shape; route everything through the pool.
- **`quotaSnapshots` from Copilot is a map, not a single value.** Pro+ users have multiple quota buckets (chat = unlimited, premium interactions = limited). Picking `Object.values(snapshots)[0]` hides the limited one. We surface all buckets and sort most-constrained first.
- **Squisq editor is an external package** ([`bendyline/squisq`](https://github.com/bendyline/squisq)) — some integration points live in that repository, whose local checkout location is not fixed. Use `pnpm link:squisq` when testing a sibling checkout. When a new capability belongs in Squisq (for example, the chat composer's `submitOnEnter` prop), change it there and rebuild before updating Gezel's pinned package versions. One caveat while linked: `pnpm build:bundle` lifts the squisq/gilde `link:` overrides out of `pnpm-workspace.yaml` for the duration of the `pnpm deploy` and restores them afterwards — pnpm cannot materialize a `link:` dep into a deployed tree, so the bundle always reflects the registry pins, not your sibling checkout.
- **Gilde content is external** ([`bendyline/gilde`](https://github.com/bendyline/gilde)) — same shape as squisq: sibling checkout at `../gilde` and `pnpm link:gilde` / `pnpm unlink:gilde`. CI and release workflows run `pnpm check:local-links` before dependency installation so a committed `link:` override fails with a clear message. That guard only *enforces* when `CI` is set (or `GEZEL_ENFORCE_LOCAL_LINKS=1`) — a local `pnpm validate` / `pnpm all` just warns, so the full gate stays runnable while linked, and hard-fails only when a link points at a checkout that is not on disk. Content correctness gates run in gezel CI against the *pinned* `@bendyline/gilde` version (the catalog package's data-contract tests), so a bad content release fails here at bump time, before it ships.
- **`@bendyline/gilde` must keep `./package.json` exported.** The catalog loader locates the content root via `createRequire(...).resolve('@bendyline/gilde/package.json')` ([gilde-data.ts](packages/catalog/src/gilde-data.ts)). If a gilde release ships an `exports` map without that subpath, resolution throws and the service boots with an **empty catalog** — no error, just no models/templates/craftbooks. Guarded by `packages/catalog/src/gilde-data.test.ts` (mirror of the mcp `./dist/server.js` gotcha).
- **`gilde/schemas/*.schema.json` are generated from core's Zod schemas.** Regenerate with `pnpm gilde:export-schemas` whenever `packages/core/src/schemas/*` changes, and PR the result to gilde. Gilde CI validation is deliberately *looser* than the runtime (Zod refinements don't survive `z.toJSONSchema`); gezel's `.parse()` of the pinned content stays authoritative. The exporter throws on unrepresentable constructs (e.g. `z.transform`) rather than silently weakening gilde CI. **Forgetting to regenerate has a silent failure mode:** a manifest that uses a newly-added enum value (family/behavior/format) fails the stale generated schema's ajv identity check, so `build-index` drops it from the index with no error (`--verbose` → `skip … invalid-identity`) and the daemon serves it with default tuning. Regenerate before `build-index` whenever a content edit depends on a core-schema change — see the content-change dance above.
- **The MCP server runs as a child process** with a fresh Node environment. Env variables we pass are its only connection to the running service — don't rely on anything else being inherited implicitly.
- **The embedded fallback loads from the unpacked service-bundle, not from `app.asar/node_modules/`.** [supervisor/index.ts](packages/app/src/supervisor/index.ts)'s `startEmbeddedRaw` dynamic-imports `app.asar.unpacked/dist/service-bundle/dist/index.js` via a `file://` URL when that file exists (packaged mode), and only falls back to bare-specifier `import('@bendyline/gezel-service')` for dev (workspace symlink). The reason: electron-builder's pnpm dep walker copies `@bendyline/gezel-service` into `app.asar` but doesn't follow its transitive deps — about 100 packages get silently dropped, so any embedded boot from there crashes with `ERR_MODULE_NOT_FOUND` on whichever transitive (zod-to-json-schema, @octokit/endpoint, etc.) is imported first. The service-bundle (built by `pnpm deploy --prod --legacy`) has a complete pnpm tree and is the same source the spawned daemon uses. Net effect: one canonical service tree on disk, consumed by both spawn and embedded paths.

  Practical implication: **don't add `@bendyline/gezel-service` (or its transitive deps) to [packages/app/package.json](packages/app/package.json)**. Doing so would re-introduce a parallel tree in `app.asar` that the embedded path no longer reads from, just bloating the installer.

## Where to look when things break

| Symptom | First place to look |
|---|---|
| Chat messages disappear on restart | `Store.writeSession` + `ChatManager.send`'s `store.writeSession` call |
| Icons show as initial-letter placeholders | `oneShotCompletion` logs for timeouts; check credentials |
| MCP tools don't fire | `[chat] @bendyline/gezel-mcp not found` log; mcp package exports |
| "Unlimited" shown for a user with a real cap | `CopilotProvider.parseUsage` — look at the raw event |
| Provider switch doesn't take effect | `ChatManager.resetClient` gets called on credential change; check `config.ts` reset-fields list |
| E2E fails "waiting for…" | Usually `GEZEL_MOCK_PROVIDER=1` not set, or the Electron window didn't reach `domcontentloaded` in time |

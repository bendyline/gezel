# @bendyline/gezel-cli

The `gezel` command line — assemble a team of AI companions (*gezellen*) and put
them to work from your terminal.

Gezel is local-first. Everything you create lives on your disk under `~/.gezel/`
as ordinary files you can `cat` and `grep`, and talks to whichever LLM provider
you point it at. No cloud service of ours stands between you and the model.

```bash
npm install -g @bendyline/gezel-cli
gezel
```

On a clean machine, the TUI stays in first-time setup until you decide what to
install. It offers the verified Gezel native toolkit first, downloaded from
the [Gezel GitHub Releases](https://github.com/bendyline/gezel/releases/), then
device-ranked model choices:

1. The best chat model plus every recommended image, speech, reading, and video
   helper that fits this device.
2. The best chat model only.
3. Other compatible chat-only models, ordered for this device.

Downloads show live progress and activate inside the running daemon, so setup
continues directly into the TUI without a restart.

If the per-user or machine-shared store already has the configured model, the
TUI uses it without downloading another copy. A stale recommendation never
counts merely because some other shared model exists: setup asks you to use an
available model or download the recommendation instead.

## Which Gezel service the CLI uses

With no connection flags, the CLI follows this order:

1. During rolling-upgrade compatibility only, use an older `legacy-full`
   machine service when one is present. A modern machine service on port
   `6228` is an engine broker, not a product API, so the CLI never sends it
   projects, credentials, tools, or terminal requests.
2. Discover the logged-in user's product daemon through the same pinned
   runtime discovery used by the Gezel app SDK. Its actual dynamic port and
   pinned TLS certificate come from `~/.gezel/runtime`; management commands
   may start that user-role daemon when it is absent. The interactive TUI
   retains ownership when it starts a daemon itself, so exiting the TUI runs
   the daemon's complete shutdown path and cleans up its local engine children.
3. On first use, the terminal waits while the Gezel app asks you to approve
   **Gezel CLI**. The terminal shows a six-character code that you enter in
   the app to confirm that you initiated the request. The resulting revocable,
   CLI-scoped credential is saved under `~/.gezel/cli/tokens/`. Its logical
   local key survives daemon port and certificate rotation.

`gezel run` has one deliberate lifecycle exception: if no user daemon exists,
it starts a user-role service in-process for that one invocation and stops it
afterward. It does not take that fallback after a denied grant or when a live
daemon is unhealthy.

The per-user daemon owns gezels, projects, settings, credentials, and
conversations with ordinary user filesystem permissions. It discovers the
machine engine broker independently for centralized model downloads and local
inference. The CLI does **not** open the machine service's private data
directory directly.

It may reuse two deliberately public asset surfaces:

- Immutable machine models under the installer-owned `assets/models/` tree.
  User-owned models in `~/.gezel/engines/` take precedence; the CLI re-hashes
  a machine model on first adoption, caches file identity/size/mtime locally,
  and downloads replacements only into its user-owned home.
- Electron's `native-bin/` payload when its native release exactly matches the
  CLI pin, every executable/loadable file matches the per-file hashes embedded
  in the CLI, and platform signing checks pass. Any mismatch falls back to the
  CLI's independently downloaded native cache.

The global overrides are:

```bash
gezel --connect https://host:6228        # explicit service; approval on first use
gezel --connect https://host:6228 --token "$TOKEN"
gezel --standalone                        # skip legacy-full compatibility
gezel --home /path/to/another-home        # standalone with an alternate home
```

`--home` (and an explicitly set `GEZEL_HOME`) implies standalone operation.
An explicit `--port 6228` remains available when you intentionally want a
CLI-owned daemon on the canonical port.

## What you get with no further setup

The CLI does not bundle native inference engines; those are downloaded only on
demand when you opt into on-device models. Straight away you can use:

- The interactive TUI (`gezel`) and one-shot prompts (`gezel run "…"`)
- Cloud providers — OpenAI, Anthropic, GitHub Copilot, and any
  OpenAI-compatible endpoint
- Gezel and project management (`gezel agent`, `gezel env`, `gezel task`)
- Skills and handbook export (`gezel skills convert`, `gezel handboek export`) —
  these need no running daemon at all

## Running models on your own machine

On-device chat, local image and video generation, and speech-to-text need
native engine binaries (llama.cpp, stable-diffusion.cpp, whisper.cpp, uv).
They are far too large to ship inside an npm package — the CUDA build alone is
over 700 MB — so they are downloaded once, on request:

```bash
gezel native install                 # this platform's default backend
gezel native install --variant cuda  # or cpu / vulkan / metal
gezel native status
```

Downloads come from this repository's `native-v*` GitHub releases and are
verified before use. Every archive SHA256 is compiled into the published
package; the release's `SHA256SUMS` file must both match its own compiled
digest and agree with the selected compiled archive hash. The downloaded
archive is then hashed against that local value.

First-party Windows executables and loadable DLLs must carry a valid Bendyline
Authenticode signature, while macOS executable code must carry the expected
Developer ID.
Standalone macOS archives are accepted by Apple's notary service in release
CI before their hashes are pinned. Bare command-line binaries cannot carry a
stapled ticket or be assessed as app bundles, so runtime checks combine those
source-pinned hashes with Developer ID validation. Electron reuse separately
requires a `Notarized Developer ID` Gatekeeper assessment of the parent
`.app`. Linux has no equivalent native signing channel and remains anchored
by the compiled hashes. The upstream `uv.exe` is an explicit unsigned
exception, verified by its compiled
archive hash. Each CLI release resolves one exact native release rather than
following `latest`; the setup prompt shows that pinned version. Nothing is
fetched until you ask for it.

## Commands

Run `gezel --help` for the full list. The most-used ones:

| Command | What it does |
|---|---|
| `gezel` | Launch the interactive TUI |
| `gezel run [prompt…]` | One-shot prompt in the current directory's project, using its voorman by default; optionally `--gezel <id>` / `--project <folder>` |
| `gezel do <craftbook…>` | Start a craftbook as an immediately dispatched task in the current directory's project; accepts its id or display name |
| `gezel start` / `stop` / `status` | Use or inspect the selected service. `stop` is the same hard stop as the desktop UX: cancel work, unload local engines, and switch to Reactive. `stop --daemon` shuts down a user-owned daemon process itself. `start --web` serves the browser UI. On hosts without a Gezel machine service, a started daemon prefers the canonical port 6228 (ephemeral fallback) so third-party OpenAI clients get a stable `https://127.0.0.1:6228/v1` base URL; with a machine service installed, the service owns 6228 and started daemons use an ephemeral port (`--port` pins one explicitly). |
| `gezel doctor` | Report on the local install |
| `gezel mode [read-only\|reactive\|reactive+tasks\|full-play]` | Show or change how much AI activity is allowed |
| `gezel agent list\|create\|show` | Manage your gezels |
| `gezel env list\|create\|install` | Manage projects and their packages |
| `gezel task list\|create\|show` | Manage tasks |
| `gezel model list\|pull` | Manage on-device chat models |
| `gezel native install\|list\|status` | Manage native engine binaries |
| `gezel create-image\|create-video\|create-audio` | Generate media |
| `gezel skills import\|convert` | Import and convert skills |
| `gezel handboek export --out <dir>` | Export the handbook |

Inside the interactive TUI, `/continue` processes due schedules and reconciles
gezel-owned active tasks for the current project. Night Shift is managed with
`/nightshift start`, `/nightshift stop`, and `/nightshift list`; the command
wordwheel exposes all three subcommands. `/mode` opens a picker for the same
four activity levels as the one-shot command; `/mode reactive+tasks` (for
example) switches directly. `/model` lists every installed user/shared model
and includes **Download a new model**; `/model download` opens that device-ranked
download list directly. A completed download is selected for the active gezel
and starts a fresh chat. Project edit permissions are available through
`/allow` and `/disallow`: use `edits` for built-in tools and background work,
`codexedits` for Codex sessions, or `claudeedits` for Claude sessions. For
example, `/disallow edits` makes Gezel-managed access to the current project
read-only, while `/allow codexedits` puts Codex in project-scoped edit mode.

## Stability

The supported public surface of this package is its **command line** — the
commands, their flags, and their output contracts. It ships no JavaScript API;
`import`ing from it is unsupported and its internal module layout will change
without a major version bump.

Breaking changes to commands or flags follow semver.

## Documentation

- [Repository and full documentation](https://github.com/bendyline/gezel)
- [Release process](https://github.com/bendyline/gezel/blob/main/docs/npm-release.md)

MIT © Bendyline

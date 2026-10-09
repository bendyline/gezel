# @bendyline/gezel-cli

The `gezel` command line — assemble a team of AI companions (*gezellen*) and put
them to work from your terminal.

Gezel is local-first. Everything you create lives on your disk under `~/.gezel/`
as ordinary files you can `cat` and `grep`, and talks to whichever LLM provider
you point it at. No cloud service of ours stands between you and the model.

```bash
npm install @bendyline/gezel-cli
npx gezel
```

On a clean machine, the TUI stays in first-time setup until you decide what to
install. It offers the verified Gezel native toolkit first, downloaded from
the [Gezel GitHub Releases](https://github.com/bendyline/gezel/releases/), then
device-ranked model choices:

1. The best chat model for this device, by itself. This is the recommended
   default and keeps the first download small.
2. An optional complete workshop set that adds every recommended image,
   speech, reading, and video helper that fits this device.
3. Other compatible chat-only models, ordered for this device.

Downloads show live progress and activate inside the running daemon, so setup
continues directly into the TUI without a restart. Setup only offers helpers
whose runtime is present: the lean npm install omits the in-process Kokoro TTS
stack, while desktop and relocatable distributions include its reviewed
runtime.

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
   may start that user-role daemon when it is absent, and say so on stderr
   because it keeps running afterwards (`gezel stop --daemon` ends it). A
   daemon the CLI starts keeps its own log in
   `~/.gezel/logs/service-YYYY-MM-DD.log` (rolled at 10 MB, kept 7 days).
   Read-only diagnostics such as `gezel native status` and `native list`
   never leave one behind: with no daemon running they answer from a
   service that stops with the command. The interactive TUI
   retains ownership when it starts a daemon itself, so exiting the TUI runs
   the daemon's complete shutdown path and cleans up its local engine children.

For the per-user local daemon, the CLI connects with your same-user owner
credential from the protected runtime directory. This works on first use and
when adopting an already-running daemon, with no desktop approval prompt. The
npm package is sufficient for local CLI use; you do not need to install or open
the desktop app.

`gezel run` has one deliberate lifecycle exception: if no user daemon exists,
it starts a user-role service in-process for that one invocation and stops it
afterward. It does not take that fallback after a denied grant or when a live
daemon is unhealthy.

External service connections use a separate authorization path: an explicit
`--connect <url>`, or an older `legacy-full` machine service selected in step 1,
requires a CLI-scoped grant. If there is no valid saved grant or supplied
`--token`, the terminal shows a six-character code and waits for you to approve
**Gezel CLI** in the Gezel app. The resulting revocable credential is saved
under `~/.gezel/cli/tokens/` for that service. A valid saved grant or explicit
`--token` lets the connection proceed without that interaction.

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

## One-shot prompts and pipelines

Use `gezel run -` to read a UTF-8 prompt from a pipe or redirected file. It
reads until EOF and preserves line breaks and indentation:

```bash
printf 'Summarize these notes:\nThe launch is Friday.\n' | gezel run -
gezel run - < prompt.txt
```

The reply goes to stdout, so you can redirect it to a file; diagnostics go to
stderr. Empty or whitespace-only input exits with status 1 before connecting
to a service. A sole `-` is required to read stdin; `gezel run "your prompt"`
continues to use its arguments, and bare `gezel run` shows usage.

## Provider credentials

Manage provider keys through the service credential store, using stdin or an
existing environment variable so the value does not appear in command arguments:

```bash
gezel secret list
gezel secret set braveSearchApiKey --env BRAVE_SEARCH_API_KEY --use-for-search
gezel secret set openaiApiKey --env OPENAI_API_KEY
gezel secret set anthropicApiKey --env ANTHROPIC_API_KEY
gezel secret remove openaiApiKey
```

`--use-for-search` (with `braveSearchApiKey`) also selects Brave as the
search provider while preserving its other settings. Without it, setting a
credential leaves provider selection unchanged. `secret list` gives the supported
names and whether each is configured; credentials are write-only and never
printed. All three commands support `--json`, and honor `--home` / `--connect`.
This covers the built-in provider credentials, including webhooks; it is not an
arbitrary environment-variable store. Storage uses the same native keyring or
encrypted fallback as the application.

After saving an OpenAI or Anthropic key, run `gezel` and use `/model` to choose
one of that provider's available models. The desktop app and CLI share the same
daemon credential store, so a key saved in either interface is available to both.

Search also requires the selected environment to allow external services.
`gezel security external-services` shows that setting; append `on` or `off` to
change it explicitly while preserving all other security capabilities. This
permission covers model-initiated external services, including web search.
Saving a credential does not silently enable it.

`gezel model context <id> 65536` sets a local model's context window for its next
launch; omit the token count to inspect it, or use `auto` to clear the override.
Use `--provider llama-cpp|mlx|ds4` to select an engine (defaults to the platform's
local engine). This can bound memory use for unattended batch tasks.

`gezel model concurrency 1` limits the local engine to one inference slot and
reduces its context-cache reservation. This is useful for serial batches with
large models. It preserves other providers' limits; `--provider` selects an
engine, and `auto` restores automatic sizing. Omit the value to inspect it.

`gezel env indexing off` disables optional background workspace indexing in
the current directory's project (or `--project` target). Artifact-driven batch
workflows over large generated datasets can use this to avoid unnecessary
indexing. `on` restores it; omitting the value reports its current state.
Both settings commands support `--json` and the ordinary connection/home flags.

## Batch craftbooks and repository workflows

`do` takes the craftbook, then its values. A bare value fills the next
required parameter the recipe asks people for, in `paramSchema.properties`
order. `key=value` and repeatable `--param key=value` set any parameter,
including ones launch forms hide, such as `workPath`. Every other word is your
request. It becomes the task description and, when the recipe declares one,
its main content parameter (`fromMessage`, else `topic`). Quoting is optional;
unquoted words are joined.

Any craftbook also runs by name: `gezel story-batch c23n` is
`gezel do story-batch c23n`. The name must match the craftbook's `command`
token (its id unless it declares one) exactly. Built-in commands always win.
A mistyped name reports an unknown command without creating a project, and
the expanded `gezel do …` line is printed to stderr. Workflow craftbooks
(below) run repository code, so they start only through `gezel do`.

```bash
gezel do summarize-long "Summarize notes.txt for the board"
gezel summarize-long "Summarize notes.txt for the board"
gezel do story-batch c23n limit=3 --wait --json
gezel task wait my-project/12 --timeout 7200 --json
gezel task resume my-project/12 --json
gezel task notes my-project/12 --warnings --json
```

Only explicit values are sent; the service resolves defaults such as
`{{task.dir}}` after allocating the task. Waiting exits with 0 for completion,
1 for cancellation, 2 for a paused task or pending user question, and 3 for a
timeout. A timeout leaves the daemon task running. Progress goes to stderr;
`--json` emits the result on stdout. `resume` retries a paused task using its
saved recipe. Answer pending questions in Gezel before waiting again.

For deterministic orchestration around several craftbooks, create
`.gezel/workflows/storyify.mjs`:

```js
export async function run({ client, projectId, workspace, args, log, runCraftbook }) {
  const [region] = args;
  log(`Working on ${region} in ${workspace}`);
  return runCraftbook('story-batch', { region });
}
```

Run it with `gezel workflow storyify c23n --json`. The module receives the
public `GezelClient`, the directory's project id, its absolute workspace,
arguments, a stderr logger, `complete(request)` (below), and
`runCraftbook(id, params, options)`. That helper
starts a **project** craftbook and waits; options include `timeoutMs`, a saved
`taskRef` to follow, `parentTaskRef` to link the child to its batch, and
`onCreated(task)` to checkpoint the new reference.
When a step needs model judgment on input the driver already holds — extract
the facts in this page, check this paragraph against these quotations — use
`complete(request)` instead of a craftbook. It makes one bounded call on the
project's engine queue and returns `{ content, json?, jsonError?, elapsedMs }`:

```js
const { json } = await complete({
  gezelId: 'checker',          // or provider + model
  system: 'You are a meticulous fact-checker.',
  prompt: `FACTS:\n${facts}\n\nSENTENCES:\n${sentences}`,
  jsonSchema: verdictSchema,   // grammar-constrained on local engines
  thinking: false,             // skip a local model's reasoning phase
  maxTokens: 4000,
  timeoutMs: 300_000,
  label: 'check · Taylorville ¶3',
});
```

No tools, session or transcript are involved, so there is nothing to read
back and nothing to save: the driver validates the answer and persists what it
keeps. Use a craftbook when the work genuinely needs tools or a person.

For drivers that generate craftbook documents, `validateCraftbook(document)`
checks the same schema and step contracts as the daemon and returns the runtime
craftbook. Call it before installing files or freezing a batch checkpoint;
invalid documents throw actionable authoring errors without creating a task.
Returning an object with `exitCode` sets the shell exit status. Module paths
also work: `gezel workflow ./pipeline/storyify.mjs c23n`.

To expose that driver as one command, add
`"cliWorkflow": { "module": ".gezel/workflows/storyify.mjs" }` to a project
craftbook and declare its inputs in `paramSchema`, listing the ones a bare
value should fill under `required`. Then run
`gezel do my-batch c23n limit=200 --json`. Its module receives `craftbook` and
validated explicit `params` in addition to the context above. A workflow
craftbook takes no request text. The driver owns
parent creation, defaults, checkpoints, bounded child concurrency, and the
final result. Modules must resolve inside the project workspace. Only project
craftbooks can use this entry point; `--strict-sandbox` rejects it.

### Declaring what a craftbook needs

A craftbook can declare the chat models it runs on and the capabilities it
cannot run without. `gezel do` checks them before anything starts:

```json
"services": [{ "kind": "web-search", "reason": "research checks every fact" }],
"models": [
  { "id": "qwen3.8-27b-q4", "reason": "writes the stories" },
  { "id": "{{checkerModel}}", "provider": "llama-cpp", "reason": "checks every sentence" }
]
```

`web-search` means a keyed search provider (Brave): Wikipedia does not count,
and it implies `external-services`, which a book that only fetches pages can
declare on its own. A model `id` (or `provider`) may be a `{{param}}`
reference, resolved from the run's value or its `paramSchema` default; one
that resolves to nothing is skipped. `provider` defaults to this computer's
on-device engine.

At a terminal, each missing piece is one question: turn on External services
(naming the security level it moves to), paste a Brave Search API key (hidden,
then proven with one test search, and removed again if that fails), and
download the models (after a disk-space check, with the engine if it is
missing). Any "no", or a run without a terminal, stops before the run starts
and prints the commands that fix it:

```text
gezel security external-services on
gezel secret set braveSearchApiKey --env BRAVE_SEARCH_API_KEY --use-for-search
gezel model pull qwen3.8-27b-q4 --provider llama-cpp
```

A workflow module whose models depend on its own options asks at run time with
`ensureSetup({ services, models })` on its context, which behaves the same way.
`runCraftbook` checks the child book's declared needs too.

These drivers run in the foreground even without `--wait`; keep the terminal
open until completion. A timeout applies to each child wait. If the CLI exits,
already-created daemon tasks survive, but further orchestration requires the
workflow's resume command. `gezel task wait` observes a parent and its children;
it does not restart a repository driver.

Project recipes live in `.gezel/craftbooks/<id>/manifest.json` (identity) and
`versions/<version>/craftbook.json` (the complete recipe, including embedded
scripts). Legacy version manifests plus `scripts/*.ts` remain supported.
Changing a recipe affects new tasks; running tasks retain their snapshots.

CLI craftbook launches, including TUI `/do`, authorize the exact embedded
script contents in that task snapshot. On Windows and other platforms without
an enforceable OS network boundary, those scripts use best-effort network
isolation. Declared capabilities and project/security policies still apply.
Use `gezel do ... --strict-sandbox` to require the OS boundary instead. Edited
scripts do not inherit the old source's trust, and a model session cannot
grant trust. Workflow modules themselves run as ordinary local Node code,
with the invoking user's permissions, like an npm script.

## What you get with no further setup

The CLI does not bundle model weights or native inference engines; those are
downloaded only on demand when you opt into on-device models. Straight away
you can use:

- The interactive TUI (`gezel`), which walks you through choosing a model on
  first use, and one-shot prompts (`gezel run "…"`) once a model is set up.
  Until then `run` downloads nothing: it names the setup commands and exits.
- Cloud providers — OpenAI, Anthropic, GitHub Copilot, and any
  OpenAI-compatible endpoint
- Gezel and project management (`gezel agent`, `gezel project`, `gezel task`)
- Skills and handbook export (`gezel skills convert`, `gezel handboek export`) —
  these need no running daemon at all
- Knowledge catalogs you already have: `gezel knowledge validate`, `inspect`
  and full-text `search` work offline, with no daemon

Building a catalog (`gezel knowledge build`) and `gezel knowledge search
--semantic` also need the embedding runtime, which an npm install leaves out.
Add it where Gezel is installed (drop `-g` for a project install); the desktop
app already includes it:

```bash
npm install -g @huggingface/transformers@^4.3.1
```

In a project install, also add the `overrides` from the
[`@bendyline/gezel-service` README](https://www.npmjs.com/package/@bendyline/gezel-service),
which keep Kokoro on the same Transformers.js copy as the service.

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
| `gezel run [prompt…]` | One-shot prompt (a sole `-` reads stdin) in the current directory's project, using its voorman by default; optionally `--gezel <id>` / `--project <folder>` |
| `gezel do <craftbook…>` | Start a craftbook as an immediately dispatched task in the current directory's project; accepts its id, command, or display name, then required values, `key=value` parameters, and your request |
| `gezel <craftbook> …` | Shorthand for `gezel do <craftbook> …`, matched exactly on the craftbook's command or id; built-in commands always win |
| `gezel workflow <name-or-file> [args…]` | Run an explicitly trusted repository workflow from `.gezel/workflows/<name>.mjs` or a module path |
| `gezel secret list / set / remove` | Manage write-only provider credentials, including the Brave search key |
| `gezel task wait <ref>` / `resume <ref>` | Follow a task to completion, or retry a paused task and follow it |
| `gezel task notes <ref> --warnings` | Read task notes and runtime warnings from its recent sessions |
| `gezel start` / `stop` / `status` | Use or inspect the selected service. `stop` is the same hard stop as the desktop UX: cancel work, unload local engines, and switch to Reactive. `stop --daemon` shuts down a user-owned daemon process itself. `start --web` serves the browser UI, reusing a daemon that already serves it; when a daemon is running without it, `start --web --restart` replaces that daemon (the same applies to `--port`). On hosts without a Gezel machine service, a started daemon prefers the canonical port 6228 (ephemeral fallback) so third-party OpenAI clients get a stable `https://127.0.0.1:6228/v1` base URL; with a machine service installed, the service owns 6228 and started daemons use an ephemeral port (`--port` pins one explicitly). |
| `gezel doctor` | Report on the local install |
| `gezel mode [read-only\|reactive\|reactive+tasks\|full-play]` | Show or change how much AI activity is allowed |
| `gezel agent list\|create\|show` | Manage your gezels |
| `gezel project list\|create\|install` | Manage projects and their packages (`gezel env` is the same command) |
| `gezel task list\|create\|show` | Manage tasks |
| `gezel model list\|pull\|export` | Manage on-device chat models. `export <id> [file]` downloads the catalog model if needed, then writes a portable, checksum-verified `.gezmodel` you can move to another machine |
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

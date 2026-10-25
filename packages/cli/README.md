# @bendyline/gezel-cli

The `gezel` command line: assemble a team of AI companions (*gezels*) and put
them to work from your terminal.

## Quick start

Install the CLI globally. It needs Node.js 24 or newer:

```bash
npm install -g @bendyline/gezel-cli
```

Then choose where the AI runs.

**On this computer.** See which chat models fit your machine, download one,
and make chats use it:

```bash
gezel model list --available
gezel model pull <id>
gezel model use <id>
```

**With a cloud provider.** Save your API key without putting it on the command
line, then pick one of that provider's models with `/model` inside `gezel`:

```bash
gezel secret set openaiApiKey --env OPENAI_API_KEY
gezel secret set anthropicApiKey --stdin < anthropic-key.txt
```

Now start working:

```bash
gezel                                   # the interactive terminal app
gezel run "Summarize this project"      # one prompt, one reply
```

The first time you run `gezel` on a new machine, it walks you through the same
choices: it offers the verified Gezel native toolkit, then the best chat model
for this device (recommended, and the smallest first download), an optional
complete set of image, speech, reading, and video helpers that fit, or other
compatible chat models. Downloads show live progress and take effect without a
restart. A model you already have, in your own store or one the desktop app
shares on this machine, is used without downloading another copy.

Gezel is local-first. Everything you create lives on your disk under
`~/.gezel/` as ordinary files you can `cat` and `grep`, and talks to whichever
model provider you point it at. No cloud service of ours stands between you and
the model. The npm package is all you need; the desktop app is optional.

## Commands

Run `gezel --help`, or `--help` on any command, for every option.

| Command | What it does |
|---|---|
| `gezel` | Open the interactive terminal app for this folder's project |
| `gezel run [prompt…]` | One prompt, one reply, using this project's crew lead unless you pass `--gezel <id>`. A sole `-` reads the prompt from stdin |
| `gezel do <craftbook…>` | Start a craftbook as a task in this folder's project: its name, then required values, `key=value` parameters, and your request. `--wait` follows it to the end |
| `gezel <craftbook> …` | Shorthand for `gezel do <craftbook> …`, matched exactly on the craftbook's command name; built-in commands always win |
| `gezel craftbook list [words…]` | List the craftbooks `gezel do` can start in this folder's project (command name, title, category); words filter by command, title, and tags. `--json` for scripts |
| `gezel workflow <name-or-file> [args…]` | Run a repository workflow from `.gezel/workflows/<name>.mjs` or a module path |
| `gezel task list\|show\|create` | Tasks across every project |
| `gezel task wait\|resume\|pause <ref>` | Follow a task to the end, retry a paused task and follow it, or pause one task |
| `gezel task notes <ref>` | A task's notes, including pause reasons and failed checks (`--warnings` adds runtime warnings) |
| `gezel agent list\|create\|show\|output-limit` | Manage your gezels (the command name is historical) |
| `gezel project list\|create\|install\|indexing` | Manage projects, their npm packages, and background indexing (`gezel env` is the same command) |
| `gezel skills list\|import\|convert` | Find SKILL.md skills and turn them into craftbooks |
| `gezel app …` | Build, install, apply, and serve AI Apps (`.gezapp`): `new`, `validate`, `pack`, `add`, `update`, `list`, `show`, `apply`, `status`, `serve`, `enable`, `disable`, `remove`, `schemas` |
| `gezel model list\|pull\|use\|export` | On-device chat models. `list --available` shows the catalog models that fit this machine, with sizes; `use <id>` makes chats use a downloaded model (a pull does this itself when no working default is set); `export <id> [file]` writes a portable, checksum-verified `.gezmodel` |
| `gezel model context\|concurrency` | A local model's context window, and how many requests a local engine serves at once |
| `gezel native install\|list\|status` | The native engines that run models on this computer |
| `gezel image status\|models\|pull\|rm` | Image-generation models |
| `gezel create-image\|create-video\|create-audio` | Generate an image, a video, or spoken audio |
| `gezel knowledge …` | Build, check, and search `.gezk` knowledge catalogs (`init`, `build`, `validate`, `inspect`, `export-parquet`, `search`, `nearby`), and manage the ones installed in Gezel (`available`, `install`, `list`, `remove`, `find`) |
| `gezel secret list\|set\|remove` | Provider keys, stored write-only |
| `gezel security external-services [on\|off]` | Whether gezels may use web search and other outside services |
| `gezel mode [mode]` | Show or set how active the AI may be: `read-only`, `reactive`, `reactive+tasks`, or `full-play` |
| `gezel start` / `status` / `stop` | Start, check, or stop your Gezel service (see [Starting and stopping](#starting-and-stopping)) |
| `gezel doctor` | Check the installation |
| `gezel cleanup` | Show or reclaim the space Gezel uses on this device (`--redownloadable`, `--models`, `--dry-run`, …) |
| `gezel backup <file>` / `restore <file>` | Write your gezels, projects, and documents to a backup file, or bring them back (`restore --list` looks first) |
| `gezel handboek export --out <dir>` | Render the Handboek, Gezel's built-in documentation, as a static website |

## Starting and stopping

- `gezel start` makes sure your Gezel service is running. `--port <n>` pins a
  port, and `--foreground` keeps it attached to the terminal (Ctrl+C stops it).
- `gezel start --web` also serves the browser interface on this computer and
  prints a browser URL carrying a sign-in token that is valid until the service
  restarts. `--open` opens it for you. When a running service was started
  without the web interface, `gezel start --web --restart` replaces it.
- `gezel status` reports whether the service is up and where; it exits 1 when
  it is not running or not healthy.
- `gezel stop` cancels any AI work and shuts down your per-user Gezel service.
- `gezel stop --keep-running` is the emergency brake: cancel AI work, unload
  engines, switch to Reactive, and leave the service running. (`--daemon` is
  still accepted as an alias of the plain stop.)

If the desktop app's machine-wide service is in use, `gezel stop` does the
emergency brake on it and says the service is managed by the operating system.

Inside the interactive app, `/mode` switches the same four activity levels and
`/model` lists every installed model, with **Download a new model** to fetch
another; the download is selected for the active gezel and starts a fresh chat.
`/continue` processes due schedules and picks up the current project's active
tasks, and `/nightshift start|stop|list` manages Night Shift. `/allow edits` and
`/disallow edits` let Gezel's own tools and background work edit the current
project, or make it read-only for them; `codexedits` and `claudeedits` do the
same for gezels that run on the Codex or Claude command-line tools.

## One-shot prompts and pipelines

`gezel run -` reads a UTF-8 prompt from a pipe or redirected file. It reads
until EOF and keeps line breaks and indentation:

```bash
printf 'Summarize these notes:\nThe launch is Friday.\n' | gezel run -
gezel run - < prompt.txt
```

The reply goes to stdout, so you can redirect it to a file; diagnostics go to
stderr. Empty input exits with status 1 before anything starts. Without a sole
`-`, `gezel run "your prompt"` uses its arguments, and bare `gezel run` shows
usage. Until a model is set up, `run` downloads nothing: it names the setup
commands and exits.

## Provider keys

Provider keys go into the same credential store the desktop app uses, read from
an environment variable or from stdin so the value never appears in your
command arguments or shell history:

```bash
gezel secret list
gezel secret set openaiApiKey --env OPENAI_API_KEY
gezel secret set anthropicApiKey --env ANTHROPIC_API_KEY
gezel secret set braveSearchApiKey --env BRAVE_SEARCH_API_KEY --use-for-search
gezel secret remove openaiApiKey
```

`--stdin` reads the value from a pipe or redirected file instead. The supported
names are `openaiApiKey`, `openaiOrganization`, `anthropicApiKey`,
`googleAiApiKey`, `githubToken`, `braveSearchApiKey`, `tavilyApiKey`,
`webhookBearerToken`, and `webhookBasicAuth`; `gezel secret list` shows them and
whether each is set, but never prints a value. All three commands accept
`--json`. Storage uses your system keyring, or an encrypted file where there is
none.

`--use-for-search` (with `braveSearchApiKey`) also makes Brave the web search
provider. Web search also needs outside services to be allowed:
`gezel security external-services` shows that setting, and `on` or `off`
changes it. Saving a key never turns it on for you.

After saving an OpenAI or Anthropic key, run `gezel` and use `/model` to choose
one of that provider's models. A key saved in the desktop app or the CLI is
available to both.

Three settings help with long unattended batches:

- `gezel model context <id> 65536` sets a local model's context window for its
  next launch; omit the number to see it, or use `auto` to clear it.
- `gezel model concurrency 1` limits the local engine to one request at a time,
  which also reserves less memory; `auto` restores automatic sizing.
- `gezel env indexing off` pauses optional background indexing in this folder's
  project (or `--project` target); `on` resumes it.

`--provider llama-cpp|mlx|ds4` picks the engine for the model commands
(default: this platform's on-device engine), and all three accept `--json`.

## Craftbooks from the command line

A craftbook is a recipe for a piece of work that gezels carry out as a task.
`gezel craftbook list` shows the ones you can start in the current folder's
project, and `gezel craftbook list deck` narrows the list by command, title,
and tags.

`gezel do` takes the craftbook, then its values. A bare value fills the next
required parameter, in the order the craftbook lists them. `key=value` and
repeatable `--param key=value` set any parameter, including ones the app's
launch forms hide. Every other word is your request: it becomes the task
description and, when the craftbook takes one, its main content. Quoting is
optional.

Any craftbook also runs by name, so `gezel summarize-long "…"` is
`gezel do summarize-long "…"`. The name must match the craftbook's command
name (its id, unless it declares one) exactly, and built-in commands always
win. A mistyped name reports an unknown command without creating a project.

```bash
gezel do summarize-long "Summarize notes.txt for the board"
gezel summarize-long "Summarize notes.txt for the board"
gezel do powerpoint-deck "A deck about Delft" audience=investors --wait --json
gezel task wait my-project/12 --timeout 7200 --json
gezel task resume my-project/12 --json
gezel task notes my-project/12 --warnings --json
```

Only the values you give are sent; the service fills in the defaults after it
creates the task. Waiting exits with 0 when the task completes, 1 when it is
canceled, 2 when it is paused or waiting for your answer, and 3 on timeout. A
timeout leaves the task running. When a task is blocked, `--wait` prints why
(its latest note) and points to `gezel task notes <ref>`. Progress goes to
stderr; `--json` writes the result to stdout. `resume` retries a paused task
with its saved recipe. Answer pending questions in Gezel before waiting again.

### Repository workflows

For scripted orchestration around several craftbooks, add a module under
`.gezel/workflows/`, for example `.gezel/workflows/quarterly-reports.mjs`:

```js
export async function run({ args, log, runCraftbook }) {
  const results = [];
  for (const region of args) {
    log(`Writing the ${region} report`);
    results.push(await runCraftbook('region-report', { region }));
  }
  return results;
}
```

Run it with `gezel workflow quarterly-reports north south --json`, or give a
module path: `gezel workflow ./pipeline/quarterly-reports.mjs north`. The
module receives the public `GezelClient` (`client`), the folder's project id
(`projectId`), its absolute `workspace`, your `args`, a stderr `log`, and:

- `runCraftbook(id, params, options)` starts a **project** craftbook (one under
  `.gezel/craftbooks/`) and waits for it. Options include `timeoutMs`, a saved
  `taskRef` to follow, `parentTaskRef` to link the child to its batch, and
  `onCreated(task)` to checkpoint the new reference. It checks the craftbook's
  declared needs first (see below).
- `complete(request)` makes one bounded model call on the project's engine
  queue, for judgment on input the module already holds. No tools, session, or
  transcript are involved; the module validates the answer and saves what it
  keeps.
- `validateCraftbook(document)` checks a generated craftbook against the same
  schema and step rules as the service before you install it.
- `ensureSetup({ services, models })` asks for setup the module decides on at
  run time, the same way `gezel do` does.

```js
const { json } = await complete({
  gezelId: 'checker',          // or provider + model
  system: 'You are a meticulous fact-checker.',
  prompt: `FACTS:\n${facts}\n\nSENTENCES:\n${sentences}`,
  jsonSchema: verdictSchema,   // grammar-constrained on local engines
  thinking: false,             // skip a local model's reasoning phase
  maxTokens: 4000,
  timeoutMs: 300_000,
  label: 'fact-check, paragraph 3',
});
```

`complete` returns `{ content, json?, jsonError?, elapsedMs }`. Returning an
object with `exitCode` from `run` sets the shell exit status.

To expose a workflow as a craftbook command, add
`"cliWorkflow": { "module": ".gezel/workflows/quarterly-reports.mjs" }` to a
project craftbook and declare its inputs in `paramSchema`, listing the ones a
bare value should fill under `required`. Then `gezel do quarterly-reports north
--json` runs it, and the module also receives `craftbook` and the validated
`params`. A workflow craftbook takes no request text, and the module owns
creating the parent task, defaults, checkpoints, and how many children run at
once. Modules must live inside the project workspace; `--strict-sandbox`
refuses them.

Workflows run in the foreground even without `--wait`, so keep the terminal
open. A timeout applies to each child wait. If the CLI exits, tasks already
created keep running, but the rest of the workflow needs to be run again;
`gezel task wait` follows a parent and its children but does not restart a
workflow.

### Declaring what a craftbook needs

A craftbook can declare the chat models it runs on and the capabilities it
cannot run without. `gezel do` checks them before anything starts:

```json
"services": [{ "kind": "web-search", "reason": "research checks every fact" }],
"models": [
  { "id": "qwen3.8-27b-q4", "reason": "writes the report" },
  { "id": "{{checkerModel}}", "provider": "llama-cpp", "reason": "checks every sentence" }
]
```

`web-search` means a keyed search provider (Brave); Wikipedia does not count.
It implies `external-services`, which a craftbook that only fetches pages can
declare on its own. A model `id` (or `provider`) may be a `{{param}}`
reference, filled from the run's value or its default; one that resolves to
nothing is skipped. `provider` defaults to this computer's on-device engine.

At a terminal, each missing piece is one question: turn on outside services
(naming the security level that moves to), paste a Brave Search API key
(hidden, then proven with one test search), and download the models (after a
disk-space check, with the engine if it is missing). Any "no", or a run without
a terminal, stops before the run starts and prints the commands that fix it:

```text
gezel security external-services on
gezel secret set braveSearchApiKey --env BRAVE_SEARCH_API_KEY --use-for-search
gezel model pull qwen3.8-27b-q4 --provider llama-cpp
```

### Project craftbooks and their scripts

Project craftbooks live in `.gezel/craftbooks/<id>/manifest.json` (identity)
and `versions/<version>/craftbook.json` (the complete recipe, including its
scripts). Changing a recipe affects new tasks; running tasks keep their copy.

A launch from the CLI, including `/do` in the interactive app, trusts the exact
script contents in that task's copy of the recipe. Edited scripts do not
inherit that trust, and a model can never grant it. On platforms without an
enforceable operating-system network boundary, such as Windows, those scripts
run with best-effort network isolation; `gezel do … --strict-sandbox` requires
the operating-system boundary instead. Declared capabilities and project and
security policies still apply. Workflow modules themselves run as ordinary
local Node code with your permissions, like an npm script.

## What works with no further setup

The CLI does not bundle model weights or native inference engines; those
download only when you choose on-device models. Straight away you can use:

- The interactive app (`gezel`), which walks you through choosing a model on
  first use, and one-shot prompts (`gezel run "…"`) once a model is set up.
- Cloud providers: OpenAI, Anthropic, GitHub Copilot, and any OpenAI-compatible
  endpoint.
- Your gezels, projects, and tasks (`gezel agent`, `gezel project`,
  `gezel task`).
- `gezel skills convert` and `gezel handboek export`, which need no running
  service at all.
- Knowledge catalogs you already have: `gezel knowledge validate`, `inspect`,
  and full-text `search` work offline, with no service.

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
native engines (llama.cpp, stable-diffusion.cpp, whisper.cpp, uv). They are far
too large for an npm package (the CUDA build alone is over 700 MB), so they
download once, when you ask:

```bash
gezel native install                 # this platform's default backend
gezel native install --variant cuda  # or cpu / vulkan / metal
gezel native status
```

Downloads come from the `native-v*` releases on
[GitHub](https://github.com/bendyline/gezel/releases/) and are verified before
use. Each CLI release pins one exact native release, and every archive's
SHA-256 is compiled into the package. Gezel's own Windows binaries must also
carry Bendyline's Authenticode signature and its macOS binaries the expected
Developer ID; Linux binaries are checked against the compiled hashes. Nothing
is fetched until you ask for it.

## How the CLI finds Gezel

With no connection flags, the CLI uses your own per-user Gezel service. It
finds it through `~/.gezel/runtime` (its port and pinned TLS certificate) and
connects as you, so there is no approval prompt and no need for the desktop
app.

- Management commands start that service when it is not running and say so on
  stderr. It keeps running afterward, until `gezel stop`, and logs to
  `~/.gezel/logs/service-YYYY-MM-DD.log` (rolled at 10 MB, kept 7 days).
- Read-only diagnostics such as `gezel native status` never leave a service
  behind.
- The interactive app shuts down a service it started when you exit.
- `gezel run` with no service running starts one for that prompt and stops it
  afterward. It does not do that when a running service is unhealthy.

A service the CLI starts listens on port 6228 when it is free, so other apps
get a stable OpenAI-compatible address (`https://127.0.0.1:6228/v1`), and on a
free port otherwise; `--port` pins one. When the desktop app has installed its
machine-wide service, that service owns 6228. A current machine-wide service
only runs models: the CLI never sends it projects, keys, or tools, and your own
service uses it for model downloads and inference. While you upgrade from an
older desktop release, an older machine-wide service that still holds your
gezels and projects is used instead; `--standalone` skips it.

Your own service may reuse two things the desktop app's machine install
publishes, read-only: its downloaded models (your own models take precedence,
and a shared model is re-hashed before its first use), and its native engines
when they match the CLI's pinned release file for file and pass the signature
checks. Anything else is downloaded into your own home. The CLI never reads the
machine service's private data.

The connection flags are:

```bash
gezel --connect https://host:6228                  # another Gezel; approve on first use
gezel --connect https://host:6228 --token "$TOKEN"
gezel --standalone                                 # skip an older machine-wide service
gezel --home /path/to/another-home                 # a separate Gezel home
```

`--connect` needs a CLI grant from that Gezel. Without a saved grant or
`--token`, the terminal shows a six-character code and waits for you to approve
**Gezel CLI** in that Gezel app. The revocable credential is saved under
`~/.gezel/cli/tokens/`. `gezel stop` cannot shut down a service you reach with
`--connect`; `gezel stop --keep-running` stops its AI work.

`--home <dir>` (or an explicit `GEZEL_HOME`) implies `--standalone`. A home you
name with `--home` is also kept separate from what the Gezel desktop app's
machine install publishes: its shared gezels and projects, and the models it
downloaded. Set `GEZEL_DISABLE_MACHINE_SHARED=0` to include them anyway. Your
default home, `~/.gezel`, still sees them.

## Stability

The supported public surface of this package is its **command line**: the
commands, their flags, and their output. It ships no JavaScript API; importing
from it is unsupported, and its internal modules can change in any release.

Breaking changes to commands or flags follow semver.

## Documentation

- [Repository and full documentation](https://github.com/bendyline/gezel)
- [The gezel command line](https://github.com/bendyline/gezel/blob/main/docs/handboek/technical/cli-reference.md)
  in the Handboek

MIT © Bendyline

---
id: cli-reference
title: The gezel command line
order: 7
summary: Headless gezel — start the service, run one-shot work, export docs.
subcategory:
  id: gezel-command-line
  title: The Gezel Command Line
  order: 2
---

# The gezel command line

The `gezel` command drives the same service the desktop app uses — handy on servers, in scripts, or when you just live in a terminal.

Install the command-line package with Node.js 24 or newer:

```bash
npm install @bendyline/gezel-cli
npx gezel
```

The CLI is one of Gezel's public JavaScript packages. See [Gezel on npm](npm-packages.md) for the complete package map and the SDKs to use when a shell command is not the right integration boundary.

## Local use and external connections

The npm package is sufficient for local CLI use, including first use. The CLI discovers your per-user daemon through its runtime files and pinned TLS certificate, then connects with your same-user owner credential. You do not need to install or open the desktop app or approve a connection to your own local daemon.

Management commands can start your user daemon when it is absent; it keeps running until you use `gezel stop --daemon`. The interactive terminal app shuts down a daemon it started when you exit. `gezel run` adopts an already-running user daemon, or starts a service in-process for that one invocation and stops it afterward. An unhealthy running daemon remains an error.

An explicit `--connect <url>` uses a separate CLI-scoped grant for that service. Without a valid saved grant or supplied `--token`, the terminal displays a six-character code and waits for you to approve Gezel CLI in the Gezel app. The resulting revocable credential is saved under `~/.gezel/cli/tokens/`. A valid saved grant or `--connect <url> --token <token>` lets you connect without that interaction.

Rolling-upgrade compatibility may also select an older `legacy-full` machine service, which uses that approval path. Use `--standalone` to skip this compatibility choice; `--home <path>` or an explicit `GEZEL_HOME` also implies standalone operation. A modern machine service is an engine broker; your per-user daemon handles product data and connects to that broker for inference.

## Everyday commands

```
gezel                       open the interactive terminal app for this folder's project
gezel start                 ensure the service is running
gezel start --port 8080 --foreground
                            run it attached, on a fixed port
gezel start --web --open    serve the web interface on this computer and open
                            it in your browser
gezel status                is it up, and where (exits 1 if not running or unhealthy)
gezel stop                  emergency stop: cancel AI work, unload engines,
                            switch to Reactive — the service keeps running
gezel stop --daemon         shut the service down
gezel mode [mode]           show or set how active the AI may be
                            (read-only, reactive, reactive+tasks, full-play)
gezel run "..."             one-shot: send a prompt, print the reply
gezel doctor                check the installation
```

## Which project a command uses

`gezel`, `gezel run`, `gezel do`, and the other project commands work in the project for the folder you run them from, and create it the first time. Pass `--project <folder>` to use another folder without changing directory.

Gezel never makes a project of your home folder, the temp folder, or the top of a drive. Run a command from one of those and it uses the Default project instead, with a note saying so. Naming one of those folders with `--project` stops the command, so it never quietly uses a different project than the one you asked for.

## Working with the crew

```
gezel agent list            your gezellen
gezel project list          your projects (gezel env is the same command)
gezel task list             tasks across every project (--status to filter)
gezel task show <ref>       one task, such as default/12
gezel task pause <ref>      pause one task without stopping the others
gezel task resume <ref>     retry a paused task and wait for its result
gezel do <craftbook>        start a craftbook as a task in this folder's project
                            (--wait to stay until it finishes)
gezel skills list           SKILL.md skills found in this project's workspace
gezel skills import <path>  turn one of those skills into a craftbook
```

## AI Apps

```
gezel app new my-app        scaffold an app source folder
gezel app validate my-app   check a source folder or .gezapp (--json for tooling)
gezel app pack my-app       produce my-app-1.0.0.gezapp
gezel app add <file> --yes  review and install a package
gezel app apply my-app      outfit the current folder as a project
gezel app serve my-app      share its page as a mini-site
```

The full story — the source-folder format, both script forms, and the loop an AI agent can drive — is [Building AI Apps inside Gezel](building-ai-apps-inside-gezel.md).

## Models and engines

```
gezel model list            local chat models for this computer's engine
gezel model pull <id>       download a chat model from the catalog
gezel model context <id> [tokens]
                            show or set a model's context window (auto clears it)
gezel model concurrency [slots]
                            show or set how many requests a local engine serves at once
gezel model export <id> [file]
                            save a model as a portable .gezmodel file
gezel native install        download and verify the on-device engines
gezel native status         engine release, platform, and backend
gezel image models          local image-generation models (image pull / image rm)
```

## Making media

```
gezel create-image "..."    generate an image with the configured image engine
gezel create-video "..."    generate a video
gezel create-audio "..."    read text aloud into an audio file
```

## Knowledge catalogs

```
gezel knowledge init <dir>  scaffold a catalog folder
gezel knowledge build <dir> compile it into a .gezk file
gezel knowledge search <file> "..."
                            search a catalog file offline
gezel knowledge available   catalogs offered for download
gezel knowledge install <source>
                            install one by catalog id, file, or URL
gezel knowledge list        what is installed
```

Building, checking, and searching a catalog file work without the service; installing and listing use the running gezel. Building a catalog and `search --semantic` also need the embedding runtime, which the desktop app includes. After an npm install, add it with `npm install -g @huggingface/transformers@^3.8.1` (without `-g` if gezel is installed in a project).

## Keys and security settings

```
gezel secret list           which provider keys are set (never their values)
gezel secret set <name> --env VARIABLE
                            store a key, read from an environment variable
                            (or --stdin to pipe it in)
gezel secret remove <name>  forget a key
gezel security external-services [on|off]
                            let gezels use web search and other outside services
gezel env indexing [on|off] pause or resume background indexing for this project
```

## Space, backups, and restoring

```
gezel cleanup               see how much space gezel is using
gezel cleanup --redownloadable
                            reclaim everything gezel can download again
gezel backup <file>         write your gezels, projects, and documents to a file
gezel restore <file>        bring them back (--list to look first)
```

## This documentation

```
gezel handboek export --out ./site
```

renders the Handboek — the same articles you're reading now — as a static website, for publishing or offline reading.

Run `gezel --help` (or `--help` on any subcommand) for the full surface.

To automate work *inside* a project, continue with [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md). To let another application use Gezel, see [Building connected apps with gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md).

## Watching tasks

A task watch is an observer. Its timeout ends the command without canceling or pausing native work; watching the same task again follows that work. A task's current paused status or an unanswered question blocks the watch. Historical service pause cards do not block an already resumed task and are not answered by the observer.

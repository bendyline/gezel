---
id: cli-reference
title: The gezel command line
order: 7
summary: Headless Gezel — start the service, run one-shot work, export docs.
subcategory:
  id: gezel-command-line
  title: The Gezel Command Line
  order: 2
---

# The gezel command line

The `gezel` command drives the same service the desktop app uses — handy on servers, in scripts, or when you just live in a terminal.

The command line needs Node.js 24 or newer. Check with `node --version`; if it is older or missing, one line installs a current version:

- macOS: `brew install node`
- Windows: `winget install OpenJS.NodeJS.LTS`
- Ubuntu or Debian: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`
- Anywhere, with [nvm](https://github.com/nvm-sh/nvm): `nvm install 24`

To try Gezel without installing anything else, run:

```bash
npx gezel-cli
```

To keep it installed:

```bash
npm install -g gezel-cli
gezel
```

The `gezel-cli` package is the short name for `@bendyline/gezel-cli`, and the two are the same program. If you installed `@bendyline/gezel-cli` before, keep using it, or remove it with `npm uninstall -g @bendyline/gezel-cli` before you install `gezel-cli`. They both provide the `gezel` command, and npm will not install a second one over the first.

The CLI is one of Gezel's public JavaScript packages. See [Gezel on npm](npm-packages.md) for the complete package map and the SDKs to use when a shell command is not the right integration boundary.

## Local use and external connections

The npm package is sufficient for local CLI use, including first use. The CLI discovers your per-user daemon through its runtime files and pinned TLS certificate, then connects with your same-user owner credential. You do not need to install or open the desktop app or approve a connection to your own local daemon.

Management commands can start your user daemon when it is absent; it keeps running until you use `gezel stop`. The interactive terminal app shuts down a daemon it started when you exit. `gezel run` adopts an already-running user daemon, or starts a service in-process for that one invocation and stops it afterward. An unhealthy running daemon remains an error.

An explicit `--connect <url>` uses a separate CLI-scoped grant for that service. Without a valid saved grant or supplied `--token`, the terminal displays a six-character code and waits for you to approve Gezel CLI in the Gezel app. The resulting revocable credential is saved under `~/.gezel/cli/tokens/`. A valid saved grant or `--connect <url> --token <token>` lets you connect without that interaction.

Rolling-upgrade compatibility may also select an older `legacy-full` machine service, which uses that approval path. Use `--standalone` to skip this compatibility choice; `--home <path>` or an explicit `GEZEL_HOME` also implies standalone operation. A modern machine service is an engine broker; your per-user daemon handles product data and connects to that broker for inference.

A home you name with `--home` is also kept separate from what the Gezel desktop app's machine install publishes: its shared gezels and projects, and the models it downloaded. Set `GEZEL_DISABLE_MACHINE_SHARED=0` to include them anyway. Your default home, `~/.gezel`, still sees them.

To run Gezel headless on a machine of its own, see [Gezel on a server](gezel-on-a-server.md).

## Everyday commands

```
gezel                       open the interactive terminal app for this folder's project
gezel start                 ensure the service is running
gezel start --port 8080 --foreground
                            run it attached, on a fixed port
gezel start --web --open    serve the web interface on this computer and open
                            it in your browser; the printed link signs you in
                            until the service restarts
gezel start --web --accounts
                            the same, but people sign in with a name and
                            password; the first run prints a link to create one
gezel status                is it up, and where (exits 1 if not running or unhealthy)
gezel stop                  cancel any AI work and shut the service down
gezel stop --keep-running   emergency brake: cancel AI work, unload engines,
                            switch to Reactive — the service keeps running
gezel mode [mode]           show or set how active the AI may be
                            (read-only, reactive, reactive+tasks, full-play)
gezel growth [on|off]       show or set gezel growth (XP and level-ups); off
                            computes no XP, for homes that run bulk workflows
gezel run "..."             one-shot: send a prompt, print the reply
gezel doctor                check the installation
```

The first time you use Gezel on a computer, it has no model to answer with. `gezel` and `gezel run` then show the same setup: they suggest a model that fits this computer, download it with your OK, and carry on. `gezel run` goes straight on to your prompt afterward. When `gezel run` is not in a terminal, for example in a script or with its prompt piped in, it prints the setup commands instead and downloads nothing.

A new install starts in `full-play`. For a server nobody is watching, `reactive+tasks` is the better fit: messages, tasks you start and schedules still run, without proactive nudges. [Gezel on a server](gezel-on-a-server.md) covers the rest of a headless setup.

If the desktop app's machine-wide service is in use, `gezel stop` applies the emergency brake to it instead and says the service is managed by the operating system. It does the same for a service the Gezel app started for you, which the app would only start again: quit the app to shut that one down. `gezel stop` shuts a service down only after confirming the process is Gezel's. When the service has already exited, it removes the files the service left behind, and it never stops another program that happens to have reused the service's old process number. `gezel stop --daemon` still works and means the same as `gezel stop`.

## Which project a command uses

`gezel`, `gezel run`, `gezel do`, and the other project commands work in the project for the folder you run them from, and create it the first time. Pass `--project <folder>` to use another folder without changing directory.

Gezel never makes a project of your home folder, the temp folder, or the top of a drive. Run a command from one of those and it uses the Default project instead, with a note saying so. Naming one of those folders with `--project` stops the command, so it never quietly uses a different project than the one you asked for.

## Working with the crew

```
gezel agent list            your gezels
gezel project list          your projects (gezel env is the same command)
gezel task list             tasks across every project (--status to filter)
gezel task show <ref>       one task, such as default/12
gezel task pause <ref>      pause one task without stopping the others
gezel task resume <ref>     retry a paused task and wait for its result
gezel craftbook list [words]
                            craftbooks you can start in this folder's project
                            (words filter by command, title, and tags;
                            --no-start answers from a running service only)
gezel do <craftbook>        start a craftbook as a task in this folder's project
                            (--wait to stay until it finishes; --out <dir> to
                            wait and copy what it made into that folder)
gezel skills list           SKILL.md skills found in this project's workspace
gezel skills import <path>  turn one of those skills into a craftbook
```

## Who can reach this Gezel

These matter where people sign in from a browser: a [Gezel container](gezel-in-docker.md), or `gezel start --web --accounts`.

```
gezel account list          the accounts that can sign in
gezel account create <name> add one (asks for a password; --password-stdin to pipe it)
gezel account reset-password <name>
                            set a new password and sign them out everywhere
gezel account disable <name> / enable <name>
gezel account remove <name> --yes
gezel account sessions <name>
                            where an account is signed in
gezel account setup-link    a new link to create the first account
gezel integrations token create <app>
                            a key for another program to use Gezel's models
                            (--scope to give it more than chat; shown once)
gezel integrations token revoke <app>
```

Everyone with an account can do everything, including open a terminal. Add only people you trust with the computer Gezel runs on.

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
                            (--no-start: answer from a running service only)
gezel model list --available
                            catalog models that fit this computer, with sizes and
                            the published scorecard's measured pass rate for each
gezel model pull <id>       download a chat model from the catalog
gezel model use <id>        make chats use a downloaded model
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

## Measuring a model

The same tasks, checks and counting rules as the published
[model scorecard](model-scorecard.md), run on your own computer through the
service's benchmark runner. `gezel bench` and **Settings → Benchmarks** show
the same runs.

```
gezel bench                 run the core set on the model chats use, one trial per task
gezel bench --suite productivity|developer|complex-work|all
                            another set, several, or all four
gezel bench --smoke         the set's pulse check instead (fast; not a suite score)
gezel bench --model <id> --count 3
                            a particular model; three trials is what it takes to quote a rate
gezel bench --json <file>   also write the results as a scorecard shard
gezel bench list            every set, its size, and how long it can take
gezel bench results         finished runs on this computer
gezel bench submit <file>   share a results file as a GitHub issue (uses gh when installed)
```

A run that could take more than an hour asks before it starts; `--yes` skips
the question. Below three trials a result prints as a count, never a rate,
exactly as the scorecard does. The report ends with the run's provenance —
hardware, engine build, gezel version, catalog version — because a number
without those is not a measurement.

## Making media

```
gezel create-image "..."    generate an image with the configured image engine
gezel create-video "..."    generate a video
gezel create-audio "..."    read text aloud into an audio file
```

## Knowledge catalogs

See [Working with knowledge catalogs](knowledge-command-line.md) for the complete reference, including validation, signing, location search, removal, Parquet export, and a build–validate–install walkthrough. [How knowledge works in Gezel](how-knowledge-works.md) explains the embeddings and storage behind these commands.

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

Building, checking, and searching a catalog file work without the service; installing and listing use the running Gezel. Building a catalog and `search --semantic` also need the embedding runtime, which the desktop app includes. After an npm install, add it with `npm install -g @huggingface/transformers@^4.3.1` (without `-g` if the CLI is installed in a project).

## Keys and security settings

```
gezel secret list           which provider keys are set (never their values)
gezel secret set <name> --env VARIABLE
                            store a key, read from an environment variable
                            (or --stdin to pipe it in)
gezel secret remove <name>  forget a key
gezel security level        the security level and what it allows
gezel security level set <super-lockdown|lockdown|free>
                            switch to a preset (free is Unrestricted in Settings)
gezel security external-services [on|off]
                            let gezels use web search and other outside services
gezel env indexing [on|off] pause or resume background indexing for this project
```

## Space, backups, and restoring

```
gezel cleanup               see how much space Gezel is using
gezel cleanup --redownloadable
                            reclaim everything Gezel can download again
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

When a task you wait for is blocked, `gezel do --wait` prints why (the task's latest note) and points to `gezel task notes <ref>`, which shows the full notes.

A task watch is an observer. Its timeout ends the command without canceling or pausing native work; watching the same task again follows that work. A task's current paused status or an unanswered question blocks the watch. Historical service pause cards do not block an already resumed task and are not answered by the observer.

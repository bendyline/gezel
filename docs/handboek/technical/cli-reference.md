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
npm install -g @bendyline/gezel-cli
gezel
```

The CLI is one of Gezel's public JavaScript packages. See [Gezel on npm](npm-packages.md) for the complete package map and the SDKs to use when a shell command is not the right integration boundary.

## Everyday commands

```
gezel start                 ensure the service is running
gezel start --port 8080 --foreground
                            run it attached, on a fixed port
gezel status                is it up, and where
gezel stop                  stop it
gezel run "..."             one-shot: send a prompt, print the reply
```

## Working with the crew

```
gezel agent list            your gezellen
gezel task list             tasks in flight
gezel env skills list       importable skills
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

## This documentation

```
gezel handboek export --out ./site
```

renders the Handboek — the same articles you're reading now — as a static website, for publishing or offline reading.

Run `gezel --help` (or `--help` on any subcommand) for the full surface.

To automate work *inside* a project, continue with [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md). To let another application use Gezel, see [Building connected apps with gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md).

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

## What you get with no further setup

The install is pure JavaScript. Straight away you can use:

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
verified before use: the release's `SHA256SUMS` file is checked against a
digest baked into this package at publish time, and every archive is then
checked against its line in that file. A tampered release cannot swap a
binary. Nothing is fetched until you ask for it.

## Commands

Run `gezel --help` for the full list. The most-used ones:

| Command | What it does |
|---|---|
| `gezel` | Launch the interactive TUI |
| `gezel run [prompt…]` | One-shot prompt, optionally `--gezel <id>` |
| `gezel start` / `stop` / `status` | Manage the background daemon (`--web` serves the browser UI) |
| `gezel doctor` | Report on the local install |
| `gezel agent list\|create\|show` | Manage your gezels |
| `gezel env list\|create\|install` | Manage projects and their packages |
| `gezel task list\|create\|show` | Manage tasks |
| `gezel model list\|pull` | Manage on-device chat models |
| `gezel native install\|list\|status` | Manage native engine binaries |
| `gezel create-image\|create-video\|create-audio` | Generate media |
| `gezel skills import\|convert` | Import and convert skills |
| `gezel handboek export --out <dir>` | Export the handbook |

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

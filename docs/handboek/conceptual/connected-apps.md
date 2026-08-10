---
id: connected-apps
title: "Connected apps: let other tools use your gezels"
order: 9
summary: Editors and other programs can talk to your crew through standard AI endpoints — with your approval, on your terms.
---

# Connected apps

Gezel isn't only a place you visit — it can also serve your models and gezellen to *other* programs on your computer. A code editor, a writing tool, or a browser extension that knows how to talk to an AI service can talk to gezel instead, and get your local models with all of gezel's know-how applied.

Everything described here lives in **Settings → Connected Apps**.

## How an app connects

Apps speak to gezel using the same "OpenAI-style" language most AI tools already know. Two things make it work:

1. **An address.** The address panel in **Settings → Connected Apps** shows where gezel is listening on your machine. On most personal installs that is `https://127.0.0.1:6228/v1`; when the Gezel machine service is installed, the app API moves to a per-launch port (shown in the panel) because the machine service holds 6228. For apps that need an address that never changes, turn on **Ollama emulation** — it always answers at `http://127.0.0.1:11434`.
2. **Permission.** The first time an app asks for access, gezel shows you an approval request — who is asking, and for what. Nothing gets through until you approve, and you can revoke any app later from the same panel.

## Codex and other agent harnesses

The authenticated address also serves the OpenAI **Responses API** at `/v1/responses`. That lets a harness such as Codex keep ownership of its coding tools, sandbox, approvals, and conversation loop while a model installed in gezel supplies the inference.

For Codex, use **Use Gezel models in Codex** in this Settings screen. Gezel creates an isolated `gezel-local` Codex profile, a model catalog, and a dedicated revocable credential. It does not edit Codex's main configuration, authentication, conversations, sandbox rules, or approval settings. Start Codex with the command shown on the card (`codex --profile gezel-local`).

Keep Gezel running while Codex uses the local model. If you want the model bridge available without keeping the desktop window open, turn on Gezel's daemon autostart setting.

The managed profile talks to a narrow, authenticated loopback bridge. Operationally it provides the stable address that an Ollama-style integration needs, but it keeps bearer authentication: only the Responses and model-discovery routes are present, and the credential grants no access to Gezel projects, files, terminals, or settings. The token is read by Codex through a command-backed provider credential rather than copied into a project or shell profile. Revoking the Codex entry under Connected Apps immediately stops it from using the bridge.

One-click setup is available only when the desktop and the Gezel service are on the same computer. In remote-service mode the card stays read-only, because writing a profile on the service host would not configure Codex on the computer in front of you.

Codex custom providers use `wire_api = "responses"`. The managed profile also sets the top-level `web_search = "disabled"`: Codex otherwise advertises a provider-hosted search tool that a local inference server cannot truthfully execute. Do not combine the Gezel profile with Codex's `--search` flag, which explicitly turns that hosted tool back on. Ordinary Codex tools such as shell commands, patching, and helper-agent namespaces remain available because Codex executes those itself.

The setup card offers only installed inference models that can participate in Codex's caller-executed tool loop. The facade does not silently route unknown aliases through the fallback gezel, and it refuses `codex-cli:` / `anthropic-cli:` targets because those are full nested agent harnesses rather than inference providers.

## Who answers: gezel choices and the fallback

Gezel presents your crew to connected apps as model choices, including each gezel's name and role. When an app chooses one, that gezel answers with their character, model, and settings.

Some apps cannot choose from that list and ask for a hardcoded model such as `gpt-4o`. The **fallback gezel** answers those requests. It defaults to your Meester, so there is always a useful front door; you can choose another gezel from **Settings → Connected Apps**.

## Supporting behaviors

Gezel knows how to get the best out of each model — catching runaway rambling, tidying leaked reasoning, applying model-specific fixes. The **Supporting behaviors** switch controls whether connected apps get that help too. On (the default) is recommended; off gives plain serving with just the model's tuned settings.

## Emulating Ollama

Some tools don't ask where your AI lives — they simply look for [Ollama](https://ollama.com) on its standard port. The **Emulate Ollama** switch makes gezel answer there, so those tools discover your crew with zero setup.

One honest caveat, spelled out next to the switch: Ollama's convention is no password. While emulation is on, any program on this computer can use your models without asking first. Gezel keeps this off unless you turn it on, only ever answers your own machine, and refuses to take the port if the real Ollama is already running.

## Keeping an eye on things

Every chat an app completes through these endpoints is recorded in the **History** tab (look for "App chat" entries), and the tokens they consume count in the **Usage** view — so you can always see who has been using your models, and how much.

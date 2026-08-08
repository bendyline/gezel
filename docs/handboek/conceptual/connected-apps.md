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

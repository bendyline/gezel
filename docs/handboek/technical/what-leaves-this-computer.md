---
id: what-leaves-this-computer
title: "What leaves this computer"
order: 5.5
summary: Every kind of network traffic Gezel can make, and which security level allows it.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# What leaves this computer

Gezel has no Bendyline account and no Bendyline server between you and your work. Your projects, chats and files stay on this machine unless something on this page sends them somewhere. Below is every kind of traffic Gezel can make, what it carries, and which of the three security levels allows it.

You choose the level in **Settings → Security & compliance**, or with `gezel security level set <level>` on the command line. A new install starts at `lockdown`.

## The table

| Traffic | What it carries | `super-lockdown` | `lockdown` | `free` |
| --- | --- | --- | --- | --- |
| Local models (llama.cpp, MLX, DwarfStar, Ollama) | Nothing leaves; the model runs on this machine | Allowed | Allowed | Allowed |
| Cloud model providers (API keys, Claude and Codex command-line tools, Copilot) | Your conversation, and any files Gezel reads in it, to the provider you chose | **Blocked** | Allowed | Allowed |
| Web search, page fetches and Wikipedia lookups | What Gezel searches for or the address it opens | **Blocked** | **Blocked** | Allowed |
| Mail sync and sending | Your mailbox, to and from your mail provider | **Blocked** | **Blocked** | Allowed |
| Connectors (mail, calendars, issue trackers and similar) | The connected account's data, copied into the project | **Blocked**: no data moves | When you start a sync | Also syncs in the background |
| Third-party toolsets (community MCP servers) | Whatever that toolset sends; it is outside code Gezel cannot confine | **Blocked** | **Blocked** | Allowed |
| Package scripts Gezel runs (`npm run`, `npx`) | Whatever the script sends; package scripts run with network access | **Blocked** | **Blocked** | Allowed |
| Automatic update checks (the app, and live catalog updates if you turn them on) | Version checks to Gezel's GitHub releases and to npm | **Blocked** | Allowed | Allowed |
| Downloads you start: models, on-device engines, knowledge catalogs | Requests for those files, from Hugging Face and Gezel's GitHub releases | Allowed | Allowed | Allowed |
| First-start tool setup | Downloads of the browser-automation tools from npm and Playwright | Allowed | Allowed | Allowed |

The levels are presets. **Settings → Security & compliance** can turn individual switches on or off; a combination that matches no preset is shown as **Custom**.

## What the rows mean

**Local models** never send your words anywhere. A downloaded model runs in an engine on this machine, and Gezel treats Ollama, which you run yourself, the same way.

**Cloud model providers** receive what you would send them using their own product, under their terms. Gezel talks to them directly from this machine and adds no middleman. At `super-lockdown`, the service refuses to start a cloud chat at all, whichever path asks for one.

**Web search and page fetches** carry what Gezel is researching. They are the main reason `lockdown` and `free` differ: a model that can reach the open web can be steered by what it reads there, so this is off by default.

**Connectors** are run by the service, not the model. The service holds the credential, fetches the data and writes it into the project as files Gezel reads. At `lockdown` they move data only when you ask; at `free` they also keep themselves in sync.

**Third-party toolsets and package scripts** are code Gezel did not write and cannot sandbox, so they may reach the network whatever they like. They are available at `free` only. (One narrow exception: Gezel's own local preview browser may run at lower levels, locked to pages inside your project.)

**Update checks** carry a version number, not your work. You can also turn off automatic update checks on their own, without changing the level.

**Downloads you start** fetch files; they do not upload your work. Model files are checked against their published hashes, and the on-device engines against fingerprints built into the release you installed.

## What the levels do not change

- **Nothing goes to Bendyline.** No level sends your chats, files or usage to us. The Bendyline-published places Gezel contacts are its GitHub releases and its npm packages, for updates, engines and tools.
- **Keys go only to their own service.** A provider key is sent to that provider and nowhere else. Gezel keeps keys in your operating system's keychain, or in an encrypted file in its own folder where no keychain exists.
- **The service answers only on this machine.** It listens on this computer alone unless you pair another device to it for remote inference.

[Local-first: your data stays on your disk](../conceptual/privacy-local-first.md) covers the same ground in plainer terms, and [The security model](security-model.md) explains how each level is enforced.

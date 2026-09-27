---
id: privacy-local-first
title: "Local-first: your data stays on your disk"
order: 8
summary: No gezel cloud, no hidden database — files you can open and back up.
---

# Local-first: your data stays on your disk

Gezel is built on one stubborn idea: **your work belongs to you, on your machine, in files you can read.**

## What that means in practice

- **No gezel account.** There is no sign-up and no gezel server holding your chats, and your conversations and files are never sent to us. When you use a cloud AI provider, the app talks directly from your computer to that provider.
- **Files all the way down.** Gezels, their characters, their memories, your projects, your chat history — all ordinary files in one folder. Back it up, sync it, move it to a new machine, grep it. The [Where files live](../technical/where-files-live.md) article gives the map.
- **Local models keep your words local.** Run a model on your own hardware and your prompts, and its answers, never leave the machine.

## What does leave your machine

When you use a cloud provider, the text of your conversation (and any files a gezel reads for you in that conversation) goes to that provider to generate the response — the same as using their product directly, under their terms. You choose the provider; gezel adds no middleman of its own.

Gezel also uses the internet for a few ordinary jobs:

- **Downloads you start.** Models you choose to install (usually from Hugging Face), the on-device engines that run them (from gezel's own releases on GitHub, checked against pinned fingerprints), and knowledge catalogs you add.
- **Tools it sets up.** On first start gezel installs its browser-automation tools, fetching Playwright from npm and a Chromium browser through Playwright's own installer. Other tools you or a gezel install also come from npm.
- **Updates.** The desktop app checks gezel's GitHub releases for new versions; you can turn automatic checks off. Live catalog updates, if you switch them on, check npm about once a day.
- **Web search, when you allow it.** Gezels can search and fetch web pages only once outside services are turned on in **Settings → Security**. What a gezel searches for then goes to that search service: Wikipedia by default, or Brave if you add a Brave Search key.

Apart from web searches, none of these carry your conversations or files. The strictest level in **Settings → Security** also turns off update checks.

## Credentials

Keys you give gezel for a provider are kept in your operating system's keychain — Keychain on macOS, Credential Manager on Windows, the Secret Service on Linux — and sent only to that provider. Where no keychain is available, such as on a headless server, gezel keeps them in an encrypted file inside its own folder, protected by your account's file permissions; in that case, keep the folder out of cloud sync. The background service on your machine is protected by a token that rotates every start, so other software on the computer can't quietly borrow your crew.

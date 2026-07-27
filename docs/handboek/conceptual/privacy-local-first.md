---
id: privacy-local-first
title: "Local-first: your data stays on your disk"
order: 8
summary: No gezel cloud, no hidden database — files you can open and back up.
---

# Local-first: your data stays on your disk

Gezel is built on one stubborn idea: **your work belongs to you, on your machine, in files you can read.**

## What that means in practice

- **No gezel account.** There is no sign-up, no gezel server holding your chats. The app talks directly from your computer to the AI provider you configured — and to no one else.
- **Files all the way down.** Gezels, their characters, their memories, your projects, your chat history — all ordinary files in one folder. Back it up, sync it, move it to a new machine, grep it. The [Where files live](../technical/where-files-live.md) article gives the map.
- **Local models mean local everything.** Run a model on your own hardware and your words never leave the machine at all — no provider, no network, no exceptions.

## What does leave your machine

When you use a cloud provider, the text of your conversation (and any files a gezel reads for you in that conversation) goes to that provider to generate the response — the same as using their product directly, under their terms. You choose the provider; gezel adds no middleman of its own.

## Credentials

Provider keys are stored in gezel's config file on your disk and sent only to that provider. The background service on your machine is protected by a token that rotates every start, so other software on the computer can't quietly borrow your crew.

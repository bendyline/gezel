---
id: providers-and-engines
title: Providers and engines
order: 3
summary: Working with cloud models through the Claude and Codex CLIs, local engines, and how credentials are handled.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# Providers and engines

A **provider** is where a gezel's intelligence comes from. Gezel supports both kinds:

## Cloud providers

The first-class way to reach cloud models is through a coding CLI you already have installed and signed in:

- **Claude CLI** — if Anthropic's `claude` command (Claude Code) is on your machine, gezel finds it automatically and drives it directly. Your existing login carries over — a Claude subscription works as-is, with no API key to manage. Gezel wires its own tools (memories, tasks, team management, documents, history) into each conversation, so your gezels keep their full craft while Claude does the thinking.
- **Codex CLI** — same idea for OpenAI's `codex` command. Whatever the CLI is signed in with (a ChatGPT account via `codex login`, or an API key in your environment) is what gezel uses.

This interop is the recommended path because the account you already pay for keeps working, the CLIs bring their own strong agentic loop, and there's no separate credential to create or store. Settings shows whether each CLI was detected, and you can point gezel at a specific binary if it lives somewhere unusual.

Two more cloud options:

- **GitHub Copilot** — sign in with your GitHub account from Settings; your Copilot plan's quota applies and gezel shows the real usage buckets.
- **OpenAI** and **Anthropic** API keys — paste a key; usage is billed by the provider per token.

Cloud models are the strongest option and need no hardware to speak of. The trade is that conversation content goes to that provider to be processed, under their terms.

## Local engines

Gezel bundles and manages native engines that run models directly on your machine — llama.cpp and friends, with Ollama supported too if you already use it. Local means private and free per use; the trade is that model quality depends on what your hardware can lift. The [Models and tiers](../conceptual/local-models-and-tiers.md) article explains how gezel matches local models to roles, and the built-in fitness check ("de proeve") verifies a model actually behaves before your crew relies on it.

## Mixing

Providers are per-gezel, not all-or-nothing. A common setup: a local model for everyday companions, a cloud model for the roles where judgment matters most (reviewer, developer). Set the install default in Settings and override an individual gezel from its detail page.

## Credentials

The CLI providers store no credentials in gezel at all — auth stays with the CLI's own login. For the key-based providers, keys live in gezel's config file on your disk, are sent only to their own provider, and are never proxied through any gezel server — there isn't one.

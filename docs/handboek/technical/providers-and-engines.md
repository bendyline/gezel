---
id: providers-and-engines
title: Providers and engines
order: 3
summary: Cloud providers, local engines, and how credentials are handled.
---

# Providers and engines

A **provider** is where a gezel's intelligence comes from. Gezel supports both kinds:

## Cloud providers

- **GitHub Copilot** — sign in with your GitHub account from Settings; your Copilot plan's quota applies and gezel shows the real usage buckets.
- **OpenAI** and **Anthropic** — paste an API key; usage is billed by the provider.

Cloud models are the strongest option and need no hardware to speak of. The trade is that conversation content goes to that provider to be processed, under their terms.

## Local engines

Gezel bundles and manages native engines that run models directly on your machine — llama.cpp and friends, with Ollama supported too if you already use it. Local means private and free per use; the trade is that model quality depends on what your hardware can lift. The [Models and tiers](../conceptual/local-models-and-tiers.md) article explains how gezel matches local models to roles, and the built-in fitness check ("de proeve") verifies a model actually behaves before your crew relies on it.

## Mixing

Providers are per-gezel, not all-or-nothing. A common setup: a local model for everyday companions, a cloud model for the roles where judgment matters most (reviewer, developer). Set the install default in Settings and override an individual gezel from its detail page.

## Credentials

Keys live in gezel's config file on your disk, are sent only to their own provider, and are never proxied through any gezel server — there isn't one.

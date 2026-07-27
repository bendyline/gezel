---
id: local-models-and-tiers
title: Models, tiers, and what runs on this device
order: 6
summary: Cloud or local, big or small — how gezel matches models to work.
---

# Models, tiers, and what runs on this device

Gezel doesn't come with its own AI — it puts *your* choice of AI to work. That
can be a cloud provider (OpenAI, Anthropic, GitHub Copilot) or a model running
locally on your own machine. With a local model, your data never leaves the
room.

## Tiers: matching the model to the job

Models come in sizes, and size matters for what a gezel can be trusted to do
alone. Gezel groups them into **tiers**:

| Tier | Size (in billions of parameters) | Good at |
| --- | --- | --- |
| tiny | under 5B | quick drafts, simple lookups |
| small | 5–12B | everyday chat, focused single tasks |
| medium | 12–45B | multi-step work with tools |
| large | 45B and up, local | most roles, unsupervised steps |
| cloud | hosted frontier models | everything |

Every role declares a **model floor** — the minimum tier it needs to work
unsupervised. A reviewer gating your deliverables needs more headroom than a
gezel drafting a shopping list, and gezel enforces that automatically.

## On this device

::handboek-device-hardware

### Installed local models

::handboek-installed-models

## Choosing

You don't have to get this right up front. Set a default provider in Settings,
and override it per gezel only when a companion needs something different — a
big cloud model for your reviewer, a fast local one for day-to-day chat. Gezel
checks each new model's fitness on your hardware before recommending it.

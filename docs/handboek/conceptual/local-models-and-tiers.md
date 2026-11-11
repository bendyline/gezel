---
id: local-models-and-tiers
title: Models, tiers, and what runs on this device
order: 6
summary: Cloud or local, big or small — how gezel matches models to work.
---

# Models, tiers, and what runs on this device

Gezel doesn't come with its own AI — it puts *your* choice of AI to work. That can be a cloud provider (OpenAI, Anthropic, GitHub Copilot) or a model running locally on your own machine. With a local model, your data never leaves the room.

## Tiers: matching the model to the job

Models come in sizes, and size matters for what a model can be trusted to do alone. Gezel groups them into **tiers**:

| Tier | Size (in billions of parameters) | Good at |
| --- | --- | --- |
| tiny | under 5B | quick drafts, simple lookups |
| small | 5–12B | everyday chat, focused single tasks |
| medium | 12–45B | multi-step work with tools |
| large | 45B and up, local | most roles, unsupervised steps |
| cloud | hosted frontier models | everything |

Every role declares a **model floor** — the minimum tier it needs to work unsupervised. A reviewer gating your deliverables needs more headroom than someone drafting a shopping list, and gezel enforces that automatically.

A tier says what a size class *should* manage. For what individual models actually did — measured, on a real machine — see the **[Model scorecard](../technical/model-scorecard.md)**. It is the fastest way to pick a local model you can trust with a given job, and [How we test models](../technical/how-we-test-models.md) explains what the numbers do and do not tell you.

## On this device

::handboek-device-hardware

### Installed local models

::handboek-installed-models

## Choosing

You don't have to get this right up front. Set a default provider in Settings, and override it for one crew member only when they need something different — a big cloud model for your reviewer, a fast local one for day-to-day chat. Gezel checks each new model's fitness on your hardware before recommending it.

[Every model](https://gezel.com/docs/model-catalog/) on gezel.com lists the local chat, image, and video models Gezel knows about, including their download size, context window, license, and the engines they run on. Once you have a shortlist that fits, the [Model scorecard](../technical/model-scorecard.md) shows how those models actually performed.

## Adding a model that isn't in the catalog

The catalog is a short list Gezel has tried. You can add other models too. Choose **Add a model…** on your engine's page in Settings, then **From Hugging Face or a file…**, and paste a link to a model on [Hugging Face](https://huggingface.co), the public library most open models are published in. You can also choose a .gguf file that is already on your computer, for example one you downloaded with another app. On huggingface.co, a model's **Use this model** menu opens Gezel with that model ready to check.

Gezel runs local models from GGUF files on every computer, and from MLX models on Apple silicon Macs. On Hugging Face, look for a repository whose name ends in "-GGUF", or an MLX one from mlx-community. Before anything is added, Gezel checks that:

- anyone can download it, and every file has a checksum to verify it against
- it is a model you can talk to, not an add-on part of one
- it contains no program code of its own, which Gezel never runs
- the engine in this version of Gezel can run it
- it includes its own conversation format, and says whether it can use tools
- it fits this computer's memory and disk

If a check fails, Gezel says why and won't add that model. A repository usually holds the same model in several sizes, and a smaller one often fits where the largest does not.

Once the model is on your computer, Gezel tries it: it starts the model, asks for a short reply and checks that the reply reads as language, and asks it to use a tool. The result appears beside the model in Settings → Models. Gezel doesn't pick a model that failed for work on its own, but you can still choose it yourself.

Gezel also looks for good settings for the model. If the catalog has a tested version of the same model, the added one borrows its settings. Otherwise it uses the settings the model's author recommends, or Gezel's general settings for a model of its size. The review tells you which. If the catalog already has the exact file you linked, Gezel offers the catalog version instead.

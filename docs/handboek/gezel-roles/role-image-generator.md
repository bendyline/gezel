---
id: role/image-generator
title: The Image Generator
order: 7
summary: A fixed-function specialist — prompts in, pictures out.
---

# The Image Generator

The **Image Generator** does one thing on purpose: turn descriptions into images. Illustrations, hero images, textures, mockup art — ask, refine, ask again. Results land in the project's artifacts, ready for a Designer or you to place.

This is a deliberately narrow, fixed-function role. It doesn't edit your files or wander the workspace; keeping it single-purpose makes it safe to hand loose creative prompts without side effects. Gezel's install dialog likes to give these gezellen painterly names — Picasso, Vermeer — because a character beats a button.

::handboek-gezel-roster{role=image-generator}

## Using GitHub Copilot

Choose **GitHub Copilot CLI** in **Settings → Image generation → Engine** to use Copilot's experimental image generator. Install or update the Copilot runtime there if needed. Gezel uses your existing Copilot sign-in, or the GitHub token configured in Gezel; no separate image API key is required. Your account's image access, organization policies, and usage limits still apply. Being signed in does not guarantee image generation is available.

Describe the image in chat, or call `generate_image` through MCP. Prompts, reference images, aspect ratio, explicit dimensions, and quality reach the same image provider. Copilot currently accepts square (1024×1024), landscape (1536×1024), and portrait (1024×1536) images; other dimensions use the closest supported shape and the result explains the adjustment. Negative prompts become instructions about what to avoid. Copilot chooses its image model and does not expose a reproducible seed, sampling steps, or edit strength; requests for those controls return an explanatory note.

Image generation follows Gezel's cloud cost-confirmation setting. Other apps using Gezel's MCP tools need **Any image engine** access in **Settings → Integrations** to use Copilot.

## Their character

::handboek-role-about{role=image-generator}

## What they can do

::handboek-role-tools{role=image-generator scope=default}

### On this device

::handboek-role-tools{role=image-generator scope=device}

### As models grow

::handboek-role-tools{role=image-generator scope=tiers}

## Craftbooks they run well

::handboek-craftbook-list{role=image-generator}

### Codex CLI

Choose **OpenAI Codex CLI (cloud, experimental)** in Settings → Image generation.
Install or update Codex CLI and run `codex login` with your ChatGPT account. Gezel
uses that existing sign-in and Codex usage limits; it does not need an image API key.
The CLI runs on the machine hosting your per-user Gezel service. If needed, set its
binary path in Settings → OpenAI Codex CLI → Advanced.

Chat, MCP, and direct image requests use the same provider. Prompts, reference images,
negative instructions, size, aspect ratio, quality, and edit-strength guidance go into
the image request. Codex controls the underlying image model and final render settings:
size and quality are requests in the brief, and edit strength is approximate. Seeds
and sampling steps are unavailable. Results include actual pixel dimensions and notes
about unsupported controls or size differences. Only native image output is accepted;
a text response claiming to have saved an image is not a successful render.

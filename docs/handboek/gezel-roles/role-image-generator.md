---
id: role/image-generator
title: The Image Generator
order: 7
summary: A fixed-function specialist — prompts in, pictures out.
---

# The Image Generator

The **Image Generator** does one thing on purpose: turn descriptions into images. Illustrations, hero images, textures, mockup art — ask, refine, ask again. Results land in the project's artifacts, ready for a Designer or you to place.

This is a deliberately narrow, fixed-function role. It doesn't edit your files or wander the workspace; keeping it single-purpose makes it safe to hand loose creative prompts without side effects. Gezel's install dialog gives these gezels painterly names — Picasso, Vermeer — because a character beats a button.

::handboek-gezel-roster{role=image-generator}

## Editing a picture

To change a picture rather than make a new one, add an **Image editor** gezel from the catalog. Attach a picture to your message and say what to change ("remove the people in the background," "turn it into a watercolor"). It changes that and keeps the rest. Send the next change without a picture and it keeps editing the last result, or attach up to three pictures to combine them. A message with no picture to change is turned away, so it never draws something new from words alone.

On this computer, editing needs a model that can do it. **Qwen Image Edit 2511** is made for editing and does nothing else. **FLUX.2 Klein** draws new pictures and edits too. Whenever a picture comes with the request, from the Image editor or from any gezel, Gezel picks an installed model that can edit it, and the result keeps the picture's shape unless you choose another. Download them in **Settings → Image generation**.

## Styles and fast mode

Models on this computer can take two kinds of add-on, both from **Settings → Image generation → Styles and fast mode**. Each works only with the models it names, so Settings offers only the ones that fit a model you have.

- **Fast mode** draws a picture in a few steps instead of dozens. Once you get it, it is on for that model; switch it off in the model's row. Asking for more steps than fast mode uses leaves it off for that picture.
- **A style** gives a picture a set look, such as pixel art or watercolor. Pick it in the **Style** menu above the message, or ask a gezel for it by name. A style that doesn't match leaves the picture without one, and the result names the styles the model has.

A few styles carry their model's license, which restricts commercial use. Their license button says so.

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
Install or update Codex CLI and sign it in with `codex login`. Gezel uses whatever
the CLI is signed in with, under that account's usage limits and terms; it does not
need a separate image API key.
The CLI runs on the machine hosting your per-user Gezel service. If needed, set its
binary path in Settings → OpenAI Codex CLI → Advanced.

Chat, MCP, and direct image requests use the same provider. Prompts, reference images,
negative instructions, size, aspect ratio, quality, and edit-strength guidance go into
the image request. Codex controls the underlying image model and final render settings:
size and quality are requests in the brief, and edit strength is approximate. Seeds
and sampling steps are unavailable. Results include actual pixel dimensions and notes
about unsupported controls or size differences. Only native image output is accepted;
a text response claiming to have saved an image is not a successful render.

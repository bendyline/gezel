# Media model memory

How Gezel decides whether this machine can run an image or video model, and
what that decision is allowed to do.

## The contract

A model is **hidden** from the download pages, and its pull route refuses it
(409, `media_model_wont_run`), exactly when the launch path would refuse it on
this machine whatever else is running. Both read one pricing, in core
[media-memory.ts](../packages/core/src/media-memory.ts):

- **Before download**, the daemon prices the catalog entry from facts its
  gilde entry pins beside each weight file's sha256 and size: `tensors`, the
  element count at every stored precision, read from the file's safetensors
  header when the model was authored
  ([models/weight-facts.ts](../packages/service/src/models/weight-facts.ts)).
  The app never contacts Hugging Face to price a model.
- **At launch**, the engine factories read the same facts from the headers on
  disk and pass the result to the device ledger.

Catalog files are pinned by sha256, so both describe the same bytes. Core's
`tallySafetensorsHeader` and gilde's `tools/lib/safetensors.mjs` compute the
facts; their tests share one fixture.

### Authoring a model in gilde

Every safetensors file in an image or video entry's newest version carries
`tensors`; gilde's validator refuses one without. After writing a new
version's files, shas and sizes, run `npm run pin-weight-tensors -- <path to
its manifest.json>` in gilde. It reads only each file's header (a ranged
request for its first bytes) and writes the facts in place. A GGUF file needs
none: it loads at its size.

An entry authored before the facts existed is still priced, by the plausible
range of its files' precision (float32 to FP8 stored). It can then only be
warned about (`may-not-run`), never hidden.

The catalog's hand-authored `minRamGB`, `minVramGB` and `hardwareTier` are not
read. They are optional in core's schema and leave gilde at its next minor
line; older builds still require them.

## What a requirement is made of

- **Weights at load precision.** The video server loads every float at
  bfloat16 on an accelerator (float32 on the processor), with the VAE kept at
  float32 for WAN and for LTX-2 by catalog. stable-diffusion.cpp keeps
  float32/float16/bfloat16 as stored, widens FP8 to float16, and converts a
  component to bfloat16 when its launch passes `--tensor-type-rules` (Iris).
  GGUF is priced at its file size.
- **Where they sit.** `discrete` (a card with its own memory), `unified`
  (Apple Silicon, DGX Spark, integrated graphics) or `cpu`. On CUDA the LTX-2
  family streams components through the card, so the card holds the heaviest
  component; everything else moves whole. The video engine only knows CUDA,
  so an AMD or Intel card means the processor. A one-device engine is checked
  against the largest single card, not the sum of several.
- **Working memory.** Video: 20% of the weights plus 12 GiB, measured for
  LTX-2.3 on an M-series Mac at its default size. Image: 1.5 GiB plus 1.5 GiB
  per megapixel of the model's default size, 10% of the weights up to 1.5 GiB,
  and 4 GiB per megapixel more for a model whose VAE cannot be tiled. Image
  working memory follows the output size, not the model: see Calibration.

## Verdicts

| Verdict | Meaning | Page |
|---|---|---|
| `wont-run` | The ledger's static check refuses the model's smallest plausible requirement at the machine's full automatic budget, or its weights exceed the physical memory they must sit in | Hidden; under Show all, disabled as "Too large" |
| `may-not-run` | The entry lacks `tensors` facts and the likely size does not fit, though the smallest plausible one does | Warned; download asks first |
| `over-limit` | Fits the machine but not the engine memory limit set in Settings | Warned; download asks first |
| `tight` | On a discrete card the weights fit but weights plus working memory may not. Working memory on a card is an estimate, so this never blocks | Warned; download asks first |
| `fits` | None of the above | Shows what it needs |

The ledger refuses on a discrete card only when the **weights** do not fit:
that is the one certain figure. The working-memory estimate on a card is a
warning.

The first-run media picker (UI and CLI) recommends only a `fits` model, and
recommends no image or video model when the daemon cannot answer.

## Calibration

`wont-run` is only as accurate as the requirement behind it. Measured:
LTX-2.3 distilled on Apple Silicon (67 GiB weights, 89-91 GiB peak), and every
catalog image model on a DGX Spark (GB10, CUDA, unified memory) at its default
size, 2026-10-19:

| Model | Default size | Peak | Priced |
|---|---|---|---|
| sd-1.5 | 512 | 4.8-5.0 GiB | 6.2 GiB |
| sd-turbo | 512 | 5.8-6.2 | 7.2 |
| sdxl-turbo | 512 | 7.3-8.5 | 9.0 |
| sdxl-base-1.0, sdxl-lightning-4step | 1024 | 7.7-9.5 | 10.1 |
| animagine-xl-4 | 1024 | 8.6-9.2 | 10.1 |
| flux-2-klein-4b-q4 | 1024 | 6.6-7.5 | 8.3 |
| krea-2-turbo-q4 (untiled VAE) | 1024 | 14.3-14.8 | 17.5 |
| krea-2-turbo-q6, q8 (untiled VAE) | 1024 | 17.3, 20.1 | 20.7, 23.8 |
| moss-image-sft-q4 | 1024 | 10.7-13.5 | 12.5 |
| iris-3b-f32 | 1024 | 13.3-15.1 | 11.7 |
| ming-image-0.1-design-bf16 | 1024 | 46.2-46.3 | 50.4 |

Iris is still priced 12-23% under, and MOSS's highest reading 8% under. Their
engine compute buffers are small (0.7 and 1.1 GB); the rest is process and
driver memory, which Iris holds more of (3 GB resident against about 1 GB for
the others). Peaks move by a gigabyte or more between runs of the same model,
because the sampler reads available memory four times a second and catches
short spikes only some of the time; read several runs, never one. An untiled
decode at 1024px measured 4 GiB over a tiled one for SDXL Lightning and 2.6
GiB for Flux.2 Klein. Not measured: video on CUDA, WAN and LTX 0.9.x anywhere,
and image models on Metal, Vulkan or a discrete card.

To measure, run the image bench (`pnpm --filter @bendyline/gezel-evals run
image-bench -- --models <id>`; see `evals/src/image-bench/IMAGE-BENCH.md`). It
reads the peak as the fall in available memory from just before the engine
starts, which counts what a unified-memory GPU allocates, and puts it beside
the daemon's own `bytes` from `GET /api/image-gen/models/fit`. Anything else
that loads during the run counts too: the first 2026-10 pass read Iris at 30
GiB because a 17 GB chat model was loading beside it. Change the constants in
`media-memory.ts`, not the catalog.

On Windows, an NVIDIA driver can page graphics memory to system RAM instead
of failing an allocation. A model whose weights exceed the card can then
start, but it runs many times slower; Gezel treats that as not running.

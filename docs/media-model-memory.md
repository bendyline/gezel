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
  LTX-2.3 on an M-series Mac at its default size. Image: 10% plus 1.5 GiB, and
  6 GiB more for a model whose VAE cannot be tiled. The image figure is not yet
  measured; see Calibration.

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
LTX-2.3 distilled on Apple Silicon (67 GiB weights, 89-91 GiB peak). Not
measured: video on CUDA, WAN and LTX 0.9.x anywhere, and every image model. To
measure one, start the engine with the model, run one generation at its
default size, and compare the peak (sd-server prints `total params memory
size`; `nvidia-smi` or Activity Monitor for the rest) with `bytes` and
`gpuPeakBytes` from `GET /api/{image,video}-gen/models/fit`. Change the
constants in `media-memory.ts`, not the catalog.

On Windows, an NVIDIA driver can page graphics memory to system RAM instead
of failing an allocation. A model whose weights exceed the card can then
start, but it runs many times slower; Gezel treats that as not running.

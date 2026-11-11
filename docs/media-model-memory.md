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
  ([models/weight-facts.ts](../packages/inference/src/models/weight-facts.ts)).
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

- **Weights at load precision.** The diffusers video server loads every float
  at bfloat16 on an accelerator (float32 on the processor), with the VAE kept
  at float32 for WAN and for LTX-2 by catalog. stable-diffusion.cpp, for
  images and for video, keeps float32/float16/bfloat16 as stored, widens FP8
  to float16, and converts a component to bfloat16 when its launch passes
  `--tensor-type-rules` (Iris). GGUF is priced at its file size. An sd.cpp
  video entry's files are priced as the sd-server slot each fills (its
  `role`), a diffusers entry's as the folder each sits in.
- **Where they sit.** `discrete` (a card with its own memory), `unified`
  (Apple Silicon, DGX Spark, integrated graphics) or `cpu`. Each video model
  runs on its catalog `engine`, and each engine has its own pool. The
  diffusers server only knows CUDA, so for it an AMD or Intel card means the
  processor; on CUDA the LTX-2 family streams components through the card,
  so the card holds the heaviest component. The sd.cpp engine runs where the
  image engine does (Metal, CUDA, Vulkan, or the processor), and on a
  discrete card it is launched with `--max-vram` at its graphics-memory
  claim, so sd.cpp's auto-fit keeps the rest of the weights in system memory
  rather than filling the card past what the ledger admitted. A one-device
  engine is checked against the largest single card, not the sum of several.
  An sd.cpp video launch is claimed for the larger of the model's default
  clip and the one requested (`SdVideoClaim` in
  `providers/video/sd-cpp-video.ts`); a later request for a clip that needs
  more relaunches the engine with room for it. It prices only the decoder
  the launch loads: on Metal the tiny one when the entry ships both (core
  `sdCppVideoDecoder`), because the full Wan VAE takes hours there.
- **Working memory.** Video is priced for a clip (`width × height × frames`,
  core `videoMemoryRequirement` / `sdCppVideoMemoryRequirement`): resident
  weights, a fixed engine share, and the larger of sampling (transformer
  activations per latent token, from the architecture's geometry in
  `video-geometry.ts`) and the VAE decode (per pixel for Wan's causal VAE,
  per pixel-frame for LTX's whole-clip VAE, each per tiling mode). The
  coefficients live in `media-memory-coefficients.ts`, each marked
  `measured`, `borrowed` or `provisional`. Until a calibration lands every
  set is provisional: its fixed share is anchored so a model's price at its
  default size is the earlier rule (20% of the weights plus 12 GiB, measured
  for LTX-2.3 on an M-series Mac), and only the change with size comes from
  the slopes. Verdicts stay at the default size. Image: 1.5 GiB plus 1.5 GiB
  per megapixel of the model's default size, 10% of the weights up to 1.5 GiB,
  and 4 GiB per megapixel more for a model whose VAE cannot be tiled. Image
  working memory follows the output size, not the model: see Calibration.
- **VAE tiling.** Off CUDA, the diffusers server decodes whichever way the
  price says is smaller and the daemon sends that choice with each request
  (`vaeTiling`), so the engine does what it was admitted for; while a
  causal VAE's lines are unmeasured it keeps decoding whole. sd.cpp decodes
  as its catalog entry's `sdCpp.vaeTiling` says.

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
GiB for Flux.2 Klein. Not measured: video on CUDA, the diffusers WAN and LTX
0.9.x anywhere, sd.cpp video off Metal (see below), and image models on Metal,
Vulkan or a discrete card.

Video is measured with the video bench (`pnpm --filter @bendyline/gezel-evals
run video-bench -- --models <id> --sizes <WxHxF>`; see
`evals/src/video-bench/VIDEO-BENCH.md`). On macOS a clip's peak is the larger
of the engine's `phys_footprint_peak` and a once-a-second reading that counts
its Metal buffers as the GPU driver holds them: footprint counts only pages
the process touched itself, and ggml's compute buffers are written by the GPU
alone, so it never sees them. The bench writes each clip's peak beside core's
size-aware estimate to `calibration.jsonl`, with sd-server's own weights and
compute buffers for the clip. `fit-media-memory -- <runs dirs> --reprice`
fits the coefficients and checks every clip against what core charges now.

sd.cpp video on an M5 Max (Metal, sd.cpp master-1050, flash attention forced
on, the tiny decoder for Wan2.2 and Wan2.1, the full VAE for LingBot and
LTX), 2026-11-10, with GPU-held memory counted. Buffers are sd-server's own
figures; a launch's first clip includes loading. Wan2.1 decoded in
128-pixel tiles unless the row says otherwise. It was measured as a
first-wave candidate and left out of the catalog: on Metal it took as long
and as much memory as Wan2.2 Q4 for a smaller clip, with no picture input. Every
clip was measured with the peak that subtracts the GPU-owned footprint
categories; runs before that correction read up to 1.1 GiB high, and two
renders of the same clip differ by up to 0.5 GiB. LingBot's rows marked
"vision encoder" were measured while evaluating picture-to-video:
Comfy-Org's Qwen3-VL bf16 text encoder on an sd-server patched to load its
vision tower (upstream maps those tensors only for some image models). It
held a picture's scene for 33 frames and lost it by 49, so the catalog entry
makes clips from words only, with the Q8 GGUF the other rows used.

| Model | Clip | Time | Weights | Sampling buffer | Decoder buffer | Peak |
|---|---|---|---|---|---|---|
| wan2.2-ti2v-5b-q4 | 512x512x17 (first) | 41 s | 6.62 GiB | 0.22 GiB | 0.53 GiB | 8.46 GiB |
| wan2.2-ti2v-5b-q4 | 640x512x33 | 86 s | 6.62 | 0.47 | 0.95 | 8.27 |
| wan2.2-ti2v-5b-q4 | 1280x704x33 | 428 s | 6.62 | 1.18 | 0.95 | 8.66 |
| wan2.2-ti2v-5b-q4, from a picture | 1280x704x33 (first) | 429 s | 6.62 | 1.18 | 0.95 | 9.79 |
| wan2.2-ti2v-5b-q4 | 1280x704x121 (first) | 62 min | 6.62 | 4.04 | 3.27 | 13.23 |
| wan2.2-ti2v-5b-q4, Turbo | 1280x704x33 (first) | 38 s | 6.62 | 1.18 | 0.95 | 9.06 |
| wan2.2-ti2v-5b-q4, Turbo | 1280x704x33 | 34 s | 6.62 | 1.18 | 0.95 | 9.66 |
| wan2.2-ti2v-5b-q4, Turbo, from a picture | 1280x704x33 (first) | 51 s | 6.62 | 1.18 | 0.95 | 10.74 |
| wan2.2-ti2v-5b-q4, Turbo | 1280x704x121 (first) | 388 s | 6.62 | 4.04 | 3.27 | 12.69 |
| wan2.2-ti2v-5b-q8 | 640x512x33 (first) | 107 s | 10.68 | 0.47 | 0.95 | 13.41 |
| wan2.2-ti2v-5b-q8 | 1280x704x33 | 419 s | 10.68 | 1.18 | 0.95 | 12.88 |
| wan2.2-ti2v-5b-q8 | 1280x704x121 (first) | 60 min | 10.68 | 4.04 | 3.27 | 17.21 |
| wan2.1-t2v-1.3b | 480x480x33 (first) | 288 s | 8.29 | 0.85 | 0.95 | 11.06 |
| wan2.1-t2v-1.3b | 832x480x33 | 676 s | 8.29 | 1.47 | 0.95 | 10.95 |
| wan2.1-t2v-1.3b, 256-pixel decoder tiles | 480x480x81 (first) | 20 min | 8.29 | 1.97 | 8.86 | 17.77 |
| wan2.1-t2v-1.3b | 480x480x81 (first) | 19 min | 8.29 | 1.97 | 2.22 | 12.02 |
| wan2.1-t2v-1.3b | 832x480x81 (first) | 58 min | 8.29 | 3.41 | 2.22 | 13.52 |
| lingbot-video-dense-1.3b | 480x480x17 (first) | 272 s | 6.82 | 1.38 | 2.13 | 9.54 |
| lingbot-video-dense-1.3b | 480x480x33 | 566 s | 6.82 | 2.43 | 2.15 | 9.86 |
| lingbot-video-dense-1.3b | 832x480x81 (first) | 81 min | 6.82 | 9.48 | 2.19 | 18.69 |
| lingbot-video-dense-1.3b, vision encoder | 480x480x17 (first) | 335 s | 11.10 | 1.38 | 2.13 | 13.20 |
| lingbot-video-dense-1.3b, vision encoder | 480x480x33 | 655 s | 11.10 | 2.43 | 2.15 | 13.75 |
| lingbot-video-dense-1.3b, vision encoder, from a picture | 832x480x17 (first) | 834 s | 11.10 | 2.47 | 2.13 | 15.09 |
| lingbot-video-dense-1.3b, vision encoder, from a picture | 832x480x33 (first) | 24 min | 11.10 | 4.23 | 2.15 | 15.68 |
| lingbot-video-dense-1.3b, vision encoder, from a picture | 832x480x49 (first) | 40 min | 11.10 | 6.02 | 2.15 | 17.38 |
| lingbot-video-dense-1.3b, vision encoder, from a picture | 832x480x81 (first) | 85 min | 11.10 | 9.60 | 2.19 | 21.54 |
| ltx-2.3-22b-distilled-q4 | 512x512x49 (first) | 492 s | 24.65 | 9.05 | 0.37 | 36.31 |
| ltx-2.3-22b-distilled-q4 | 768x512x121 (first) | 34 min | 24.65 | 28.93 | 0.37 | 54.53 |
| ltx-2.3-22b-distilled-q4, from a picture | 768x512x25 (first) | 398 s | 24.65 | 8.49 | 0.30 | 36.97 |

The Wan2.2 Q4 entry renders with Wan2.2-TI2V-5B-Turbo (Self-Forcing step
and guidance distillation, hum-ma's Q4_K_M GGUF): 4 steps at guidance 1, so
its default 1280x704x121 clip took 6.5 minutes against 62 for the 20-step,
guidance-5 model, with the same files otherwise and the same memory. The
rows above marked Turbo are it; the others are the 20-step model.

Each set prices its phases beside the resident weights, and the largest
wins. Loading, before any graph runs: 0.47 GiB plus 0.41 of a GGUF text
encoder's bytes, which fits Wan2.2 Q4's 1.84 GiB with its 3.4 GiB UMT5 and
Wan2.2 Q8's 2.73 and Wan2.1's 2.77 with the 5.6 GiB one, whatever their
diffusion models weigh; LingBot's 8.3 GiB bf16 safetensors Qwen3-VL held no
more than 2.1 GiB beyond its weights at any point, so a safetensors encoder
adds nothing. Sampling: the buffer, linear in latent tokens, plus a fixed
share and about 15 bytes a pixel-frame of host memory (sd.cpp holds the clip
as float32 frames from the start). The fixed share is 1.4 GiB: about 1.0 at
Wan2.2's default clip, but short-lived allocations during sampling reach
further (a 0.25 s trace showed GPU memory 1.8 GiB beyond the weights and the
buffer for a moment) and repeat renders of one clip differ by up to 0.5 GiB.
Animating a picture is charged as a phase of its own
(`imageToVideoBytes`, 2.4 GiB for Wan2.2) rather than on top of sampling:
Turbo once peaked at 10.74 GiB from a picture at 1280x704x33 against 9.06 to
9.66 from words (a repeat held 9.31), yet held 12.82 against 12.69 at its
default clip. sd-server encodes the picture before it loads the diffusion
model and text encoder, so the charge covers what was measured, not a known
allocation. Decoding: the
decoder's buffer plus its own fixed share. The sampling buffer costs 50 bytes per token per unit of hidden
width for Wan2.2, 72 for Wan2.1, 160 for LingBot and 1163
for LTX-2 over a 1.68 GiB base (`sampleBaseBytes`: its joint graph attends
over text and audio tokens too): LingBot and LTX-2 hold their timestep
modulation per token. Guidance does not double it: sd-server runs the
guided and unguided passes one after the other, and Wan2.2 Turbo (guidance
1) held the same 1.18 GiB at 1280x704x33 as Wan2.2 at guidance 5. With
flash attention off it grows with tokens squared: 70 GB at Wan2.2's default
clip. The tiny decoder's buffer follows frames, not pixels, since it tiles each
frame: at sd.cpp's default 256-pixel tile, 28 MB a frame for Wan2.2's and 113
MB for Wan2.1's, which made Wan2.1's 81-frame clips decode-bound at about 19
GiB. A tile's buffer follows its area, so an entry can set a smaller tile
(`sdCpp.vaeTiling.tileSizePx`); Wan2.1 at 128 pixels, 480x480x81, held
2.22 GiB against 8.86, the peak fell from 17.77 to 12.02 GiB, decoding still
took 9 seconds, and the frames matched (mean difference 1.6 of 255, no grid).
Core scales a decode line's tile terms by the tile's area against 256
pixels. Temporal tiling (`vaeTiling.temporal`) bounds the tiny decoder too
(1.69 GiB) but restarts its frame memory every tile, and sd.cpp blends only
one frame across the overlap: the 480x480x81 clip jumped visibly every 12
frames, so no entry uses it. The full VAE's spatially tiled buffer holds
still. `media-memory.calibration.test.ts` holds every clip in
`src/__fixtures__/media-memory/` to the band. Each clip carries the weight
files and model fields its engine loaded, read from the run's trial home
(its install record and the files on disk), so a catalog entry that changes
its files or leaves the catalog never re-prices an old measurement. Repeat
renders of one clip are held to the band by their highest peak, since a 1 Hz
poll catches or misses short spikes (one Wan2.2 clip read 8.66 to 9.51 GiB).
Regenerate the fixture with `fit-media-memory --write-fixture`.

`footprint` alone reads low here: it counts only pages the process touched,
and ggml's compute buffers are written by the GPU alone. It read 9.97 GiB for
the default Wan2.2 Q4 clip and 7.45 GiB for LingBot at 480x480x17, which held
13.23 and 9.54. Not measured at all: sd.cpp video on CUDA and Vulkan.

sd-server holds LTX-2's timestep-modulation layers at float32 whatever the
file stores (its `AdaLayerNormSingle` is a `force_f32` Linear). The catalog's
GGUFs store those 427M elements as bf16, so LTX-2.3 22B loads 815 MiB over
its file size; core adds it (`sdCppWidenedBytes`). On a backend with no
measurements, a model is priced at the larger of the provisional set and the
same architecture as measured on another backend
(`videoMemoryCoefficientCandidates`): the graph's buffers follow the
architecture far more than the backend, and the provisional set priced
LTX-2.3 at 41 GiB where Metal measured 54.

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

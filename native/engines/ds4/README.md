# ds4 (DwarfStar) — very-large-MoE inference engine

[antirez/ds4](https://github.com/antirez/ds4) is a small, from-scratch C
inference engine purpose-built for a handful of very large mixture-of-experts
models: **DeepSeek V4 Flash / PRO**, **DeepSeek V4.1 Flash**, **GLM 5.2 / 5.3**,
and **Qwen3.8 Flash Next**. It treats SSD as a first-class citizen: supported
routed MoE expert weights and KV cache can stream from disk, while DeepSeek
V4.1 Engrams and Qwen n-grams are always row-read directly from their GGUF.
We vendor its `ds4-server` (an OpenAI-compatible HTTP server) as a first-class
on-device engine alongside `llama-server`.

One binary serves all supported families: `DS4_MODEL_FAMILY` is a runtime global set
from the GGUF's `general.architecture` at load time (`glm-dsa` → GLM 5.2,
`glm5-next` → GLM 5.3, `deepseek41` → DeepSeek V4.1, `qwen4exp` → Qwen3.8,
and `deepseek4` → DeepSeek V4), and ds4-server renders/parses each family's
own prompt and tool-call syntax behind the same OpenAI-shaped API. The provider
stays generic; per-model residency and graph limits live in catalog metadata.

## What we build

`ds4-server` only — Gezel drives it over `POST /v1/chat/completions` (SSE) and
manages models itself, so we don't ship the `ds4` CLI / `ds4-agent` / `ds4-eval`
binaries.

## Platform matrix

ds4 is **GPU-only** (its CPU path is diagnostics-only and crashes the macOS
kernel), so there is exactly one shippable backend per platform:

| Platform      | Backend | Make target                       | Ship? |
|---------------|---------|-----------------------------------|-------|
| darwin-arm64  | Metal   | `make ds4-server`                 | ✅    |
| linux-x64     | CUDA    | `make ds4-server CUDA_ARCH=<sm>`  | ✅    |
| linux-arm64   | CUDA    | `make ds4-server CUDA_ARCH=sm_121` (Spark/GB10) | ✅ |
| darwin-x64    | —       | —                                 | ❌ no unified-memory Metal target |
| win32-x64     | —       | —                                 | ❌ no upstream MSVC build (use WSL2) |

ROCm is now on upstream `main`, but remains out of our shipping matrix because
we have no ROCm build/release job or test hardware.

## Build

```sh
# macOS (Metal):
native/engines/ds4/build.sh

# Linux CUDA — local dev (nvcc detects the GPU):
native/engines/ds4/build.sh
# Linux CUDA — CI cross-build (no GPU present): pin an explicit arch
DS4_CUDA_ARCH=sm_90  native/engines/ds4/build.sh   # H100-class
DS4_CUDA_ARCH=sm_121 native/engines/ds4/build.sh   # GB10 / DGX Spark
```

The wrapper retains upstream's `NVCC_ARCH_FLAGS` expansion. This lets the
pinned Makefile promote base capabilities such as `sm_121` to `sm_121a` and
add matching feature defines such as `DS4_CUDA_HAVE_MXF4=1` automatically.

Output: `native/build/<platform>/gezel-ds4-server`. **On macOS the binary is NOT
self-contained** — it compiles its Metal shaders from `./metal/*.metal` (26
sources) at runtime, resolved relative to the working directory, so build.sh
stages a `metal/` dir next to the binary and the supervisor launches ds4-server
with `cwd` set to the bundle dir (see `buildDs4Provider`). Without `metal/`,
startup aborts with "metal backend unavailable". The Linux/CUDA build compiles
its kernels into the binary (no runtime shader dir) and bundles
`libcudart`/`libcublas` with an `$ORIGIN` rpath, though the NVIDIA driver is
still required on the host.

## Models

ds4 is **not** a general GGUF loader — it loads only the specific quant layouts
its engine was built for, co-versioned with the pin in `VERSION`:

| Catalog id | GGUF | Size |
|---|---|---|
| `deepseek-v4-flash-284b-q2` | [`antirez/deepseek-v4-gguf`](https://huggingface.co/antirez/deepseek-v4-gguf) IQ2_XXS | ~81 GiB |
| `deepseek-v4-flash-284b-q4` | same repo, routed Q4_K | ~153 GiB |
| `glm-5.3-flash-320b-q2` | [`antirez/glm-5.3-flash-gguf`](https://huggingface.co/antirez/glm-5.3-flash-gguf) IQ2_XXS/Q2_K + model-matched vision encoder | ~91 GiB |
| `glm-5.2-754b-q2` | [`antirez/glm-5.2-gguf`](https://huggingface.co/antirez/glm-5.2-gguf) routed IQ2_XXS | ~197 GiB |
| `qwen3.8-flash-next-q2` | [`antirez/qwen3.8-flash-next-gguf`](https://huggingface.co/antirez/qwen3.8-flash-next-gguf) IQ2_XXS/Q2_K; 41.73 GiB resident weights + 95.37 GiB disk-only n-grams | 137.10 GiB |
| — (upstream-only pending a full local install) | [`antirez/deepseek-v4.1-flash-gguf`](https://huggingface.co/antirez/deepseek-v4.1-flash-gguf) Q2; 151.8 GiB main weights + 188.8 GiB disk-only Engrams | 340.6 GiB |

An entry is a ds4 model exactly when its manifest carries a `ds4` source block.

A ds4 entry may also declare a model-matched `visionEncoder` payload, including
its own Hugging Face repository and revision when upstream publishes the
encoder separately from the language GGUF. The installer downloads and
verifies that GGUF beside the language weights, the launcher accounts for its
resident memory and passes it as `--vision`, and the turn router sends image
bytes natively only when that exact encoder is loaded.
An explicit `ds4ModelPath` never borrows a catalog encoder; pair development
overrides with `ds4VisionEncoderPath` / `GEZEL_DS4_VISION_ENCODER`.

**Not supported: split (multi-shard) GGUFs.** ds4's `model_open()` maps one
file and the source has no `split.*` handling, so upstream's
`download_model.sh glm-unsloth-q4` target (unsloth's 11-shard UD-Q4_K_XL, whose
first shard is metadata-only with `n_tensors: 0`) cannot be loaded from its
first shard the way that script's symlink implies. Only single-file GGUFs
belong in the catalog. antirez's remaining GLM quants are single-file but far
larger — routed Q2_K is ~244 GiB and routed Q4_K ~404 GiB — so they are left
out until someone has hardware to validate them.

Re-validate GGUF compatibility whenever bumping the pin in `VERSION`.

## Runtime notes

- Beta-quality upstream — pin deliberately in `VERSION`.
- Readiness probe is `GET /v1/models` (ds4 exposes no `/health`).
- Reasoning effort is request-scoped. Gezel sends the selected level through
  both top-level `reasoning_effort` and
  `chat_template_kwargs.reasoning_effort`, keeping the latter aligned with
  Qwen's catalog tuning. Never pass `--think-level` to `ds4-server`; that flag
  belongs to ds4's standalone CLI/agent. The same request path applies to
  DeepSeek V4.1 once it has a locally validated catalog entry.
- Routed-expert SSD streaming (`--ssd-streaming
  --ssd-streaming-cache-experts NGB`) remains the safe default for models that
  implement it. Qwen3.8 does not: its 41.73 GiB of main/MTP weights stay
  resident, while the separate 95.37 GiB n-gram table is always read row-wise
  from the GGUF. Its catalog row therefore sets `residentWeightBytes`, disables
  routed-expert streaming, caps the initial context at 8K, and passes
  `--prefill-chunk 1024` for a 64 GB Mac. DeepSeek V4.1 can stream experts, but
  its Engram tables likewise remain disk-only in every mode.
- For routed-expert models, full residency is normally a config-only expert override. Gezel honors
  `ds4SsdStreaming:false` only when the exact GGUF plus 32 GiB of headroom fits
  a unified-memory arm64 machine; unknown model sizes and discrete-GPU systems
  stay streamed. This distinction matters on a 128 GiB Mac: the ~81 GiB Q2
  GGUF can fit fully, while the ~153 GiB Q4 GGUF cannot.
- The measured GB10 Q2 working set was ~105 GiB at 128K context and ~107 GiB
  at 262K context. That result motivated the old 128 GiB full-residency default,
  but it was specific to Q2 and must not be generalized to the much larger Q4
  build.
- Models whose catalog declares `ssdStreamingSupported:false` do not receive
  the legacy 96 GiB full-residency broker floor. Their authored working set is
  used directly; otherwise the floor would reject Qwen's supported 64 GB
  configuration even though its n-grams never occupy unified memory.
- A catalog `mtp` block enables model-embedded multi-token prediction. Qwen3.8
  uses `--mtp --mtp-exact-sampling`: its temperatures are non-zero in normal
  Gezel profiles, so exact sampling preserves the ordinary target distribution
  instead of accepting matching greedy drafts opportunistically. This is
  separate from DeepSeek DSpark's external `--mtp-model` companion and the two
  draft paths are never stacked. Operators can override with `ds4Mtp` or
  `GEZEL_DS4_MTP=off|on|auto`.
- Launch context is RAM-tiered (128K, or 256K above 192 GiB) and a model may
  lower it via `ds4.maxLaunchCtx`. The tier assumes DeepSeek V4 Flash's small
  resident footprint; GLM 5.2 IQ2_XXS keeps 19.6 GiB of non-routed weights
  resident (vs ~4 GiB) and spends 89 KiB/token on MLA KV, so it caps at 64K.
  An explicit `config.ds4NumCtx` still overrides both.
- **`ds4-server` prints its own memory plan at load — author the catalog from
  it, never from an architecture guess.** Two lines, both unconditional:

  ```
  ds4: memory: KV 1.36 GiB (raw 0.36 + compressed 1.00) + buffers 1.00 GiB
       + resident model 0.99 GiB + expert cache 28.62 GiB
       + prefill expert reserve 3.38 GiB = 35.35 GiB planned
  ds4: memory detail: ctx=131072 prefill_cap=4096 raw_kv_rows=4352
       compressed_kv_rows=32770
  ```

  `compressed_kv_rows` tracks the window (DSA compresses 4:1 here, hence
  ctx/4); `raw_kv_rows` tracks `prefill_cap`, so it does NOT scale with ctx.
  The window-scaling part alone is `ds4.kvBytesPerToken` — 1.00 GiB / 131072 =
  8192 B/token for DeepSeek V4 Flash, against 89 KiB/token for GLM 5.2's
  uncompressed MLA. Pair it with `ds4.residentCtxTokens` (the `ctx=` the
  `residentBytes` figure was measured at) and both the models list and the
  capacity broker re-price the model at whatever window a device launches it
  with. Omit both and the footprint is treated as flat, which is what every
  entry did before these fields existed.
- GLM does not support `--power` below 100, an explicit `--prefill-chunk`, or
  the external `--mtp-model` file. GLM 5.2 also lacks directional steering.
  GLM 5.3 Flash's embedded draft block uses the same catalog-controlled
  `--mtp` path as Qwen3.8; no external support file is needed.
- A controlled 6,012-token GB10 benchmark measured full residency at 97.98
  prefill / 5.20 decode tok/s, versus 39.35 / 1.44 tok/s with a 64 GB expert
  cache: 2.59x faster end-to-end. The capacity broker reserves its full 96 GiB
  workstation ceiling in resident mode so another local engine cannot be
  admitted alongside DS4.

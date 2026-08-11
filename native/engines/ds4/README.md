# ds4 (DwarfStar) — very-large-MoE inference engine

[antirez/ds4](https://github.com/antirez/ds4) is a small, from-scratch C
inference engine purpose-built for a handful of very large mixture-of-experts
models: **DeepSeek V4 Flash / PRO** and **GLM 5.2**. It treats SSD as a
first-class citizen — routed MoE expert weights and KV cache stream from disk —
so a 284B-parameter model runs on a 64 GB Mac. We vendor its `ds4-server` (an
OpenAI-compatible HTTP server) as a first-class on-device engine alongside
`llama-server`.

One binary serves both families: `DS4_MODEL_FAMILY` is a runtime global set
from the GGUF's `general.architecture` at load time (`glm-dsa` → GLM,
otherwise DeepSeek-V4), and ds4-server renders/parses each family's own prompt
and tool-call syntax behind the same OpenAI-shaped API. Nothing in our build or
provider layer is family-specific.

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
| linux-arm64   | CUDA    | `make ds4-server CUDA_ARCH=` (Spark/GB10) | ✅ |
| darwin-x64    | —       | —                                 | ❌ no unified-memory Metal target |
| win32-x64     | —       | —                                 | ❌ no upstream MSVC build (use WSL2) |

ROCm exists only in an upstream `rocm` branch (community-maintained, no test
hardware) and is out of scope.

## Build

```sh
# macOS (Metal):
native/engines/ds4/build.sh

# Linux CUDA — local dev (nvcc detects the GPU):
native/engines/ds4/build.sh
# Linux CUDA — CI cross-build (no GPU present): pin an explicit arch
DS4_CUDA_ARCH=sm_90  native/engines/ds4/build.sh   # H100-class
DS4_CUDA_ARCH=spark  native/engines/ds4/build.sh   # GB10 / DGX Spark
```

Output: `native/build/<platform>/gezel-ds4-server`. **On macOS the binary is NOT
self-contained** — it compiles its Metal shaders from `./metal/*.metal` (19
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
| `deepseek-v4-flash-284b-q4` | same repo, FP4 | ~153 GiB |
| `glm-5.2-754b-q2` | [`antirez/glm-5.2-gguf`](https://huggingface.co/antirez/glm-5.2-gguf) routed IQ2_XXS | ~197 GiB |

An entry is a ds4 model exactly when its manifest carries a `ds4` source block.

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
- SSD streaming (`--ssd-streaming --ssd-streaming-cache-experts NGB`) is the
  safe default for every local model. The resident working set (bounded routed-
  expert cache + fixed model state + KV/runtime buffers) is decoupled from the
  full GGUF size. Gezel uses each catalog model's cache target and reduces it
  when necessary to preserve 32 GiB for the operating system and other apps.
- Full residency is a config-only expert override. Gezel honors
  `ds4SsdStreaming:false` only when the exact GGUF plus 32 GiB of headroom fits
  a unified-memory arm64 machine; unknown model sizes and discrete-GPU systems
  stay streamed. This distinction matters on a 128 GiB Mac: the ~81 GiB Q2
  GGUF can fit fully, while the ~153 GiB Q4 GGUF cannot.
- The measured GB10 Q2 working set was ~105 GiB at 128K context and ~107 GiB
  at 262K context. That result motivated the old 128 GiB full-residency default,
  but it was specific to Q2 and must not be generalized to the much larger Q4
  build.
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
- GLM does not support directional steering, `--power` below 100, an explicit
  `--prefill-chunk`, or the external `--mtp` file. We pass none of these, so
  the launch args are family-agnostic. `--glm-mtp` (experimental greedy
  speculation) is deliberately not wired up.
- A controlled 6,012-token GB10 benchmark measured full residency at 97.98
  prefill / 5.20 decode tok/s, versus 39.35 / 1.44 tok/s with a 64 GB expert
  cache: 2.59x faster end-to-end. The capacity broker reserves its full 96 GiB
  workstation ceiling in resident mode so another local engine cannot be
  admitted alongside DS4.

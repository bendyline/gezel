# ds4 (DwarfStar) — DeepSeek-V4 inference engine

[antirez/ds4](https://github.com/antirez/ds4) is a small, from-scratch C
inference engine purpose-built for **DeepSeek V4 Flash / PRO**. It treats SSD
as a first-class citizen — routed MoE expert weights and KV cache stream from
disk — so a 284B-parameter model runs on a 64 GB Mac. We vendor its
`ds4-server` (an OpenAI-compatible HTTP server) as a first-class on-device
engine alongside `llama-server`.

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

ds4 is **not** a general GGUF loader — it only loads antirez's DeepSeek-V4
GGUFs (co-versioned with the engine) from
[`antirez/deepseek-v4-gguf`](https://huggingface.co/antirez/deepseek-v4-gguf).
The catalog entry `deepseek-v4-flash-284b-q2` carries the `ds4` source block.
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
- A controlled 6,012-token GB10 benchmark measured full residency at 97.98
  prefill / 5.20 decode tok/s, versus 39.35 / 1.44 tok/s with a 64 GB expert
  cache: 2.59x faster end-to-end. The capacity broker reserves its full 96 GiB
  workstation ceiling in resident mode so another local engine cannot be
  admitted alongside DS4.

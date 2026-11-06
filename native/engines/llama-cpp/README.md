# llama.cpp

Upstream: https://github.com/ggml-org/llama.cpp — MIT licensed.

This directory **does not vendor upstream source**. The build scripts
clone it at the pinned commit (see `VERSION`) into `.upstream/`
(gitignored) and build with CMake.

Status: **integrated**. The pinned source is built by the native release
matrix, selected by the desktop supervisor, and served through the local-model
provider. `VERSION` is the source of truth for the upstream revision.

The build applies `patches/muse-runtime.patch` to the pinned source and
removes it on exit. v0.4.0 parses Muse's analysis channel but omits its thinking
delimiters from the reasoning-budget sampler configuration, so both launch and
request budgets are silently dropped. The patch registers those delimiters,
preserves the next recipient header at forced cutoffs, and replays that full
header into the lazy tool grammar when a shorter natural terminator is its
prefix. v0.9.0 (#31374) also ends forcing when an end tag arrives that the
forced sequence did not supply (the prompt already closed the block); the patch
keeps that, but a shorter end matched *inside* the forced header no longer cuts
the header short. Direct tool responses also activate the grammar without requiring the
generation prompt, which lazy samplers do not receive. Regression tests cover
both transitions. It also fixes unconstrained nested
JSON values (`additionalProperties: {}` and `items: {}`), which were wrongly
restricted to objects and forced structured reports into extra wrappers. Native
chat and JSON-schema regressions cover that case; the Python converter stays in
sync. Revalidate/remove this patch when bumping upstream; a mismatch fails the
build. It changes inference executables and does not require a desktop installer.

## Upstream versioning

Upstream runs two tag lines off one history:

| Tag line | What it is | GitHub release |
| --- | --- | --- |
| `vX.Y.Z` | semver **stable** releases, introduced with `v0.3.0` | latest |
| `b####` | rolling build tags, several a day | prerelease |

A stable release also carries a `b####` tag on the identical commit
(`v0.3.0` == `b10621`), so the two lines never diverge — they label the
same history at different rates. **We pin the semver line.**

`VERSION` therefore carries a `build=` line. llama.cpp derives the version
its binary reports from `git rev-list --count HEAD`
(`cmake/build-info.cmake`), which used to be readable straight off a
`b####` tag. On a semver tag it is not, and it stays load-bearing: it is
how `native/scripts/fetch-upstream.sh` catches a truncated fetch and how
`scripts/assert-llama-version.mjs` proves in CI that each built artifact
is the pin it claims to be. Both refuse a pin they cannot verify rather
than skipping the check, so a bump must move `tag`, `build`, and `commit`
together.

v0.3.0 also changed what the **binary** prints, which is a separate break from
the tag change and is only visible once you actually build:

```
b10353   version: 10353 (f8def7f)
v0.3.0   version: 0.3.0 (build 10621, commit c1d0e7a)
```

`scripts/assert-llama-version.mjs` parses both. It additionally checks the
reported semver against a `vX.Y.Z` pin, which catches the other half of the
change: upstream defaults `LLAMA_BUILD_IS_DEV=ON`, stamping the binary
`0.3.0-dev`, and its CMakeLists says to set it OFF "when making a release from
a release tag (vX.Y.Z)". Both build scripts pass `-DLLAMA_BUILD_IS_DEV=OFF`, so
gezel's engines identify as the release they were built from rather than as an
upstream nightly.

Bumping the pin also means updating `LLAMA_ENGINE_VERSION`
(`packages/core/src/native/llama-engine-version.ts`), the
`native/licenses/manifest.json` entry, and the NOTICE row — the last two
are reconciled against this file by `scripts/check-notice.mjs`.

## Produced binary

`llama-server` — the HTTP server upstream ships. It speaks:

- `/v1/chat/completions` — OpenAI-compatible chat with streaming SSE,
  tool/function calling (requires `--jinja`), and JSON-schema
  structured output.
- `/v1/completions` — OpenAI-compatible text completions.
- `/completion` — native llama.cpp completions endpoint.
- `/slots` — per-slot concurrency metrics.
- `/health` — liveness probe (what the supervisor polls).

See `packages/inference/src/providers/llama-cpp/provider.ts` for the client side.

## Platform backends

Unlike sd-server where we pick a single backend per platform, llama-cpp
ships **multiple variants per platform** and picks the right one at
runtime based on available hardware, providing CUDA + Vulkan + CPU coverage on
Windows and Linux.

| Platform       | Variants shipped              | Runtime selection                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------- |
| `darwin-arm64` | metal                         | Always Metal. No fallback needed — Apple Silicon always has Metal.   |
| `darwin-x64`   | cpu                           | CPU only. Intel Mac has no Metal path.                               |
| `linux-x64`    | cuda, rocm, vulkan, cpu       | Probe `libcuda.so.1` → `/dev/kfd` (AMD) → `libvulkan.so.1` → fallback CPU. |
| `linux-arm64`  | cuda, cpu                     | Probe `libcuda.so.1` → fallback CPU. (Vulkan deferred — LunarG ships no aarch64 SDK tarball.) |
| `win32-x64`    | cuda, rocm, vulkan, cpu       | Probe `nvml.dll` → AMD driver (`amdxc64.dll`) → `vulkan-1.dll` → fallback CPU. |

Runtime selection logic lives in
`packages/app/src/supervisor/llama-backend.ts`. The chosen
variant is cached at `~/.gezel/engines/llama-cpp/backend.json` so we
don't re-probe every boot; the cache invalidates whenever the engine's
`VERSION` changes (the cache file records the version it was resolved
against).

**Why CUDA + Vulkan both** — Vulkan is broadly compatible but CUDA is
measurably faster on NVIDIA. Shipping both lets NVIDIA users get full
speed and non-NVIDIA users still get GPU acceleration from one build.

### AMD GPUs (Radeon, Instinct)

AMD GPUs get the **ROCm** build where it has code for them and the
**Vulkan** build everywhere else, in the same ladder as NVIDIA's: ROCm →
Vulkan → CPU.

**Why ROCm.** Measured on a Radeon AI PRO R9700 (RDNA4, gfx1201) at v0.9.0
against the Vulkan build, flash attention on, ubatch 512: ROCm reads prompts
35-45% faster on Qwen3.8-27B and 27-39% faster on Gemma 4 31B (+117% at a
16k-token depth, where Vulkan's prefill collapses), and generates 5% slower
on the 27B and 8-12% slower on the 31B. Whole turns favor ROCm on the large
dense models (a cold 12k-token turn finishes ~12% sooner on the 27B; a
cached tool step is about even). On the 4B and 9B models generation is
11-17% slower and prefill gains are small. No runtime switch or open
upstream patch closed the generation gap (graph options, fusion, kernel-arg
placement, KV type, PR #24386 were all measured). The older "Vulkan ~25%
faster" figure was about generation alone.

**What ships.** `linux-x64-rocm` and `win32-x64-rocm`, built against AMD's
pip-distributed ROCm 10.0 (TheRock) and self-contained like the CUDA
variants: the HIP runtime, hipBLAS/rocBLAS and their dependencies, and
rocBLAS's kernels for each target, so a user needs only the AMD display
driver. The targets are `ROCM_GFX_TARGETS` in
`packages/core/src/native/rocm-devices.ts`: RDNA3 (gfx1100-1102), the
780M/760M iGPUs (gfx1103), Strix Point and Strix Halo (gfx1150, gfx1151),
and RDNA4 (gfx1200, gfx1201). Each target costs ~60 MB on disk, so older
parts (RDNA2, Vega) stay on Vulkan, which serves them well.

**How it is chosen.** An AMD driver alone does not mean ROCm will work: the
build carries kernels for a fixed list of architectures, and the HIP runtime
enumerates every AMD GPU regardless. So the backend probe's `rocm` is only a
preference. Discovery then runs the ROCm build's `--list-devices` once per
build and driver (`rocm-devices.ts`, cached at
`<home>/engines/llama-cpp/rocm-devices.json`). ggml prints each GPU's
architecture there, and the build is chosen only if one of them is in its
`rocmTargets`. Otherwise it is passed over for Vulkan before anything
launches, with no three-crash quarantine needed. When a supported card sits
beside an unsupported one (every Ryzen 7000/9000 desktop has a small RDNA2
iGPU, which ROCm reports as an ordinary GPU), the launch hides the
unsupported one with `HIP_VISIBLE_DEVICES`.

**Payload notes.**

- rocBLAS loads its kernels from `rocblas/library/` beside itself, and from
  per-architecture kernel packs that it expects at `../.kpack/`, outside the
  variant directory. The packs ship in `kpack/` and the launch names them
  through `ROCM_KPACK_PATH_PREFIX`.
- AMD's packs also hold rocSOLVER's and rocSPARSE's kernels (41 MB per
  target, already zstd-compressed). `scripts/trim-rocm-kpack.mjs` keeps
  rocBLAS's and hipBLASLt's (~5 MB) and copies every kernel byte for byte.
- hipBLASLt's own kernel library (~170 MB per target) is not bundled; the
  launch sets `ROCBLAS_USE_HIPBLASLT=0`, which cost ~3.5% prompt reading on
  the R9700.

**Building it.**

- Windows builds `ggml-hip.dll` in a second configure with ROCm's clang, as
  upstream's win-rocm release does, and needs Visual Studio 2022 (MSVC
  14.4x): VS 2026's `<cmath>` clashes with HIP's device declarations.
  `LLAMA_HIP_MSVC_INCLUDE` points a local VS 2026 build at a patched header
  copy instead.
- On Linux, AMD's comgr links LLVM dynamically and hipBLASLt links
  rocRoller, so the Linux variant is roughly twice the size of the Windows
  one.

## Build locally

```sh
# macOS or Linux — defaults to Metal (Mac) / CUDA-or-Vulkan-or-CPU (Linux)
./build.sh

# Override backend:
LLAMA_BACKEND=vulkan ./build.sh
LLAMA_BACKEND=cpu ./build.sh

# Windows (PowerShell)
pwsh -File .\build.ps1
$env:LLAMA_BACKEND='cpu'; pwsh -File .\build.ps1
```

Output lands at `native/build/<platform>/gezel-llama-server[.exe]` by default.
When building multiple variants on the same platform, set
`LLAMA_BACKEND_TAG=1` so the output directory is suffixed:
`native/build/linux-x64-cuda/gezel-llama-server`, etc. The release matrix
uses this.

### Prerequisites

- `git`, `cmake` ≥ 3.24, a C/C++ toolchain (Xcode CLI / gcc / MSVC Build Tools).
- **CUDA backend**: CUDA Toolkit 12.x (`nvcc` on PATH). Linux: `apt
  install nvidia-cuda-toolkit` or the CUDA Network Repo. Windows: the
  NVIDIA installer.
- **Vulkan backend**: Vulkan SDK. Linux apt: `libvulkan-dev
  glslang-tools`. Fedora: `vulkan-devel`. Windows: LunarG installer
  (sets `VULKAN_SDK` env var).
- **ROCm backend** (x64 only): AMD's ROCm SDK wheels in a venv, then
  `rocm-sdk init` and `ROCM_PATH`/`HIP_PATH=$(rocm-sdk path --root)`:

  ```sh
  python -m venv rocm-sdk
  rocm-sdk/bin/pip install -r native/scripts/rocm-sdk-build-requirements.txt
  rocm-sdk/bin/pip install --require-hashes --no-deps --no-build-isolation \
    --index-url https://stable.repo.amd.com/rocm/whl-next/ \
    -r native/scripts/rocm-sdk-requirements.txt
  rocm-sdk/bin/rocm-sdk init
  export ROCM_PATH="$(rocm-sdk/bin/rocm-sdk path --root)"
  LLAMA_BACKEND=rocm ./build.sh
  ```

  `LLAMA_ROCM_TARGETS` (semicolon-separated) narrows the target list for a
  faster local build.
- **macOS**: nothing extra — Metal is part of the OS SDK.

### What the script does

1. Ensures `.upstream/` exists and is pinned to `VERSION`'s `commit`.
2. Resolves the platform and accelerator.
3. Runs `cmake` with `-DLLAMA_BUILD_SERVER=ON -DLLAMA_CURL=OFF
   -DGGML_<BACKEND>=ON`.
4. Builds the `llama-server` target.
5. On CUDA builds, bundles the CUDA runtime libraries (`cudart`,
   `cublas`, `cublasLt`) alongside the server so it runs on machines
   without the matching CUDA toolkit installed. The NVIDIA driver
   library is still supplied by the user's system.
6. Copies to `native/build/<platform>[-<backend>]/`.

Linux Vulkan builds also bundle `libvulkan.so.1` directly in the variant
archive. The runtime downloader fetches one archive at a time, so the loader
in the image engine's bare archive cannot serve this variant. The build and
CI verify that `libggml-vulkan.so` resolves the bundled loader with
`LD_LIBRARY_PATH` cleared. GPU drivers and their Vulkan ICDs remain host
requirements.

## Verifying a build

```sh
./native/build/<platform>/gezel-llama-server --help
```

Expected: the upstream help text listing the server's flags. If you see
a dynamic-linker error about `libcuda.so.1` / `cudart64_*.dll` or
`libvulkan.so.1` / `vulkan-1.dll`, the build linked against a backend
the runtime host doesn't support — rebuild with `LLAMA_BACKEND=cpu`
for validation, then investigate.

To smoke-test end-to-end against a GGUF model:

```sh
./native/build/<platform>/gezel-llama-server \
  --model /path/to/model.gguf \
  --host 127.0.0.1 --port 8080 \
  --jinja \
  -c 4096

# in another terminal
curl -sS http://127.0.0.1:8080/health
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"x","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

`--jinja` enables Jinja chat-template rendering from the GGUF's
`tokenizer.chat_template` metadata. Without it, llama-server falls back
to a generic template that may not match the model's training format,
producing bad output silently.

## Why a single binary per backend (not one fat binary)

llama.cpp's build graph makes per-backend builds produce sharply
different binaries — different ggml backends are compiled in, runtime
linkage against different GPU libraries, different supported quantizations
enabled. A single "try CUDA, fall back to Vulkan, fall back to CPU"
binary would require runtime dlopen of each backend's library, which
upstream supports for ggml via `GGML_BACKEND_DL=ON` but isn't the
well-trodden path. Shipping N thin binaries and choosing at launch
inherits fewer unknowns.

If fatter "one binary per platform" becomes worth building later, the
generalized supervisor at `packages/service/src/providers/image/supervisor.ts`
(soon to be `NativeEngineSupervisor`) doesn't care — backend selection
would move from "which binary to spawn" to "which arg to pass."

## License

MIT (inherits from upstream). When bundling GGUF weights, respect the
model's own license terms separately.

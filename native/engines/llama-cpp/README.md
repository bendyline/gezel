# llama.cpp

Upstream: https://github.com/ggml-org/llama.cpp — MIT licensed.

This directory **does not vendor upstream source**. The build scripts
clone it at the pinned commit (see `VERSION`) into `.upstream/`
(gitignored) and build with CMake.

Status: **integrated**. The pinned source is built by the native release
matrix, selected by the desktop supervisor, and served through the local-model
provider. `VERSION` is the source of truth for the upstream revision.

## Produced binary

`llama-server` — the HTTP server upstream ships. It speaks:

- `/v1/chat/completions` — OpenAI-compatible chat with streaming SSE,
  tool/function calling (requires `--jinja`), and JSON-schema
  structured output.
- `/v1/completions` — OpenAI-compatible text completions.
- `/completion` — native llama.cpp completions endpoint.
- `/slots` — per-slot concurrency metrics.
- `/health` — liveness probe (what the supervisor polls).

See `packages/service/src/providers/llama-cpp/provider.ts` for the client side.

## Platform backends

Unlike sd-server where we pick a single backend per platform, llama-cpp
ships **multiple variants per platform** and picks the right one at
runtime based on available hardware, providing CUDA + Vulkan + CPU coverage on
Windows and Linux.

| Platform       | Variants shipped              | Runtime selection                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------- |
| `darwin-arm64` | metal                         | Always Metal. No fallback needed — Apple Silicon always has Metal.   |
| `darwin-x64`   | cpu                           | CPU only. Intel Mac has no Metal path.                               |
| `linux-x64`    | cuda, vulkan, cpu             | Probe `libcuda.so.1` → `libvulkan.so.1` → fallback CPU.              |
| `linux-arm64`  | cuda, cpu                     | Probe `libcuda.so.1` → fallback CPU. (Vulkan deferred — LunarG ships no aarch64 SDK tarball.) |
| `win32-x64`    | cuda, vulkan, cpu             | Probe `nvml.dll` → `vulkan-1.dll` → fallback CPU.                    |

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

AMD GPUs are accelerated via the **Vulkan** backend. The runtime probe
in `packages/app/src/supervisor/llama-backend.ts` recognizes AMD
Radeon hardware (PCI vendor ID `0x1002` on Linux, AMD Adrenalin /
Radeon driver DLLs in `System32` on Windows) and surfaces it as a
vendor hint so the UI can label the engine "AMD GPU" rather than the
generic "GPU" — but the backend pick is still Vulkan, not a dedicated
ROCm/HIP variant.

This is intentional. Recent benchmarks (Phoronix, ROCm 7.1 vs Mesa
RADV Vulkan on RX 7900 XTX, llama 7B Q4_0) show **Vulkan ~25% faster
than ROCm for token generation** — ~170 tok/s vs ~140 tok/s — with
ROCm winning only on prompt processing. For the chat workloads that
dominate Gezel usage, Vulkan is the better default. ROCm also requires
the AMD HIP runtime to be installed on the user's machine (~2 GB on
Windows, separate `amdgpu-install --usecase=hiplibsdk` on Linux),
which is a significant friction cost we'd absorb on the wrong cohort.

A dedicated ROCm/HIP variant could be added later — the architecture
is already extensible (single new entry in the build matrix, single new
arm in `build.sh`/`build.ps1`'s backend switch, single new probe step
in `llama-backend.ts`) — but only when there's evidence it's worth the
build-matrix cost and the user-side install friction. Most likely
trigger: a user with a heavy prompt-processing workload (long-context
summarization, batch inference) where Vulkan bottlenecks them.

Architectures known to work well via Vulkan: RDNA2 (RX 6000), RDNA3
(RX 7000, gfx1100), RDNA4 (RX 9000, gfx1201), Instinct MI200/MI300
series. Older GCN cards (Vega, Polaris) work too but with reduced
shader-int8 perf.

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

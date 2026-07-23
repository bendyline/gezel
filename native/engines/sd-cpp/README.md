# stable-diffusion.cpp

Upstream: https://github.com/leejet/stable-diffusion.cpp — MIT licensed.

This directory **does not vendor upstream source**. The build scripts
clone it at the pinned commit (see `VERSION`) into
`.upstream/` (gitignored) and build with CMake.

## Produced binary

`sd-server` — the HTTP server wrapper upstream ships. It speaks an
OpenAI-compatible `/v1/images/generations` shape plus a `/health`
endpoint that the supervisor probes. See
`packages/service/src/providers/image/sd-cpp.ts` for the client side.

## Platform backends

| Platform       | Acceleration            | Notes                                              |
| -------------- | ----------------------- | -------------------------------------------------- |
| `darwin-arm64` | Metal                   | `-DSD_METAL=ON`. "Just works" on Apple Silicon.    |
| `darwin-x64`   | CPU (AVX2 / Accelerate) | No GPU path — Metal requires Apple Silicon.        |
| `linux-x64`    | CUDA → Vulkan → CPU     | Autodetected in that order, matching llama-cpp's build.sh. CI runners have neither nvcc nor vulkaninfo, so shipped binaries stay Vulkan/CPU. |
| `linux-arm64`  | CUDA → Vulkan → CPU     | Same autodetect. Jetson / DGX-style hosts with the CUDA toolkit on PATH get `-DSD_CUDA=ON` automatically; Vulkan stays moot here (LunarG ships no aarch64 SDK tarball). |
| `win32-x64`    | Vulkan (fallback: CPU)  | Broadly compatible default.                        |

We ship **Vulkan/CPU** binaries rather than CUDA because Vulkan is
driver-independent and ships with nearly every modern GPU. CUDA gives
better throughput on NVIDIA but requires the CUDA toolkit at runtime,
which is a non-starter for a drop-in installer. Local rebuilds on
hosts with `nvcc` on PATH pick CUDA automatically — this matters: the
CPU build renders SDXL at ~35 s/step, so even a 4-step distilled
render takes ~4 minutes and blows through chat-turn latency budgets.
Override with `SD_BACKEND={metal,vulkan,cuda,cpu}`.

## Build locally

```sh
# macOS or Linux
./build.sh

# Windows (PowerShell)
pwsh -File .\build.ps1
```

Output lands at `native/build/<platform>/gezel-sd-server[.exe]`.

### Prerequisites

- `git`, `cmake` ≥ 3.18, a C/C++ toolchain (Xcode CLI / gcc / MSVC
  Build Tools).
- Linux + Windows Vulkan backend: Vulkan SDK installed. Apt:
  `libvulkan-dev glslang-tools`. Fedora: `vulkan-devel`.
- macOS: nothing extra — Metal is part of the OS SDK.

### What the script does

1. Ensures `.upstream/` exists and is pinned to `VERSION`'s `commit`.
2. Runs `cmake -S .upstream -B .upstream/build-<platform> -DSD_SERVER=ON -DSD_<BACKEND>=ON`.
3. Builds the `sd-server` target.
4. Copies the produced binary to `native/build/<platform>/`.

CI runs the same script on each platform runner — there is exactly one
code path.

## Verifying a build

Smoke-test the binary without hitting a real model:

```sh
./native/build/<platform>/gezel-sd-server --help
```

Expected: the upstream help text. Anything else (dynamic-linker error,
"can't find dylib", crash) means the build didn't pick up its
dependencies correctly — usually a missing Vulkan loader on
Linux/Windows.

## Signing

The binaries this directory produces are **unsigned**. They become
signed when electron-builder includes them in the app installer —
Apple `codesign` signs every Mach-O inside the `.app`, and
Windows signtool signs every PE inside the NSIS payload.

For standalone distribution (e.g. someone wanting the binary without
the full Gezel app), the `.github/workflows/release-native.yml`
pipeline can optionally sign using the same cert secrets as the
Electron release. See that file for the gated sign steps.

## License

MIT (inherits from upstream). Record the license string in any
manifest referencing this binary.

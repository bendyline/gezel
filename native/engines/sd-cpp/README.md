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
| `linux-x64`    | Vulkan                  | Ships Vulkan (`sd_backend: vulkan` in the build matrix). Local builds autodetect CUDA → Vulkan → CPU. |
| `linux-arm64`  | CPU                     | Ships CPU (`sd_backend: cpu`) — LunarG publishes no aarch64 SDK tarball. Local builds on Jetson / DGX-style hosts with `nvcc` on PATH pick CUDA automatically. |
| `win32-x64`    | Vulkan                  | Ships Vulkan (`sd_backend: vulkan`).                |

The shipped backend is **pinned per matrix row** in
`.github/workflows/build-native.yml`, not autodetected. `build.sh`'s
`auto` path infers the backend from `command -v vulkaninfo`, which would
otherwise couple the shipped artifact to whether the Vulkan SDK install
step happened to run on that runner — native-v0.1.18 shipped a
Vulkan-linked `linux-x64` binary that way while this table still claimed
otherwise. Changing a shipped backend means editing the matrix.

We ship **Vulkan/CPU** binaries rather than CUDA because Vulkan is
driver-independent and ships with nearly every modern GPU. CUDA gives
better throughput on NVIDIA but requires the CUDA toolkit at runtime,
which is a non-starter for a drop-in installer. Local rebuilds on
hosts with `nvcc` on PATH pick CUDA automatically — this matters: the
CPU build renders SDXL at ~35 s/step, so even a 4-step distilled
render takes ~4 minutes and blows through chat-turn latency budgets.
Override with `SD_BACKEND={metal,vulkan,cuda,cpu}`.

## Runtime requirements

The Vulkan-linked binaries (`linux-x64`, `win32-x64`) name the Vulkan
**loader** in their dynamic-import table: `libvulkan.so.1` on Linux,
`vulkan-1.dll` on Windows. That is a load-time dependency, not a
`dlopen` — if the loader is absent the process dies in the dynamic
linker before `main()`, so sd.cpp never reaches its own fallback.

Everything downstream of the loader *does* degrade gracefully. With the
loader present but no usable device, sd.cpp logs and drops to
`Using CPU backend`; `GGML_DISABLE_VULKAN=1` forces that path
explicitly. So the loader's presence is the single hard requirement.

| Platform | Provided by | Risk |
| --- | --- | --- |
| `win32-x64` | Every GPU driver installs `vulkan-1.dll` into `System32` | Low |
| `linux-x64` | The `libvulkan1` package (Debian/Ubuntu) or `vulkan-loader` (Fedora) | Present on mainstream desktop installs; **absent** on minimal/server images, some containers, and WSL without a GPU stack |

CI cannot catch a missing loader: the `ldd` smoke check runs on a runner
where the Vulkan SDK was just installed, so it always resolves there.

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

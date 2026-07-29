# Native engine runtime requirements

What a user's machine must already provide for gezel's bundled local
engines (`gezel-llama-server`, `gezel-sd-server`, `gezel-whisper-server`,
`gezel-ds4-server`) to start. Everything here is a **load-time**
requirement: when it is unmet the dynamic linker kills the process before
`main()`, so the engine never gets to print a useful error — the user just
sees a model that will not start.

Cloud providers (Copilot, OpenAI, Anthropic) need none of this. Only
on-device inference is affected.

CI cannot discover any of these on its own. Every runner has a full
toolchain installed, so `ldd` and the `--help` smoke probe always resolve
there and only fail on a user's machine. The guards named below exist
because of that blind spot.

## Linux — glibc / libstdc++ floor

Our binaries currently require **`GLIBC_2.38`** and **`GLIBCXX_3.4.32`**.

| Distro | glibc | Runs today? |
| --- | --- | --- |
| Ubuntu 24.04 LTS | 2.39 | yes |
| Debian 13 (trixie) | 2.41 | yes |
| Fedora 39+ | 2.38 | yes |
| **Ubuntu 22.04 LTS** (supported to 2027) | 2.35 | **no** |
| **Debian 12 (bookworm)** | 2.36 | **no** |
| **RHEL 9** (supported to 2032) | 2.34 | **no** |

Nothing in the code needs those versions. The floor is toolchain leakage
from building on `ubuntu-24.04` runners, and it is remarkably small:

- `GLIBC_2.38` comes from exactly four symbols — `__isoc23_strtol`,
  `__isoc23_strtoll`, `__isoc23_strtoul`, `__isoc23_strtoull` — the C23
  redirects glibc 2.38's `stdlib.h` applies to the `strtol` family.
- `GLIBCXX_3.4.32` comes from exactly one — `_ZSt21ios_base_library_initv`,
  which GCC 13's `<iostream>` emits into any translation unit that
  includes it.

For contrast, NVIDIA builds the CUDA redistributables we ship alongside
these against `GLIBC_2.17`. The vendor libraries are not the constraint;
we are.

**Lowering it means building against older glibc headers** — a build
container (the manylinux approach) or an older runner image — not changing
any source. Static-linking libstdc++ is *not* a fix here: the engine's
shared libraries exchange C++ objects across their boundaries, so each
getting a private libstdc++ would mean separate `std::string` vtables and
exception type_info, exactly the hazard that rules out a static CRT on
Windows. It also would not touch the glibc floor.

The floor is declared as `LINUX_MAX_GLIBC` / `LINUX_MAX_GLIBCXX` in
[`build-native.yml`](../.github/workflows/build-native.yml) and asserted
per build by the "Assert Linux symbol-version floor" step, so it can only
move deliberately. Those values are the status quo, not a target — lower
them when the build environment allows.

## Linux — Vulkan loader

`gezel-sd-server` on `linux-x64` is built with the Vulkan backend and
names `libvulkan.so.1` in `DT_NEEDED`. We bundle the loader beside the
binary (Apache-2.0, see [`NOTICE.md`](../NOTICE.md)), so there is no
requirement on the user's machine beyond a working GPU driver. With the
loader present but no usable device, sd.cpp drops to `Using CPU backend`
on its own; `GGML_DISABLE_VULKAN=1` forces that path.

`linux-arm64` ships the CPU build — LunarG publishes no aarch64 SDK
tarball.

## Windows — Visual C++ runtime

Every engine DLL imports `MSVCP140.dll`, `VCRUNTIME140.dll` and
`VCRUNTIME140_1.dll` from the Microsoft Visual C++ 2015–2022
Redistributable, which is not a Windows component. The NSIS installer
provisions it during `customInstall` (see
[`nsis-hooks.nsh`](../packages/app/installer/nsis-hooks.nsh)); the check is
best-effort, so a failure warns rather than aborting the install and only
local models are affected.

`vulkan-1.dll` is also imported by `gezel-sd-server.exe`, but every GPU
driver installs it into `System32`, so it is not provisioned.

## macOS

The bundled native engines require **macOS 13.3 Ventura or newer**. Electron
requires macOS 13+, and ggml's Accelerate backend uses the ILP64 BLAS/LAPACK
interface introduced in macOS 13.3. The floor is declared as
`MACOSX_DEPLOYMENT_TARGET` in `build-native.yml`, passed explicitly through the
engine build wrappers, and asserted from every shipped Mach-O
`LC_BUILD_VERSION` before signing. This prevents a newer `macos-latest` runner
or Xcode SDK from silently narrowing compatibility.

There are no external runtime requirements beyond that OS floor. Metal is part
of the OS, the engines link only system frameworks plus their own bundled
dylibs, and AppleClang links no OpenMP runtime.

## What we deliberately do not depend on

- **OpenMP** — engines build with `-DGGML_OPENMP=OFF`, so nothing needs
  `libgomp.so.1` or `VCOMP140.DLL`. ggml's native threadpool covers it.
- **OpenSSL** — engines build with `-DLLAMA_OPENSSL=OFF`. gezel speaks
  plain HTTP to the engine on loopback; the daemon's own TLS is a separate
  layer.
- **CUDA toolkit** — the CUDA runtime libraries travel in the `-cuda`
  bundles. Only the NVIDIA *driver* (`libcuda.so.1` / `nvcuda.dll`) must
  be present, and it is never redistributable.

Each of those is enforced by a guard in `build-native.yml` so it cannot
silently come back.

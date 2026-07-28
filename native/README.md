# Gezel native code

All platform-specific native code that ships with Gezel lives here: pinned
upstream inference engines and small first-party helpers such as the device
health telemetry adapter.

## Why a separate top-level directory

`packages/` is the pnpm workspace and every entry there is a JS / TS
package with a `package.json`. Native code doesn't fit that shape — it's
built with CMake, produces per-platform binaries, and doesn't get
published to npm. Keeping it a sibling of `packages/` makes the
distinction clear and gives the build pipelines one obvious place to
look.

## Layout

```
native/
├── README.md                   # this file
├── engines/
│   └── <engine>/
│       ├── VERSION             # pinned upstream commit + tag
│       ├── README.md
│       └── build.{sh,ps1}
├── helpers/
│   ├── device-health/          # first-party Windows/Linux telemetry helper
│   │   ├── CMakeLists.txt
│   │   ├── README.md
│   │   └── build.{sh,ps1}
│   └── service-host/           # first-party Windows service host (GezelService)
│       ├── CMakeLists.txt
│       ├── README.md
│       └── build.ps1
├── scripts/
│   ├── fetch-upstream.sh       # clone + pin a single engine's upstream repo
│   └── bundle.sh               # assemble per-platform binaries into packages/app/native-bin/
└── build/                      # generated per-platform staging tree
```

Each engine directory is self-contained: a pinned upstream reference, a
platform-specific build script, and a README. The shared `scripts/`
contains helpers that are generic across engines.

## Delivery shape (per platform)

Every engine and helper emits into the same canonical tree, keyed by
platform and — for engines that ship more than one GPU backend — variant:

```
native/build/<platform>/            # single-backend engines + helpers
├── gezel-device-health[.exe]       # win32-x64, linux-x64, linux-arm64
├── gezel-service-host.exe          # win32-x64 only
├── gezel-sd-server[.exe]
├── gezel-whisper-server[.exe]
├── gezel-ds4-server                # darwin-arm64 + linux-* (GPU-only)
├── uv[.exe]
└── THIRD_PARTY_LICENSES/           # staged per artifact before upload

native/build/<platform>-<variant>/  # multi-backend engines (llama-cpp)
├── gezel-llama-server[.exe]
├── libggml-<variant>.<so|dylib|dll>   # dlopened at model load
└── THIRD_PARTY_LICENSES/
```

Where `<platform>` is one of:

- `darwin-arm64` — Apple Silicon Mac
- `linux-x64`
- `linux-arm64` — Jetson, DGX Spark / Grace Hopper, Ampere Altra, Raspberry Pi 5 64-bit, etc.
- `win32-x64`

and `<variant>` is `metal` (macOS), or `cpu` / `vulkan` / `cuda`
(Windows and Linux; no `vulkan` on `linux-arm64` — LunarG ships no
aarch64 SDK tarball). Intel Mac (`darwin-x64`) is not built: on-device
first-run routes those users to Copilot/OpenAI.

**Which binaries a given platform key must contain is a contract, not a
convention** — it lives in [`scripts/native-payload.mjs`](../scripts/native-payload.mjs)
and is enforced by `scripts/check-native-payload.mjs` on both sides of the
handoff (the tagged native build before it packs archives, the Electron
release after it stages them). Add an engine to the build matrix and to
that table in the same change, or the tagged build fails loudly instead of
shipping an installer with a hole in it.

`scripts/fetch-native-binaries.mjs` pulls the published archives into
`packages/app/native-bin/<platform>[-<variant>]/`, which is the one path
that dev `pnpm app`, local `pnpm package:*`, and the release workflow all
consume. electron-builder ships that tree through its `files:` +
`asarUnpack:` globs, so at runtime it lands at
`<AppResources>/app.asar.unpacked/native-bin/<platform>[-<variant>]/`.
The Electron main process resolves it via
[`nativeBinDir`](../packages/app/src/supervisor/native-bin.ts) and exports
absolute paths to the service through `GEZEL_NATIVE_BIN_DIR`,
`GEZEL_LLAMA_SERVER_BIN`, `GEZEL_SD_SERVER_BIN`, `GEZEL_WHISPER_SERVER_BIN`,
`GEZEL_DS4_SERVER_BIN`, `GEZEL_UV_BIN`, and `GEZEL_DEVICE_HEALTH_BIN` (the
last points the service's device safety probe at the bundled helper).

## "Uber dll" aspiration

Today we ship **one binary per engine** — `llama-server`, `sd-server`,
`whisper-server`, `ds4-server`, later `piper`. They share this directory,
share the CI pipeline, share the at-birth signing step in the native build
matrix, and ship together inside one Electron installer. That is the
pragmatic "uber native" — all native code in one place, one release
surface, one signing pass.

A true single fat binary (`gezel-native sd-server …`) is possible
later if it earns its keep. It requires:

1. Building each engine as a library rather than an executable. Upstream
   projects like `stable-diffusion.cpp` and `whisper.cpp` already expose
   library targets; `sd-server` / `whisper-server` today are thin
   wrappers we could replicate.
2. A small C++ dispatcher that `dlopen`s / links the right engine
   library and forwards `argv`.
3. Reconciling `ggml` versions across engines (most big risk — each
   upstream may pin a different one).

The directory layout here doesn't block that evolution: when we decide
to go monolithic, the wrapper source lives at `native/dispatcher/`, its
CMakeLists pulls in each engine's library target, and the
platform-matrix CI workflow builds one binary instead of N. Nothing
else about the pipeline has to change.

A **true N-API module** (load each engine into the Node process directly
as a dynamic library, skip subprocesses entirely) is a further step —
bigger integration win but much bigger implementation cost. Not for
now.

## Adding a new engine

1. `mkdir native/engines/<name>/` — copy the shape of `sd-cpp/`.
2. Write `VERSION` pinning an upstream commit + tag.
3. Write `build.sh` (POSIX) and `build.ps1` (Windows) that invoke the
   engine's own CMake and emit a single binary into
   `native/build/<platform>/<binary-name>`.
4. Add an entry to `.github/workflows/build-native.yml`'s matrix so
   the new engine is built on each supported platform.
5. Teach `packages/service/src/providers/image/factory.ts` (or the
   equivalent provider for STT/TTS) to look for the new binary.
6. Add `<binary-name>` to the electron-builder `extraResources`
   glob so the installer picks it up.

That is the entire checklist. No changes to the app, the service
bootstrap, or the supervisor shape are required — each engine reuses
`ImageEngineSupervisor` (or analogous) with its own `resolveLaunch()`.

## Adding a first-party helper

Put self-contained source and build scripts under `native/helpers/<name>/`,
add `kind: helper` rows to the native build matrix, and add the logical binary
name plus environment variable to `packages/core/src/native/discover.ts`.
Helpers do not use an upstream `VERSION` file, but otherwise share platform
archives, signing, fetch, and Electron packaging with the engines.

## Local development

Running the full cross-platform matrix locally is painful. For
day-to-day iteration on a single engine:

```sh
# macOS / Linux
./native/engines/sd-cpp/build.sh

# Windows (PowerShell)
pwsh -File .\native\engines\sd-cpp\build.ps1
```

Each script clones upstream at the pinned commit into
`native/engines/sd-cpp/.upstream/`, configures with the platform's
preferred backend (Metal on Mac, CUDA/Vulkan on Linux+Win when the
toolchain is present, CPU otherwise), builds, and drops the output
at `native/build/<platform>/sd-server[.exe]`.

Point Gezel at your local build via:

```sh
export GEZEL_SD_SERVER_BIN=$PWD/native/build/darwin-arm64/sd-server
pnpm app
```

## CI pipelines

`.github/workflows/build-native.yml` matrix-builds engines and helpers,
uploads artifacts, and aggregates tagged runs into a **draft** native
release. It runs on tag push (`native-vX.Y.Z`, via
`scripts/cut-native-release.mjs`) or manual dispatch (build-only, no
draft). Before creating the draft, the workflow validates the exact
production archive set and verifies every archive against `SHA256SUMS`.
After inspecting and testing the draft, a maintainer publishes it
directly from the GitHub Releases UI.

### Integrity model

Binaries are **signed at birth** in the build matrix, immediately after
the smoke test and before hashing/upload, so every published hash covers
signed bytes:

- **Windows** — the engine executable is Authenticode-signed via Azure
  Trusted Signing, unless the "engine" is a prebuilt download (`uv`). Peer
  DLLs are left alone here and swept later by the Electron packaging hook.

  **We sign only what we compile.** Third-party binaries we redistribute
  verbatim — NVIDIA's cuBLAS/cudart, `uv.exe`, `node.exe` — are skipped
  by the sweep and exempted from the release's
  "Verify Windows signatures" gate, both reading the same list from
  [`packages/app/scripts/third-party-binaries.cjs`](../packages/app/scripts/third-party-binaries.cjs).
  They ship byte-identical to their upstream release, so a user can hash
  them against the vendor's own manifest. (Contrary to what this section
  used to say, NVIDIA's DLLs carry **no** signature when they arrive from
  `developer.download.nvidia.com` — so this is "leave them alone", not
  "preserve a vendor signature", except for `node.exe`.) The exemption is
  an explicit allowlist: a first-party DLL that failed to get signed still
  fails the release.
- **macOS** — every Mach-O in the bundle (engine executable and peer
  dylibs) is Developer ID-signed with `--options runtime` (hardened
  runtime), dylibs first, main binary last. This is the one place the
  sign-only-what-we-compile rule cannot apply: Apple's notary service
  rejects any executable that is not Developer ID signed, and vendors ship
  weaker signatures than that (`uv` for macOS is `adhoc, linker-signed`
  with no team identifier), so third-party Mach-Os get re-signed too. A post-sign `--help` probe
  re-runs the smoke contract so a hardened-runtime regression fails the
  job. If an engine ever needs JIT or dyld-env access, give it a
  per-engine entitlements plist — don't drop `--options runtime`.
- Signing steps no-op when secrets are absent (PRs, forks, dispatch
  test builds) — those binaries ship unsigned and are refused by the
  Electron release's verification (below).
- The draft-release job attaches **SLSA build-provenance attestations**
  to every archive and `SHA256SUMS`
  (`gh attestation verify <file> --repo bendyline/gezel`).

The Electron release workflow (`.github/workflows/release-electron.yml`)
consumes a **published** native release via
`scripts/fetch-native-binaries.mjs`, which verifies every archive
against the release's `SHA256SUMS` before extraction (the `--run`
artifact path verifies extracted engine binaries against the per-job
`<engine>.sha256` manifests instead). The workflow then re-verifies
code signatures on the staged binaries (`Get-AuthenticodeSignature` /
`codesign --verify --strict`), packages with electron-builder, and on
Windows runs the afterPack sweep
(`packages/app/scripts/after-pack.cjs`) that signs any exe/dll in the
payload still lacking a valid signature — covering our-built engine DLLs
while leaving upstream-signed
binaries byte-identical to the native release. Post-package
verification asserts the full payload validates on both platforms.

## License hygiene

Every upstream pinned or ABI definition adapted here must be permissively
licensed (Apache 2.0, MIT, BSD, or similar). Record it in the component README
or `THIRD_PARTY_NOTICES.md` and check transitive dependencies as well.

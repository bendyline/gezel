# sqlite-vec

Upstream: https://github.com/asg017/sqlite-vec — MIT OR Apache-2.0.

sqlite-vec is the SQLite extension behind every vector search gezel runs:
semantic code and document search in each project's content index, and
memory recall. The service loads it into its own process through
`node:sqlite` ([sqlite-driver.ts](../../../packages/service/src/index-store/sqlite-driver.ts)).
Without it the index still works, but vector search is off and memory recall
falls back to matching saved text.

The npm `sqlite-vec` package ships a prebuilt extension for every platform
gezel runs on except Windows ARM64, so this directory builds that one. It is
the only engine here that is a library rather than a program.

## Produced file

`vec0.dll`, in `native/build/win32-arm64/`. It keeps upstream's file name
instead of a `gezel-` prefix because SQLite derives an extension's entry
point from the letters of its file name: `vec0.dll` loads `sqlite3_vec_init`.

## How it is built

[build.ps1](build.ps1) downloads two archives pinned by sha256 in
[VERSION](VERSION): upstream's release amalgamation (`sqlite-vec.c` and
`sqlite-vec.h`, the source the npm prebuilds compile) and the SQLite
amalgamation upstream's release workflow takes its headers from. It then
compiles with MSVC through [CMakeLists.txt](CMakeLists.txt), as upstream's own
Windows build does with `cl /LD`:

- **MSVC, not clang.** The engines need clang on Windows-on-ARM only because
  ggml refuses MSVC there. This is plain C.
- **`/arch:armv8.0`**, the same explicit floor as the MSVC helpers, checked by
  `scripts/assert-arm64-baseline.mjs` in `msvc-baseline` mode.
- **Static C runtime.** The extension loads into whatever Node process runs
  the service, including npm and CLI installs where no installer ever put
  the ARM64 Visual C++ runtime on the machine, so a `/MD` build would fail to
  load on a clean Windows-on-ARM machine. CI fails the build if the DLL
  imports `VCRUNTIME*.DLL`.
- **Scalar code.** Upstream enables NEON only for Apple Silicon; its Linux
  ARM64 build is scalar too.
- **One source fix.** Upstream's MSVC-on-ARM fallback for
  `__builtin_popcountl` takes a 32-bit `unsigned int` but is called on
  64-bit words, so Hamming distance over bit vectors would ignore half of
  every word. build.ps1 widens the parameter and stops if the pattern is not
  found exactly once, so a version bump re-checks it. gezel's own indexes use
  float vectors and cosine distance, so this affects only callers that use
  bit vectors.

## Build and test locally

Needs Visual Studio 2022 Build Tools with the C++ workload and the ARM64
build tools, plus CMake on `PATH`:

```powershell
pwsh -File .\native\engines\sqlite-vec\build.ps1
node scripts\smoke-sqlite-vec.mjs native\build\win32-arm64\vec0.dll
```

The smoke test is what CI runs instead of `--help`: it loads the extension
into `node:sqlite`, checks its version and source commit against VERSION,
answers a cosine nearest-neighbor query, and measures Hamming distance over a
full 64-bit word. Node must be the extension's architecture.

To run the service's vector tests against a local build, point the driver at
it. These tests otherwise skip on Windows ARM64:

```powershell
$env:GEZEL_SQLITE_VEC_PATH = "$PWD\native\build\win32-arm64\vec0.dll"
pnpm --filter @bendyline/gezel-service exec vitest run src/memory src/index-store/retrieval-arms.test.ts src/index-store/content-enrich.test.ts
```

## How it reaches the service

The native release puts `vec0.dll` in the `win32-arm64` archive (from
native-v0.1.53, `FIRST_NATIVE_RELEASE_BINARY` in
[native-payload.mjs](../../../scripts/native-payload.mjs)). Native discovery
([discover.ts](../../../packages/core/src/native/discover.ts)) finds it under
`GEZEL_NATIVE_BIN_DIR/win32-arm64/` and stamps `GEZEL_SQLITE_VEC_PATH`, and
the sqlite driver tries that path before the npm package. That covers dev
checkouts (`packages/app/native-bin/`) and npm installs whose engine resolver
has already downloaded the `win32-arm64` archive. The desktop installers are
x64 only today and load npm's x64 prebuild under emulation.

## Bumping

Keep `tag` equal to the npm `sqlite-vec` version in
`packages/service/package.json`, so every platform runs the same extension.
The steps are at the top of [VERSION](VERSION); afterwards update
`native/licenses/manifest.json` and the NOTICE.md row.

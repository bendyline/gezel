/**
 * The contract between `.github/workflows/build-native.yml` (which builds
 * the engines) and everything downstream that consumes them:
 * `scripts/fetch-native-binaries.mjs`, `scripts/check-native-payload.mjs`,
 * and `.github/workflows/release-electron.yml`.
 *
 * One table, three consumers. Before this module the platform/variant
 * list lived in four places — the build matrix, the draft-release
 * archive-set gate, the Electron preflight asset list, and the fetch
 * script's `platformVariants()` — each with a comment asking the next
 * person to keep it in sync with the others. Adding whisper-cpp and ds4
 * proved that doesn't hold: an engine can be added to the matrix and
 * silently never reach an installer, because nothing downstream knows
 * to look for it.
 *
 * When you add an engine or a variant to the build matrix, add it here
 * in the same change. `check-native-payload.mjs` then fails the tagged
 * native build (rather than the user's first chat) if a leg was skipped.
 */

/**
 * Platform key → the engine binaries that key's archive must contain.
 *
 * Keys mirror `native/build/<platform>[-<variant>]/` on the build side and
 * `packages/app/native-bin/<platform>[-<variant>]/` on the consuming side.
 * Names are the base names the build scripts emit; `.exe` is appended for
 * `win32-*` keys by `expectedBinaries()`.
 *
 * Deliberate absences, all mirrored by matrix comments in build-native.yml:
 *   - no `darwin-x64` — Intel Mac is routed to cloud providers at first run
 *   - no `linux-arm64-vulkan` / `win32-arm64-vulkan` — LunarG ships no aarch64
 *     SDK for either OS (at the pinned version only the `-X64` Windows
 *     installer exists). Windows-on-ARM could in principle run the x64 SDK's
 *     `glslc` under emulation to cross-compile shaders, which Linux arm64
 *     cannot; that is a spike, not a plan.
 *   - no `win32-arm64` ds4 — ds4 is GPU-only and its Makefile build has no
 *     Windows path. The Adreno GPU path is OpenCL (upstream `docs/build.md`
 *     §"Windows Arm64"); the Hexagon NPU needs its op libraries inside a
 *     driver-signed `.cat`, so it is not shippable.
 *   - `win32-arm64-cuda` is for RTX Spark (NVIDIA N1X, the GB10 silicon of
 *     DGX Spark under Windows), which CUDA 13.4 first supports. It carries
 *     llama-server, sd-server and whisper-server with one copy of the arm64
 *     NVIDIA redistributables, the same sharing as the Linux `-cuda` keys.
 *     `llama-backend.ts` selects its llama-server when the NVIDIA driver is
 *     installed, and discovery its sd-server and whisper-server with it.
 *     whisper-server links ggml statically there: llama-server's ggml*.dll
 *     share the folder under the same names from a different ggml. The key
 *     first ships in the release named in FIRST_NATIVE_RELEASE below.
 *   - `gezel-device-health` is Windows + Linux only (macOS uses IOKit in-process)
 *   - `gezel-service-host` is Windows only (macOS/Linux use launchd/systemd)
 *   - no `duckdb` — the DuckDB CLI is vendored unmodified from the DuckDB
 *     Foundation's own signed + notarized release, so it is a bundled runtime
 *     beside node and pnpm (`packages/app/scripts/fetch-duckdb.mjs`, pinned in
 *     `packages/core/src/native/duckdb-pin.ts`) rather than an artifact of
 *     this pipeline. Building it here would have meant re-signing it on macOS,
 *     replacing the vendor's attestation with ours.
 *   - `gezel-sd-server` appears TWICE per Linux arch, and that is the point:
 *     the bare key holds the portable build (Vulkan on x64, CPU on arm64) and
 *     the `-cuda` key holds a CUDA build for hosts that can run it. Unlike
 *     llama-server, sd-cpp is not variant-keyed per backend, so before this
 *     there was exactly one slot per platform and it had to be spent on the
 *     build that runs everywhere. That left image generation on CPU on the
 *     ARM boxes with the most capable GPUs (DGX Spark, Jetson): SDXL there is
 *     slow enough that the petshop eval's bounded repair allowance expires
 *     before a render lands, and — because the allowance is attempt-based —
 *     it fails FAST models while slow ones idle long enough to survive.
 *     The CUDA build rides the `-cuda` key rather than a key of its own for
 *     the same reason ds4 does: one copy of the NVIDIA redistributables.
 *     Picking between the two is a genuine host capability choice, so it is
 *     NOT in `impliedEngineVariant` — the caller probes and decides.
 *   - `vec0.dll` (sqlite-vec) ships for `win32-arm64` only. It is a SQLite
 *     extension the service loads in-process, and npm's `sqlite-vec` has a
 *     prebuild for every other platform. It is named with its extension
 *     because it is a library, and keeps upstream's `vec0` stem because
 *     SQLite derives the extension's entry point from the file name.
 *   - `gezel-ds4-server` is GPU-only: darwin-arm64 Metal + Linux CUDA. On
 *     Linux it lives in the `-cuda` key, NOT the bare one, because it and
 *     llama-server's CUDA build need the same NVIDIA redistributables.
 *     Keying it separately shipped `libcublasLt.so` (717 MB) and
 *     `libcublas.so` (111 MB) twice per arch — 828 MB of byte-identical
 *     duplication on x64, 781 MB on arm64. Co-locating them means one copy
 *     serves both, with no change to the `$ORIGIN` rpath and no loss of the
 *     per-archive self-containment the runtime engine resolver depends on
 *     (it downloads exactly one archive per request; a shared sibling
 *     directory would have broken it). macOS ds4 is Metal and stays in the
 *     bare `darwin-arm64` key.
 */
export const NATIVE_PAYLOAD = Object.freeze({
  'win32-x64': [
    'gezel-device-health',
    'gezel-service-host',
    'gezel-sd-server',
    'gezel-whisper-server',
    'uv',
  ],
  'win32-x64-cpu': ['gezel-llama-server'],
  'win32-x64-vulkan': ['gezel-llama-server'],
  'win32-x64-cuda': ['gezel-llama-server'],
  'win32-arm64': [
    'gezel-device-health',
    'gezel-service-host',
    'gezel-sd-server',
    'gezel-whisper-server',
    'uv',
    'vec0.dll',
  ],
  'win32-arm64-cpu': ['gezel-llama-server'],
  'win32-arm64-cuda': ['gezel-llama-server', 'gezel-sd-server', 'gezel-whisper-server'],
  'darwin-arm64': [
    'gezel-sd-server',
    'gezel-ds4-server',
    'gezel-whisper-server',
    'gezel-apple-fm',
    'uv',
  ],
  'darwin-arm64-metal': ['gezel-llama-server'],
  'linux-x64': ['gezel-device-health', 'gezel-sd-server', 'gezel-whisper-server', 'uv'],
  'linux-x64-cpu': ['gezel-llama-server'],
  'linux-x64-vulkan': ['gezel-llama-server'],
  'linux-x64-cuda': ['gezel-llama-server', 'gezel-ds4-server', 'gezel-sd-server'],
  'linux-arm64': ['gezel-device-health', 'gezel-sd-server', 'gezel-whisper-server', 'uv'],
  'linux-arm64-cpu': ['gezel-llama-server'],
  'linux-arm64-cuda': ['gezel-llama-server', 'gezel-ds4-server', 'gezel-sd-server'],
});

/**
 * Which upstream engine each staged binary comes from, keyed by the same
 * names `NATIVE_PAYLOAD` uses. The values are the engine ids under
 * `native/engines/<id>/`, which is what NOTICE.md and the native license
 * manifest are keyed by.
 *
 * `null` marks a binary we write ourselves, so it has no upstream engine pin.
 * Third-party source compiled into one of those helpers is inventoried
 * separately under `native/licenses/manifest.json#helpers` and still reaches
 * NOTICE plus the SBOM. Everything in NATIVE_PAYLOAD must appear here;
 * native-payload.test.mjs enforces that, so adding an engine to the payload
 * without classifying it fails the build rather than silently dropping it from
 * the SBOM.
 */
export const ENGINE_FOR_BINARY = Object.freeze({
  'gezel-llama-server': 'llama-cpp',
  'gezel-sd-server': 'sd-cpp',
  'gezel-ds4-server': 'ds4',
  'gezel-whisper-server': 'whisper-cpp',
  uv: 'uv',
  'vec0.dll': 'sqlite-vec',
  'gezel-device-health': null,
  'gezel-service-host': null,
  'gezel-apple-fm': null,
});

/** Every platform key a native release publishes an archive for. */
export function allPlatformKeys() {
  return Object.keys(NATIVE_PAYLOAD);
}

/**
 * Keys added after native releases already existed, with the first release
 * that publishes each one.
 *
 * The build side always builds every key. But the desktop, MSIX and Mac App
 * Store preflights check an already-published release for an archive per key,
 * and so does the SBOM test against the pinned file manifest. Without this,
 * adding a key fails every desktop release until another native release is cut
 * and pinned. Once the pinned release reaches the version here, the entry is
 * inert and can be deleted.
 */
export const FIRST_NATIVE_RELEASE = Object.freeze({
  'win32-arm64-cuda': '0.1.52',
});

/**
 * The same, one level down: binaries added to a key that older releases
 * already publish. Checks against a published release, and the SBOM built
 * from the pinned one, must not claim a binary that release lacks.
 *
 * Keyed `<platform key>/<binary>`, because a binary can join one key long
 * after it shipped in others: the CUDA whisper-server is new in
 * `win32-arm64-cuda` while every bare key has carried a whisper-server for
 * many releases.
 */
export const FIRST_NATIVE_RELEASE_BINARY = Object.freeze({
  'win32-arm64/vec0.dll': '0.1.53',
  'win32-arm64-cuda/gezel-whisper-server': '0.1.53',
});

function parseNativeVersion(version) {
  const match = /^(?:native-v|v)?(\d+)\.(\d+)\.(\d+)$/.exec(`${version}`.trim());
  if (!match) throw new Error(`not a native release version: ${JSON.stringify(version)}`);
  return match.slice(1).map(Number);
}

function compareNativeVersions(a, b) {
  const left = parseNativeVersion(a);
  const right = parseNativeVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Platform keys the native release `version` (e.g. `0.1.51`) publishes. */
export function platformKeysInRelease(version) {
  parseNativeVersion(version);
  return allPlatformKeys().filter(
    (key) =>
      !FIRST_NATIVE_RELEASE[key] || compareNativeVersions(version, FIRST_NATIVE_RELEASE[key]) >= 0,
  );
}

/** The binaries `key`'s archive carries in native release `version`. */
export function binariesInRelease(key, version) {
  parseNativeVersion(version);
  return (NATIVE_PAYLOAD[key] ?? []).filter((binary) => {
    const first = FIRST_NATIVE_RELEASE_BINARY[`${key}/${binary}`];
    return !first || compareNativeVersions(version, first) >= 0;
  });
}

/**
 * Platform keys whose payload includes at least one binary from `engineId`.
 * Used to annotate SBOM components, since one SBOM accompanies installers for
 * several platforms and the CUDA-only engines ship on a subset of them.
 */
export function platformKeysForEngine(engineId) {
  return allPlatformKeys().filter((key) =>
    NATIVE_PAYLOAD[key].some((binary) => ENGINE_FOR_BINARY[binary] === engineId),
  );
}

/**
 * Every key belonging to one platform — the bare key (single-variant
 * engines like sd-cpp / whisper-cpp / uv) plus each suffixed key
 * (multi-variant engines, currently only llama-cpp).
 *
 * Consumers fetch all of them so Settings → Advanced → Engine backend can
 * flip between variants without a re-fetch. An unsupported platform
 * (darwin-x64) yields an empty list rather than throwing — callers treat
 * that as "no bundled engines on this host".
 */
export function platformVariants(platform) {
  return allPlatformKeys().filter((key) => key === platform || key.startsWith(`${platform}-`));
}

/**
 * File names — executables get the `.exe` suffix on Windows keys; a library
 * is listed with its extension already. With `version`, only what that
 * published release carries.
 */
export function expectedBinaries(platformKey, version) {
  if (!NATIVE_PAYLOAD[platformKey]) return null;
  const names = version ? binariesInRelease(platformKey, version) : NATIVE_PAYLOAD[platformKey];
  const ext = platformKey.startsWith('win32-') ? '.exe' : '';
  return names.map((name) => (name.includes('.') ? name : `${name}${ext}`));
}

/** The platform key for the host this script runs on, or null. */
export function detectPlatform() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux-x64';
    if (process.arch === 'arm64') return 'linux-arm64';
  }
  if (process.platform === 'win32') {
    if (process.arch === 'x64') return 'win32-x64';
    if (process.arch === 'arm64') return 'win32-arm64';
  }
  return null;
}

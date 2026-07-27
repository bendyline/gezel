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
 *   - no `linux-arm64-vulkan` — LunarG ships no aarch64 SDK tarball
 *   - `gezel-device-health` is Windows + Linux only (macOS uses IOKit in-process)
 *   - `gezel-service-host` is Windows only (macOS/Linux use launchd/systemd)
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
  'darwin-arm64': ['gezel-sd-server', 'gezel-ds4-server', 'gezel-whisper-server', 'uv'],
  'darwin-arm64-metal': ['gezel-llama-server'],
  'linux-x64': ['gezel-device-health', 'gezel-sd-server', 'gezel-whisper-server', 'uv'],
  'linux-x64-cpu': ['gezel-llama-server'],
  'linux-x64-vulkan': ['gezel-llama-server'],
  'linux-x64-cuda': ['gezel-llama-server', 'gezel-ds4-server'],
  'linux-arm64': ['gezel-device-health', 'gezel-sd-server', 'gezel-whisper-server', 'uv'],
  'linux-arm64-cpu': ['gezel-llama-server'],
  'linux-arm64-cuda': ['gezel-llama-server', 'gezel-ds4-server'],
});

/** Every platform key a native release publishes an archive for. */
export function allPlatformKeys() {
  return Object.keys(NATIVE_PAYLOAD);
}

/**
 * Every key belonging to one platform — the bare key (single-variant
 * engines like sd-cpp / whisper-cpp / uv) plus each suffixed key
 * (multi-variant engines, currently only llama-cpp).
 *
 * Consumers fetch all of them so Settings → Advanced → Engine backend can
 * flip between variants without a re-fetch. An unsupported platform
 * (darwin-x64, win32-arm64) yields an empty list rather than throwing —
 * callers treat that as "no bundled engines on this host".
 */
export function platformVariants(platform) {
  return allPlatformKeys().filter((key) => key === platform || key.startsWith(`${platform}-`));
}

/** Binary file names — with the `.exe` suffix on Windows keys. */
export function expectedBinaries(platformKey) {
  const names = NATIVE_PAYLOAD[platformKey];
  if (!names) return null;
  const ext = platformKey.startsWith('win32-') ? '.exe' : '';
  return names.map((name) => `${name}${ext}`);
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
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return null;
}

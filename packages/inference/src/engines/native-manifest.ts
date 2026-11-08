/**
 * Source-pinned root of trust for runtime engine downloads.
 *
 * The daemon can download native engine binaries (`llama-server`, …) on
 * demand from the `native-v<version>` GitHub release (see
 * `resolver.ts`). To make the *published gezel package* the trust anchor
 * — rather than blindly trusting whatever the release happens to contain
 * — we bake in:
 *
 *   - `NATIVE_ENGINE_RELEASE`  the release version this build resolves
 *     against (the `native-v<X>` tag, minus the prefix).
 *   - `SHA256SUMS_DIGEST`      the sha256 of that release's `SHA256SUMS`
 *     asset. The resolver verifies the downloaded `SHA256SUMS` file
 *     against this digest.
 *   - `NATIVE_ENGINE_ARCHIVE_SHA256` every engine archive hash from that same
 *     manifest. The resolver requires the requested archive to appear in
 *     this source-bundled map, checks that the remote manifest agrees, and
 *     hashes the downloaded archive against the bundled value.
 *   - `NATIVE_ENGINE_MACOS_NOTARIZED` whether the pinned native release
 *     was independently submitted to Apple's notary service. This is
 *     release provenance, separate from notarizing an Electron app that
 *     later embeds it. Bare command-line binaries cannot carry a stapled
 *     ticket or pass app-bundle `spctl` assessment; runtime trust is the
 *     accepted release workflow plus these source-pinned hashes and the
 *     Developer ID signature.
 *
 * This mirrors the `NODE_SHA256` pin in
 * [node-version.ts](../../../app/src/node-version.ts): a placeholder of
 * all-zeros means "no public release pinned yet" and the resolver
 * refuses to download (rather than trusting an unverifiable release).
 *
 * Bumping: use `scripts/pin-native-release.mjs`; it rewrites the release,
 * manifest digest, and complete archive map together. Never hand-edit a
 * digest to match a download — that defeats the point.
 *
 * Dev/integration override: set `GEZEL_NATIVE_ENGINE_VERSION` to point at
 * a real dev release before the public pin exists. With the digest still
 * a placeholder the resolver runs in "unpinned" mode — it verifies each
 * archive against the release's own `SHA256SUMS` (catching corruption)
 * but logs that it could not anchor to a baked-in digest.
 */

/** Native release version this build pins. Placeholder until first public release. */
export const NATIVE_ENGINE_RELEASE = '0.1.62';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '9c2e726c1cef4152b5ffb8cee8e9970cf24127786d3fafcce3582dcf0df9badb';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.62. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.62-darwin-arm64-metal.tar.gz':
    '0ac76122fdc7bd33e6774fb5f62dea6ff22220c483c78026667e33ff8014936d',
  'gezel-native-0.1.62-darwin-arm64.tar.gz':
    '23607c3e5c3e6ac050f0594bcf4ca997cff91c57a4b65af985511e1d87843764',
  'gezel-native-0.1.62-linux-arm64-cpu.tar.gz':
    'e9a69cdb07f5ad0103da8d99715e4a1bd257219c55457716ff93e34ee4a544ab',
  'gezel-native-0.1.62-linux-arm64-cuda.tar.gz':
    '6389e97d85a2d4b53b4a1c6735669e5cd6022f393fdccabe4c18c9957f9073fc',
  'gezel-native-0.1.62-linux-arm64.tar.gz':
    'cd263de007b14be6de5b828985d3066490a339f097ef199086cd51692495b9f0',
  'gezel-native-0.1.62-linux-x64-cpu.tar.gz':
    '2f1b382a02082767187340f8ecd037dfa72953004977e5716ca95127429e4f0b',
  'gezel-native-0.1.62-linux-x64-cuda.tar.gz':
    '8f28018fdfd5a38e48dc886a92eab392f92193d3a58c322c85dcd16c6f80fd13',
  'gezel-native-0.1.62-linux-x64-rocm.tar.gz':
    '37b88b81bdcbe06fa3c5ebe3b07f0d0112b555449cc2d29775d5ad8373150f18',
  'gezel-native-0.1.62-linux-x64-vulkan.tar.gz':
    'c39fff97dceeacb377a1948ebe9f9553a98485cf21cda9492fbfbe18dd279193',
  'gezel-native-0.1.62-linux-x64.tar.gz':
    '2d0c927f98379c0cd1dd05d68f2cc4b87178ede077a65e948bf36e124d560993',
  'gezel-native-0.1.62-win32-arm64-cpu.zip':
    'f867d50591df2da2c2d78cbf844a5b87679da9f5abc9a29ed6b06905c5423bed',
  'gezel-native-0.1.62-win32-arm64-cuda.zip':
    'd42c79845f64ee1fb5e97ea45dde44c6b4705ad6bc4cd6ce9360caffc27cf67f',
  'gezel-native-0.1.62-win32-arm64.zip':
    'd4e660181cd387051d4f8728d6ae008004969786f68da15c76e44704db247af0',
  'gezel-native-0.1.62-win32-x64-cpu.zip':
    '85a350c01454e77d49e2a7e463089025d71b6f7cd25daa30b5b0fe8498cf3f2a',
  'gezel-native-0.1.62-win32-x64-cuda.zip':
    'edddeeb820f4612453c036bccd4882c507811464520eb772dfa5bf7b4aa2658f',
  'gezel-native-0.1.62-win32-x64-rocm.zip':
    '8640280b49fbc4bc6152b734fcb2dd02b0b9c3375797685470da52406a46aa34',
  'gezel-native-0.1.62-win32-x64-vulkan.zip':
    'a57071775f8876800d6e5689d38a3f7362c4b585e8137596ee19e45ee38b6991',
  'gezel-native-0.1.62-win32-x64.zip':
    '357e6c79a4d02968a2ba67299e78efed8dc2ab2d4b40a1e8f866073506b6b2b6',
});

/** Download size in bytes of every engine archive published by native-v0.1.62. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.62-darwin-arm64-metal.tar.gz': 7577614,
  'gezel-native-0.1.62-darwin-arm64.tar.gz': 42917428,
  'gezel-native-0.1.62-linux-arm64-cpu.tar.gz': 9518882,
  'gezel-native-0.1.62-linux-arm64-cuda.tar.gz': 624413294,
  'gezel-native-0.1.62-linux-arm64.tar.gz': 43076642,
  'gezel-native-0.1.62-linux-x64-cpu.tar.gz': 13762290,
  'gezel-native-0.1.62-linux-x64-cuda.tar.gz': 1016218245,
  'gezel-native-0.1.62-linux-x64-rocm.tar.gz': 313875007,
  'gezel-native-0.1.62-linux-x64-vulkan.tar.gz': 26687129,
  'gezel-native-0.1.62-linux-x64.tar.gz': 58389984,
  'gezel-native-0.1.62-win32-arm64-cpu.zip': 6219263,
  'gezel-native-0.1.62-win32-arm64-cuda.zip': 245764366,
  'gezel-native-0.1.62-win32-arm64.zip': 42822090,
  'gezel-native-0.1.62-win32-x64-cpu.zip': 9357113,
  'gezel-native-0.1.62-win32-x64-cuda.zip': 761458453,
  'gezel-native-0.1.62-win32-x64-rocm.zip': 241630451,
  'gezel-native-0.1.62-win32-x64-vulkan.zip': 21898409,
  'gezel-native-0.1.62-win32-x64.zip': 56194044,
});
// END PINNED NATIVE ARCHIVE HASHES

/**
 * True only when the pinned release's standalone macOS archives were
 * Developer ID signed and accepted by Apple's notary service before
 * packaging. Electron notarization is a separate distribution contract.
 */
export const NATIVE_ENGINE_MACOS_NOTARIZED = true;

/**
 * The download size of the archive the resolver fetches for this platform
 * and variant, when this build pins it. Undefined under a dev release
 * override, whose archives this build has no sizes for.
 */
export function pinnedEngineArchiveBytes(
  platformKey: string,
  variant: string | undefined,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  if (effectiveEngineRelease() !== NATIVE_ENGINE_RELEASE) return undefined;
  const key = variant ? `${platformKey}-${variant}` : platformKey;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return NATIVE_ENGINE_ARCHIVE_BYTES[`gezel-native-${NATIVE_ENGINE_RELEASE}-${key}.${ext}`];
}

/** True when a sha256 hex string is the all-zeros placeholder. */
export function isPlaceholderDigest(digest: string): boolean {
  return /^0{64}$/.test(digest.trim().toLowerCase());
}

/**
 * Whether engine auto-download is even possible in this build: a real
 * release is pinned, or a dev override points at one. When false, the
 * lazy on-device hook stays dormant and the daemon shows the existing
 * "install / point at an external engine" guidance instead of kicking a
 * download that can't succeed.
 */
export function isEnginePinned(): boolean {
  return (
    (!isPlaceholderDigest(SHA256SUMS_DIGEST) &&
      Object.keys(NATIVE_ENGINE_ARCHIVE_SHA256).length > 0) ||
    !!process.env.GEZEL_NATIVE_ENGINE_VERSION
  );
}

/**
 * Effective release version: the dev override env var wins over the
 * source pin so integration tests can target a real dev release without
 * editing source. Returns the version with any `native-v`/`v` prefix
 * stripped (the resolver re-adds `native-v`).
 */
export function effectiveEngineRelease(): string {
  const override = process.env.GEZEL_NATIVE_ENGINE_VERSION;
  const raw = override?.trim() ? override.trim() : NATIVE_ENGINE_RELEASE;
  return raw.replace(/^native-v/, '').replace(/^v/, '');
}

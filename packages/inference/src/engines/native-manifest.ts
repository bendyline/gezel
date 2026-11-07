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
export const NATIVE_ENGINE_RELEASE = '0.1.61';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = 'f78bfce01740cca58d46afabcbb22fb2005b28d9974f41e0f5c5ffdcc1ddd80b';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.61. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.61-darwin-arm64-metal.tar.gz':
    '7036c0a483ba34bd30ac147da5a0f2f0d00804e311c2bf721bffb2a251da94c3',
  'gezel-native-0.1.61-darwin-arm64.tar.gz':
    '3ccb5418f3efacbfcf6c806833a92f27f27214d14e19a414feb0e0789edc0354',
  'gezel-native-0.1.61-linux-arm64-cpu.tar.gz':
    '30d6f84b8e828a76474a4f5dec3e5f636c4304e6ca305bcada401264758feb3b',
  'gezel-native-0.1.61-linux-arm64-cuda.tar.gz':
    '3ed620f795becb010c96d23094603827e25a3390cb1d1df67fb7becc4ba4f8bb',
  'gezel-native-0.1.61-linux-arm64.tar.gz':
    'bc87dedb6b9d6f67a79a744629d590f78c7dc6b8a76c666c698c860cc6ac262e',
  'gezel-native-0.1.61-linux-x64-cpu.tar.gz':
    '010b75d96924ee97301dba0a02150407a588a0fad828274e147086eb2bd9f492',
  'gezel-native-0.1.61-linux-x64-cuda.tar.gz':
    'cdfc914c1a1f8b0b3429c2d8263b72c5b8bf306cdc96ec045804f9e9d5e13191',
  'gezel-native-0.1.61-linux-x64-rocm.tar.gz':
    '530c7cd39617a5f235343bf646fb72e51b101ec4f00db4bc8c48d59e0a6bfb2c',
  'gezel-native-0.1.61-linux-x64-vulkan.tar.gz':
    'ecc9e643fd06ed6636b6f34640fd6916d5d6e0c07d7e3d9c121a484bf957bd8e',
  'gezel-native-0.1.61-linux-x64.tar.gz':
    'e47135d62bbd4c5798ff06d1b52ccb1c2c77ad71e64a06c2e88f0ddab2204b00',
  'gezel-native-0.1.61-win32-arm64-cpu.zip':
    '386409ef3ee601c264561a5d86028f15c935c38c9fc35e087e5f4a7f1811c4d6',
  'gezel-native-0.1.61-win32-arm64-cuda.zip':
    'adb985a1bd72313c690090406ee5d9f3ccbe6bb24afb82c688e80bb050d915ed',
  'gezel-native-0.1.61-win32-arm64.zip':
    '22c30445353be2c33142870375fbc6b8cf0795e7331101bd6d83793bed3bea0d',
  'gezel-native-0.1.61-win32-x64-cpu.zip':
    '80d2acfdafdccfd64419decedc84bc06f6940de0d47a1cc179435649b38383b1',
  'gezel-native-0.1.61-win32-x64-cuda.zip':
    '82fa01a2dc373a628e275bb68d176654b1b1b8185a91a3542f1b3135da56f169',
  'gezel-native-0.1.61-win32-x64-rocm.zip':
    '03c4f0b8887f7b4e2c2c2d86489a8a1d0e1fb179ca70cdf8a9650f83513714d2',
  'gezel-native-0.1.61-win32-x64-vulkan.zip':
    '939f8b13ade3f0aa40419d4d3d17afdc0e4b525cb3975aed78fb47bda4ef6dab',
  'gezel-native-0.1.61-win32-x64.zip':
    '767f55c72ac39c131a42c7c719715d1e35b0badb804b59217588fcb123cefba8',
});

/** Download size in bytes of every engine archive published by native-v0.1.61. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.61-darwin-arm64-metal.tar.gz': 7578332,
  'gezel-native-0.1.61-darwin-arm64.tar.gz': 42917160,
  'gezel-native-0.1.61-linux-arm64-cpu.tar.gz': 9519074,
  'gezel-native-0.1.61-linux-arm64-cuda.tar.gz': 624413405,
  'gezel-native-0.1.61-linux-arm64.tar.gz': 43077065,
  'gezel-native-0.1.61-linux-x64-cpu.tar.gz': 13762287,
  'gezel-native-0.1.61-linux-x64-cuda.tar.gz': 1016230446,
  'gezel-native-0.1.61-linux-x64-rocm.tar.gz': 313876628,
  'gezel-native-0.1.61-linux-x64-vulkan.tar.gz': 26687115,
  'gezel-native-0.1.61-linux-x64.tar.gz': 58390304,
  'gezel-native-0.1.61-win32-arm64-cpu.zip': 6219235,
  'gezel-native-0.1.61-win32-arm64-cuda.zip': 245764149,
  'gezel-native-0.1.61-win32-arm64.zip': 42822053,
  'gezel-native-0.1.61-win32-x64-cpu.zip': 9357064,
  'gezel-native-0.1.61-win32-x64-cuda.zip': 761449962,
  'gezel-native-0.1.61-win32-x64-rocm.zip': 241630432,
  'gezel-native-0.1.61-win32-x64-vulkan.zip': 21898398,
  'gezel-native-0.1.61-win32-x64.zip': 56194037,
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

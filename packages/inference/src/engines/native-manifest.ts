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
export const NATIVE_ENGINE_RELEASE = '0.1.54';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '087215a12096127a779b20e0dcb7d2ed9ce5dda1c81f33fdeb6b6eb730485b20';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.54. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.54-darwin-arm64-metal.tar.gz':
    'f2990970303b954af2fd2e2bd31efef7d1c231bea16e026e0cdc0a7f9cc17842',
  'gezel-native-0.1.54-darwin-arm64.tar.gz':
    '850f28338c52f945996c55edd77cf14d451c9bc4a09f719f6608885ddab99687',
  'gezel-native-0.1.54-linux-arm64-cpu.tar.gz':
    '7dac7fed45c46b591cd6d597d639c385f54a3a367ac15d6097d3ad04d9c3c6e6',
  'gezel-native-0.1.54-linux-arm64-cuda.tar.gz':
    'f73c4569c356c4584199513c6c1f1f0bd3f0151fb1845696e2fa43f2b3626803',
  'gezel-native-0.1.54-linux-arm64.tar.gz':
    'f034ad2d3d12165c979d2fff2d34752c8d4f8ff836d3c416c9c64535f3bb652b',
  'gezel-native-0.1.54-linux-x64-cpu.tar.gz':
    '57de7d52b0e95e3886bf4ffad7e015b98ba8bbea96b95d8cb3e26bc1ff309e99',
  'gezel-native-0.1.54-linux-x64-cuda.tar.gz':
    'c2d8616410f72b8bb217194f7c71d5175ed1c94ac6d9d94f660e0f535a3cff22',
  'gezel-native-0.1.54-linux-x64-vulkan.tar.gz':
    '89f3233f41861404db082219962eb25d1b2c3f6e42bbc2696fda122ce845371d',
  'gezel-native-0.1.54-linux-x64.tar.gz':
    'f42e42d71187c6ef5af9685ebb65511bb7ac638815105f09f3df22cfdb9e6bce',
  'gezel-native-0.1.54-win32-arm64-cpu.zip':
    'e482e2af92f28135aea2e21ae97290e231b0dc77eadc8cc532d2506304d27575',
  'gezel-native-0.1.54-win32-arm64-cuda.zip':
    'ff6eaf7f070e9aba7fc087a155896f73b12664d867e0374af5546e941c153b82',
  'gezel-native-0.1.54-win32-arm64.zip':
    '9b854d824117fe56d7d532ab83c01693a97cf6b45752e69cb895aa183c8cff35',
  'gezel-native-0.1.54-win32-x64-cpu.zip':
    '93c8f22b47831ba8e0808033e87ce91cdb0d481890602857b6b8b5295cc7d50b',
  'gezel-native-0.1.54-win32-x64-cuda.zip':
    '84da0b362e502d0bb6e3509528e7a4ccff50c2b9fcaa2fa1a62b3d9b0ad9f5d2',
  'gezel-native-0.1.54-win32-x64-vulkan.zip':
    '1a3c99ce8343552fb17af80c36ba8ebb7c13ac8d6b4966f3aa3054018d41fa11',
  'gezel-native-0.1.54-win32-x64.zip':
    'f224fcdea6945ce574d32bee6ace345f82847f317c40cfa9059feba9b87ac0ca',
});

/** Download size in bytes of every engine archive published by native-v0.1.54. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.54-darwin-arm64-metal.tar.gz': 7056387,
  'gezel-native-0.1.54-darwin-arm64.tar.gz': 42224129,
  'gezel-native-0.1.54-linux-arm64-cpu.tar.gz': 8838944,
  'gezel-native-0.1.54-linux-arm64-cuda.tar.gz': 620429935,
  'gezel-native-0.1.54-linux-arm64.tar.gz': 42037092,
  'gezel-native-0.1.54-linux-x64-cpu.tar.gz': 12914025,
  'gezel-native-0.1.54-linux-x64-cuda.tar.gz': 993587032,
  'gezel-native-0.1.54-linux-x64-vulkan.tar.gz': 25672135,
  'gezel-native-0.1.54-linux-x64.tar.gz': 57185943,
  'gezel-native-0.1.54-win32-arm64-cpu.zip': 5623741,
  'gezel-native-0.1.54-win32-arm64-cuda.zip': 242341587,
  'gezel-native-0.1.54-win32-arm64.zip': 42236457,
  'gezel-native-0.1.54-win32-x64-cpu.zip': 8719660,
  'gezel-native-0.1.54-win32-x64-cuda.zip': 749849595,
  'gezel-native-0.1.54-win32-x64-vulkan.zip': 21128362,
  'gezel-native-0.1.54-win32-x64.zip': 55668353,
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

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
export const NATIVE_ENGINE_RELEASE = '0.1.63';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = 'ba2356a07cbe8e5d39321b98c84217a15704afecfad5c4b7552c6033c02255fb';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.63. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.63-darwin-arm64-metal.tar.gz':
    'e3bb8cf323df1c4947245d03b9b7add40f8744151de0df4a828d9ddd4c8c103a',
  'gezel-native-0.1.63-darwin-arm64.tar.gz':
    '59c299dbf4f95636cf67c52ca7eb1f1145955581c940e3526c6d76468564298d',
  'gezel-native-0.1.63-linux-arm64-cpu.tar.gz':
    'fc596bdf4bec2733b7078ab239e0adf94a782f5250895dfb3657d8dd54c3de3d',
  'gezel-native-0.1.63-linux-arm64-cuda.tar.gz':
    '5980a17838a8382fe1a97c22545f82e8079a7b309486c2be7fe32d4d5363ddb4',
  'gezel-native-0.1.63-linux-arm64.tar.gz':
    'a2adca07370d8219218cd35a90fe1c53fd33250a25a7034b42ca217aaee073fe',
  'gezel-native-0.1.63-linux-x64-cpu.tar.gz':
    '2052b8962dc9099b2931721a816fc9ed12f432271f0f6e52dfb15e3f272a9f02',
  'gezel-native-0.1.63-linux-x64-cuda.tar.gz':
    'fbdb804707d166c73f2df86d0fd3e567072ceb48d643e54aeb96f3bc5ec45c20',
  'gezel-native-0.1.63-linux-x64-rocm.tar.gz':
    '0d70a859cb71afb859d371892ab7a8af14efc748f14b02cc6b076335feb724c6',
  'gezel-native-0.1.63-linux-x64-vulkan.tar.gz':
    '531dfca595e6369b9b85ec468b5bb5fc7280d356ad89d18648623e9eb29de066',
  'gezel-native-0.1.63-linux-x64.tar.gz':
    '3c8e3af9c7e40fe7a9608c58a2d57d02ea78633ab5e1daf5ad4610c574f0a10a',
  'gezel-native-0.1.63-win32-arm64-cpu.zip':
    'a75ca11b2cbd2f67d5a94aca5e4e16c2c17e01e8fee4ab9535d56e96352efa6f',
  'gezel-native-0.1.63-win32-arm64-cuda.zip':
    '6e82373e4413d14a0884fe40a0be47bc650421eb54899ee17c22db2fbb353124',
  'gezel-native-0.1.63-win32-arm64.zip':
    'da7a3626e4faf04d0519a341edd01b4d9b35dd6e62555a9054561c993d5dd541',
  'gezel-native-0.1.63-win32-x64-cpu.zip':
    'dc5d5fc1e04e9b60fb5c79bf748e1383858dba4a94e6d3c3271bc19d093055a5',
  'gezel-native-0.1.63-win32-x64-cuda.zip':
    '389057692e41cbafbd135d60cc9f33e58c146b46d34c63eeaf983564b7822cbb',
  'gezel-native-0.1.63-win32-x64-rocm.zip':
    '054f3762a17ac93a76d65c77082f7c75a6725bebcc78e8bee6f0338c6c81afa6',
  'gezel-native-0.1.63-win32-x64-vulkan.zip':
    'de47bf712e4cd0753135ace06aabb42ed9377a2978a29fc19aaf6dd5ae385cb5',
  'gezel-native-0.1.63-win32-x64.zip':
    '172525a511970f2156d057e44addb0fce06e389340b7c2873000a9837ac58d62',
});

/** Download size in bytes of every engine archive published by native-v0.1.63. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.63-darwin-arm64-metal.tar.gz': 7684564,
  'gezel-native-0.1.63-darwin-arm64.tar.gz': 42919263,
  'gezel-native-0.1.63-linux-arm64-cpu.tar.gz': 9597616,
  'gezel-native-0.1.63-linux-arm64-cuda.tar.gz': 625785098,
  'gezel-native-0.1.63-linux-arm64.tar.gz': 43077132,
  'gezel-native-0.1.63-linux-x64-cpu.tar.gz': 13833634,
  'gezel-native-0.1.63-linux-x64-cuda.tar.gz': 1026809765,
  'gezel-native-0.1.63-linux-x64-rocm.tar.gz': 321684474,
  'gezel-native-0.1.63-linux-x64-vulkan.tar.gz': 26788147,
  'gezel-native-0.1.63-linux-x64.tar.gz': 58390255,
  'gezel-native-0.1.63-win32-arm64-cpu.zip': 6319514,
  'gezel-native-0.1.63-win32-arm64-cuda.zip': 247311294,
  'gezel-native-0.1.63-win32-arm64.zip': 42822065,
  'gezel-native-0.1.63-win32-x64-cpu.zip': 9453582,
  'gezel-native-0.1.63-win32-x64-cuda.zip': 771992966,
  'gezel-native-0.1.63-win32-x64-rocm.zip': 249230305,
  'gezel-native-0.1.63-win32-x64-vulkan.zip': 22041950,
  'gezel-native-0.1.63-win32-x64.zip': 56194042,
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

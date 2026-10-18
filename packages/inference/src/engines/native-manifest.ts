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
export const NATIVE_ENGINE_RELEASE = '0.1.51';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '499a87aa18e113cdb52ee277bff71365e9176b63b536dbea7f3c2aa5ff5dbe68';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.51. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.51-darwin-arm64-metal.tar.gz':
    '5abbfd156fbcc717da96c89dc5baa507a56d2b55b501f1a975803a763e6414c4',
  'gezel-native-0.1.51-darwin-arm64.tar.gz':
    '799bca88b0ea10aeb2dad9ed3065c9396f42383a6fd5c7347ed76abf0706f128',
  'gezel-native-0.1.51-linux-arm64-cpu.tar.gz':
    '1612e5928693262884bcc2c60ba3975af4dc4267c2bd75597ef91e83681fa96e',
  'gezel-native-0.1.51-linux-arm64-cuda.tar.gz':
    '4a457df5dbb8475ca0eb2f1a2373f1960bbb3f86a0ecd938a407f884cd6026a2',
  'gezel-native-0.1.51-linux-arm64.tar.gz':
    '2aaead65bfd42ffef9a1f45a70fa24095bc2814842750536989cbcb7a9a0db24',
  'gezel-native-0.1.51-linux-x64-cpu.tar.gz':
    '7453d6a3ef2de7ece967a033d5bd634789e41edefa4a823b580329f0ad98abb0',
  'gezel-native-0.1.51-linux-x64-cuda.tar.gz':
    'ac1054a33339bcf6167c309b867f5671def58e036bb612978c4a434cd7ac39d6',
  'gezel-native-0.1.51-linux-x64-vulkan.tar.gz':
    '6739c9dca6cbcf53fb5d69dbd342ac6be49fe2f0d86471d66975e61a64c95e9f',
  'gezel-native-0.1.51-linux-x64.tar.gz':
    'a176ac570131db874e0a81fdec939415dd161a639827219a82f2a610f5ebd8d3',
  'gezel-native-0.1.51-win32-arm64-cpu.zip':
    'f79c0c8490d46f2d60e73fd948bf74ae93dfc7c650a878f7db5e227bbdbb85b9',
  'gezel-native-0.1.51-win32-arm64.zip':
    'c829c9c1fd08756aff9e677ea1addcf80a8739f13df3c9b6788a6237e53efacb',
  'gezel-native-0.1.51-win32-x64-cpu.zip':
    'f8e0ffeacc8aeea1f2fc91024382bdcdaeeeb65b8a45935af422acb4d7027190',
  'gezel-native-0.1.51-win32-x64-cuda.zip':
    '6bd7dc2c43443a847058a4c4f1c53281c99563c214394a92470281a70f725d1e',
  'gezel-native-0.1.51-win32-x64-vulkan.zip':
    'e20fb148c854f267aa50981525e337c38d3ee496fd483393a676251d9c0a496f',
  'gezel-native-0.1.51-win32-x64.zip':
    'ca5d7866fa2ff2e89da9267fcb409eb9aff01ef1c43ed726327e4967d3ed5e56',
});

/** Download size in bytes of every engine archive published by native-v0.1.51. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.51-darwin-arm64-metal.tar.gz': 7056609,
  'gezel-native-0.1.51-darwin-arm64.tar.gz': 41556782,
  'gezel-native-0.1.51-linux-arm64-cpu.tar.gz': 8836261,
  'gezel-native-0.1.51-linux-arm64-cuda.tar.gz': 619480627,
  'gezel-native-0.1.51-linux-arm64.tar.gz': 41979458,
  'gezel-native-0.1.51-linux-x64-cpu.tar.gz': 12914417,
  'gezel-native-0.1.51-linux-x64-cuda.tar.gz': 989771250,
  'gezel-native-0.1.51-linux-x64-vulkan.tar.gz': 25672179,
  'gezel-native-0.1.51-linux-x64.tar.gz': 58057226,
  'gezel-native-0.1.51-win32-arm64-cpu.zip': 5618599,
  'gezel-native-0.1.51-win32-arm64.zip': 42055408,
  'gezel-native-0.1.51-win32-x64-cpu.zip': 8714418,
  'gezel-native-0.1.51-win32-x64-cuda.zip': 749850276,
  'gezel-native-0.1.51-win32-x64-vulkan.zip': 21123169,
  'gezel-native-0.1.51-win32-x64.zip': 56558016,
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

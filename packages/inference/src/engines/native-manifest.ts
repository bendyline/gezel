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
export const NATIVE_ENGINE_RELEASE = '0.1.49';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '51e9d1fcd18174967fed451d11a7401035076330dfedadd6a0ce396ab636cff7';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.49. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.49-darwin-arm64-metal.tar.gz':
    'a484487893151fdbe1ba5b3ea9d4dff3692efe8735e0a681d8f4ab84d5ffb09d',
  'gezel-native-0.1.49-darwin-arm64.tar.gz':
    '7dc049ffd09dfb51befbf5c955e569556de6024991478eeb6900646e4672c723',
  'gezel-native-0.1.49-linux-arm64-cpu.tar.gz':
    '19490ce26e843c2cab7321b91f9fac781ab3bab9ade6e3945543b312bf1a29e8',
  'gezel-native-0.1.49-linux-arm64-cuda.tar.gz':
    '6802852803b0748d7ced99805a8aac281637f8816d02937460e64fbcd8da0637',
  'gezel-native-0.1.49-linux-arm64.tar.gz':
    '8d3cd77b5c029fc0c4b4ae83000a72450008973eaf69168c4a21c58bfb75bf33',
  'gezel-native-0.1.49-linux-x64-cpu.tar.gz':
    '030eaf798727ab13dcd7e7f4b3124c0f02e6f638e58f81c5d9a399c57d1c0a0a',
  'gezel-native-0.1.49-linux-x64-cuda.tar.gz':
    'd31d21d0c4c5504c9f29eaed32b500b26676bec0fd5ed23fdfd598baecafd748',
  'gezel-native-0.1.49-linux-x64-vulkan.tar.gz':
    '114956cb94d174f00105f86b97ba932e1583cac80d9d0ab6b0edf396ea410506',
  'gezel-native-0.1.49-linux-x64.tar.gz':
    'd6a711c2be9329b00ad6bb20e4c16062677ef4d5804a2033d579b2347f5e2802',
  'gezel-native-0.1.49-win32-arm64-cpu.zip':
    'c2e8f10a45bae6cee4801845b605588c5b8b7b3c2e81a512e89296a2f9b7afce',
  'gezel-native-0.1.49-win32-arm64.zip':
    '23173db21533dfe3f3189f5582cde9a0550859515b2c94688fb34d342d97e3e5',
  'gezel-native-0.1.49-win32-x64-cpu.zip':
    'cf6a8806e2c2b0a964804169cfb3d9283032536a6c262dc70b65a37b45451f3e',
  'gezel-native-0.1.49-win32-x64-cuda.zip':
    '9a1e090829cf2f16389e1a01506853d8ac3ed151a32994831000c1c3658cef08',
  'gezel-native-0.1.49-win32-x64-vulkan.zip':
    '0b7fe1cab3b881ac4a5cc24f08b0206c38edab30940ea79888a70776925a8bfb',
  'gezel-native-0.1.49-win32-x64.zip':
    'e8996f82ea358903010e050d6b8b93beec683286af512b11cd8eeefdea50aa6d',
});

/** Download size in bytes of every engine archive published by native-v0.1.49. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.49-darwin-arm64-metal.tar.gz': 6895181,
  'gezel-native-0.1.49-darwin-arm64.tar.gz': 41543602,
  'gezel-native-0.1.49-linux-arm64-cpu.tar.gz': 8681742,
  'gezel-native-0.1.49-linux-arm64-cuda.tar.gz': 618839431,
  'gezel-native-0.1.49-linux-arm64.tar.gz': 41977168,
  'gezel-native-0.1.49-linux-x64-cpu.tar.gz': 13085558,
  'gezel-native-0.1.49-linux-x64-cuda.tar.gz': 987396266,
  'gezel-native-0.1.49-linux-x64-vulkan.tar.gz': 27140717,
  'gezel-native-0.1.49-linux-x64.tar.gz': 58057802,
  'gezel-native-0.1.49-win32-arm64-cpu.zip': 5459336,
  'gezel-native-0.1.49-win32-arm64.zip': 42048477,
  'gezel-native-0.1.49-win32-x64-cpu.zip': 8603082,
  'gezel-native-0.1.49-win32-x64-cuda.zip': 641853362,
  'gezel-native-0.1.49-win32-x64-vulkan.zip': 22326156,
  'gezel-native-0.1.49-win32-x64.zip': 56551783,
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

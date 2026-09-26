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
 *   - `NATIVE_ENGINE_ARCHIVE_SHA256` every archive hash from that same
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
export const NATIVE_ENGINE_RELEASE = '0.1.46';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '6042ed91b67b49ae42de0a0df6fdc773e4550bb172aa065e4c4591e8b3dbf684';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.46. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.46-darwin-arm64-metal.tar.gz':
    '5184c0effefb9ecfc20c6c6f9ac5395ba7c1ae8d0a9bfca306b1c7cd83d91769',
  'gezel-native-0.1.46-darwin-arm64.tar.gz':
    'ef6b84b75933253429232ac8fe80574eb26294c016725892fb0a52283be4862a',
  'gezel-native-0.1.46-linux-arm64-cpu.tar.gz':
    '51ab0e09de15dec1f5c55359c702f9e788fd4a06f421b0500f54b604b2f56b90',
  'gezel-native-0.1.46-linux-arm64-cuda.tar.gz':
    'c68b57486f8a2b3ae5c233a960175c19c16a54c407568297acffc851b68d580a',
  'gezel-native-0.1.46-linux-arm64.tar.gz':
    '7d46c1c5e0ed22075d2f9196bcaa812cfdd7ce8d77dda3cb8277d6a5dfcef60e',
  'gezel-native-0.1.46-linux-x64-cpu.tar.gz':
    'f237ecc6dc8774c4d207fad93434243513323b19f600ae088c0e3c6bcaca9cfc',
  'gezel-native-0.1.46-linux-x64-cuda.tar.gz':
    '0f2388f779f02ab6cb24c1536150c396d2667692bde0ce37891a490333073880',
  'gezel-native-0.1.46-linux-x64-vulkan.tar.gz':
    '2f14ec4d98623678beb273deed131d8ea27de220bd42f502c9338b0bd44e6d6f',
  'gezel-native-0.1.46-linux-x64.tar.gz':
    'f835386bdff7293cf6b27c973d5bfd53f3e85c74f48538708e61be9ed1e4a474',
  'gezel-native-0.1.46-win32-arm64-cpu.zip':
    '9ebc789e144f92212c96dbb18aa1212762318e26ba67f6565933931e0670f36d',
  'gezel-native-0.1.46-win32-arm64.zip':
    'c8541eb08b0d8fed07f1bc4d4e900bec4dc11dca3817f14bab93f9f0664a225f',
  'gezel-native-0.1.46-win32-x64-cpu.zip':
    '4f780d8991ddc6a4b4b129147d41df570485bb161fdf62eef456a16add249552',
  'gezel-native-0.1.46-win32-x64-cuda.zip':
    'b9736d241e20b58d58f39167891d962f70f9bd1bc36a51c4bdf265ea7cf9a6fa',
  'gezel-native-0.1.46-win32-x64-vulkan.zip':
    '434b250d4f3a0b5cf4b74658c497b5ae04988b21bd413643c720164e4e4d98a4',
  'gezel-native-0.1.46-win32-x64.zip':
    'd217d25ae045478713036cab9a062ac45ee3905a0e8bb2c056acddcd218dd53d',
});
// END PINNED NATIVE ARCHIVE HASHES

/**
 * True only when the pinned release's standalone macOS archives were
 * Developer ID signed and accepted by Apple's notary service before
 * packaging. Electron notarization is a separate distribution contract.
 */
export const NATIVE_ENGINE_MACOS_NOTARIZED = true;

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

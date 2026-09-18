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
export const NATIVE_ENGINE_RELEASE = '0.1.43';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '52576d226d4373a090d3d8f3ca4edaaf7656f2db5f6f3c65a77cb3024b1d31d2';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.43. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.43-darwin-arm64-metal.tar.gz':
    '1de3e083e7f335788af7090dfbf90ca4ea5eef714d87200409dce873ead54bb4',
  'gezel-native-0.1.43-darwin-arm64.tar.gz':
    'b20a68758591c7434a300786e53eafbad9ac15ac28b2c2a96a39b037dc5012e6',
  'gezel-native-0.1.43-linux-arm64-cpu.tar.gz':
    '0450428b0886811632e2b9f13d52d96a856962e928e13cd17e357beac0641552',
  'gezel-native-0.1.43-linux-arm64-cuda.tar.gz':
    '35ce8425595379715d35839e409f057425d8e3cdad7f35df374524f903d7670a',
  'gezel-native-0.1.43-linux-arm64.tar.gz':
    '4ea68010c6c69636e705789e643297536c213100742912d6de1e7677777c9ca0',
  'gezel-native-0.1.43-linux-x64-cpu.tar.gz':
    '61667ede2c1643852c50b3260457f18ccf2d04ebf3a8683c767083cdfc9865f8',
  'gezel-native-0.1.43-linux-x64-cuda.tar.gz':
    '81ad1f9c0a9844f4500ce885a9fc938a3b90b0c1366bc880cb18bc259a480112',
  'gezel-native-0.1.43-linux-x64-vulkan.tar.gz':
    'ef514a7fbc076924719f6c5ac527c7a2cb07a749a6968c30927c4ca106b8f416',
  'gezel-native-0.1.43-linux-x64.tar.gz':
    'c6841ce542954660f38eb45d6f1a2bcc28b44223bd6a8e63b2832458b1e8c701',
  'gezel-native-0.1.43-win32-arm64-cpu.zip':
    'ca4cb081385c3312864029df968cd332a1a170056f5c95097232d2fcf4921b48',
  'gezel-native-0.1.43-win32-arm64.zip':
    '1673e2e88a8cd5b35616ea1dc84fafa05add8a2b30fd6741dd22ce82e3962a57',
  'gezel-native-0.1.43-win32-x64-cpu.zip':
    '92914ebb587d6ff88b5115949a5d23b0acb768272377712be427e228dc59ee6e',
  'gezel-native-0.1.43-win32-x64-cuda.zip':
    '4c34c53393a7d6e42fb414cd1d6f20202701861d5d847cbc118fcb9fdb7165cf',
  'gezel-native-0.1.43-win32-x64-vulkan.zip':
    'b5dc589c1c2b4e19c7ec712556d977c8a2264dbd551673c847db70b31485c746',
  'gezel-native-0.1.43-win32-x64.zip':
    'bbc25945660f7769e8db15baa0bdfb0fa5de7f22a8014b760d681e710f8fcf44',
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

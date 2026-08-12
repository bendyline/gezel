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
export const NATIVE_ENGINE_RELEASE = '0.1.36';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '3111f038a1c0bd57b47c61403a3f50aafb73c0902d6ed1511814c7b020fec47b';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.36. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.36-darwin-arm64-metal.tar.gz':
    '6a792e1f87f60be071277b6507a8840c6862b0b89e81fb7d349fd32704a6a199',
  'gezel-native-0.1.36-darwin-arm64.tar.gz':
    '1ced23d1d118b5f12f738ac315cdbc4350223b83fb3a78bd4ac0b55563004b4a',
  'gezel-native-0.1.36-linux-arm64-cpu.tar.gz':
    '49f3b5ada3c4fe42551a049f39095737daaa4e8436a625d56977250fefa6bbca',
  'gezel-native-0.1.36-linux-arm64-cuda.tar.gz':
    '8a07cc1871513aaa16a0b235d67d00083d968d9669c12addc4a583ec2a6dc42e',
  'gezel-native-0.1.36-linux-arm64.tar.gz':
    '24e18d25215fe2199add56ccfbdaab6be714ced3b5ed3d634dcfa03776e099ea',
  'gezel-native-0.1.36-linux-x64-cpu.tar.gz':
    '471d578c7a8d9056688beed4fcc91b6812cb1fc2a5e8149c0ce1cbe431012957',
  'gezel-native-0.1.36-linux-x64-cuda.tar.gz':
    '982c169e12572a9d8e44b6f5dd7a6e0234cc50c93e8ddfef1711002452cedb88',
  'gezel-native-0.1.36-linux-x64-vulkan.tar.gz':
    'ac1396d588ab301a8f1e79f050bdfa9f0b2b4d4f0bbf02d92e1e1b0eb9807325',
  'gezel-native-0.1.36-linux-x64.tar.gz':
    '3b8abb1978f4f3af7fda3cce3e86f5c6632f83f931ad206321a167f93e8acca2',
  'gezel-native-0.1.36-win32-x64-cpu.zip':
    '9584b4be00bb7f7cb2a3393a512f7e6a25ac15bfed6ffcef757d226af54177d1',
  'gezel-native-0.1.36-win32-x64-cuda.zip':
    '859502299b179736be3fb0e50cfae0dd51d0edf04bc4971820bf40b6354be5d3',
  'gezel-native-0.1.36-win32-x64-vulkan.zip':
    '20c57fa2f8f4586bf4c8b1ad1b428ec248f79799bc758e9404bb1848c72bfa76',
  'gezel-native-0.1.36-win32-x64.zip':
    'f456a1226dcf89284007d95af13c314a3fe73c6f81b273b785d6ed10f8b1f49c',
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

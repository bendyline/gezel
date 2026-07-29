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
export const NATIVE_ENGINE_RELEASE = '0.1.26';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '34e2b2f89bd740016f3c0a47c36387f11be057fbd359cdbbfe467553e15d81fe';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.26. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.26-darwin-arm64-metal.tar.gz':
    'd0c65998b97c278ce8776d9b4dcd1703f623709b4f0195522201ce7a72a15aff',
  'gezel-native-0.1.26-darwin-arm64.tar.gz':
    'd6ca649833d78d6032fb12a29d9c9146d29cf5b1304a3ed0becfae7a62d0c50e',
  'gezel-native-0.1.26-linux-arm64-cpu.tar.gz':
    'a08025835ffe4b76d49c6460179693bd047cd55f4a9b6ebbd2e9db2f46fd6318',
  'gezel-native-0.1.26-linux-arm64-cuda.tar.gz':
    '7d3ab7c87dc6b13f156ae49570db2fc03ae03bbc9603ad0102a0977d6a796eb6',
  'gezel-native-0.1.26-linux-arm64.tar.gz':
    '096ffbb529d3c4bf308a314abb71593ba8c93cd21c2ba7607f92980c85788897',
  'gezel-native-0.1.26-linux-x64-cpu.tar.gz':
    'd4a4040300256899c422fff70553577e0fd1b9a8e016da4d9ea0e6c02283c59a',
  'gezel-native-0.1.26-linux-x64-cuda.tar.gz':
    '9ddfc68b7ba8df757e97b0019959e5fae4ed734680750e38c9ec72ed3d9156ec',
  'gezel-native-0.1.26-linux-x64-vulkan.tar.gz':
    '19ca51a92637756faa0e119b17daceac5a0b7261532b56c2dfc7d9d72068291a',
  'gezel-native-0.1.26-linux-x64.tar.gz':
    '5b176d2b4ca29d6c32a8377009bd225404c62b5da0df66b4fb5fc85dd3647876',
  'gezel-native-0.1.26-win32-x64-cpu.zip':
    '4721084830e5fcfcfa8bdf1fd6c8c4249511e97be6e56a4c02bc5b4ed6b5ef35',
  'gezel-native-0.1.26-win32-x64-cuda.zip':
    '84f9d512b50d0b29094883af1451757737cb82d3f290f5d3c1a371776b7eb7c9',
  'gezel-native-0.1.26-win32-x64-vulkan.zip':
    '6e123ce99c2a16b33a1184707110732e61bad17894f7fbbb257d5d51e150ef8a',
  'gezel-native-0.1.26-win32-x64.zip':
    'f9ab3c9dda486e2e3f4ad789785136c929f3d4f36c65030b95ec24e7c59b8c0c',
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

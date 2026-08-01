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
export const NATIVE_ENGINE_RELEASE = '0.1.29';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '7a458fedb57f60cec1a99699e15a7a2d9d553e4a59b648257fd747ff86209dd5';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.29. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.29-darwin-arm64-metal.tar.gz':
    '4b377357a4c21fd177d2e22fcd7f51e23738968d9a65398a6c8b93532fc3400c',
  'gezel-native-0.1.29-darwin-arm64.tar.gz':
    '9d43d2b2c9b12dcc7f9aad2a25c87570dd3c0c9d63310270816320525ce1e5bd',
  'gezel-native-0.1.29-linux-arm64-cpu.tar.gz':
    '8c26faf90abacd6ca6e6bb0c7100111eb33a4dbae9fe67b0588672ca878037aa',
  'gezel-native-0.1.29-linux-arm64-cuda.tar.gz':
    '01483a168e6ec89fda18313ee16b79dfbf47025e2827ab44d051926846b916fb',
  'gezel-native-0.1.29-linux-arm64.tar.gz':
    '23ab4af4a922dd13617b800fa17dedb62629d55b0f9d42a13f23bc1c48fc93f1',
  'gezel-native-0.1.29-linux-x64-cpu.tar.gz':
    '1066cd07470d0ebac9d9e81875227620afaf98f9c3f92fb5aa090d97f133116c',
  'gezel-native-0.1.29-linux-x64-cuda.tar.gz':
    'cc0ed9c13bd655dd97e950c8d53facecb1d7e511a238a060238c9ce238303b0e',
  'gezel-native-0.1.29-linux-x64-vulkan.tar.gz':
    'd801f5fc5a54ddb0aded3a850f8ffa6d78e20f801e8a98c76c8054147474170e',
  'gezel-native-0.1.29-linux-x64.tar.gz':
    '7a6ba2ab4d3d6c999f4f81ccf2d889b1448dc83df32de2961794d68ee71a91ec',
  'gezel-native-0.1.29-win32-x64-cpu.zip':
    'a91930aa7a27cc2796f48a7a4af76bdbac05000b485b6ae772e77bc3987c9d12',
  'gezel-native-0.1.29-win32-x64-cuda.zip':
    'a0dbffa9ab02c2100a5aa8f51b50b98e8a7ac3cf11270e4379eef27ec2730998',
  'gezel-native-0.1.29-win32-x64-vulkan.zip':
    '76e8eace18eed17ced331b89960fddba99b284f8f4e82874ead6029053f2aef4',
  'gezel-native-0.1.29-win32-x64.zip':
    '65cba961662ffe3a59028961ed9d44fd7cab113d0246215be77a2fc7f6fe6ee8',
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

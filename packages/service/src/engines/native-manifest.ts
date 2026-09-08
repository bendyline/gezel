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
export const NATIVE_ENGINE_RELEASE = '0.1.39';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '12b78335718edc9501f57e1bf5a526addb5b4be62741e736a1096c231ccec993';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.39. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.39-darwin-arm64-metal.tar.gz':
    '9043852823e1330d8b5c5432299709e98c38079790859adff318be82a8d6a842',
  'gezel-native-0.1.39-darwin-arm64.tar.gz':
    'a53271343e402a3768b09c03dccc03d661d98176b147543cb17661f19bfaf7d8',
  'gezel-native-0.1.39-linux-arm64-cpu.tar.gz':
    '73b33da884071520211cf21718149cc92557606182c884fa32a4d0a34ed617d9',
  'gezel-native-0.1.39-linux-arm64-cuda.tar.gz':
    '0a27399d8ccbb3c52aeb4ca8026834e9499ae4d7aa79a9d02918db0668a43c1a',
  'gezel-native-0.1.39-linux-arm64.tar.gz':
    '91c8575d431f16dd7150ddd0eb6afc068a7e803097f4938ebb1ff31690531f9e',
  'gezel-native-0.1.39-linux-x64-cpu.tar.gz':
    '86c4f09ade98ca0fd43d02ae47044c7a1118bb2fa8851ea575e0bc05680a719b',
  'gezel-native-0.1.39-linux-x64-cuda.tar.gz':
    'd68ac17f0616a5c1ce79e28ef272398fca87ff2e978d8c732f4bc489624d708d',
  'gezel-native-0.1.39-linux-x64-vulkan.tar.gz':
    '8f7f041db23353d74fb6219a152ed18ff08f0ebb83a2e82d347c39a1bde4e9cc',
  'gezel-native-0.1.39-linux-x64.tar.gz':
    '5172d5635e1c1d0ab60280c05b88c0a6f2bcd4530ac4c3daef5494c9a48b6b58',
  'gezel-native-0.1.39-win32-x64-cpu.zip':
    'c964420ec602bedfeb86e666e69ee2f6dd58c16023347d2e78f77c7ef103ea1a',
  'gezel-native-0.1.39-win32-x64-cuda.zip':
    'a9688fdc2597b2214467a96f05312d23e3cab86ce3f48ecb8570c5a96e8ecf06',
  'gezel-native-0.1.39-win32-x64-vulkan.zip':
    'c7a23fb54b7d6e35003dcf5b77ea7a69f9a233bcca83b4607d9fb1b264dd76e9',
  'gezel-native-0.1.39-win32-x64.zip':
    'fc5340736cfbdd0ade2c2f948240909c6565db2c5817887f893113c08970891e',
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

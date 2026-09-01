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
export const NATIVE_ENGINE_RELEASE = '0.1.38';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '36f3a3be792e3cd2a9f05b3bec0666d71d39067b18a5ada46103597b2d10465d';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.38. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.38-darwin-arm64-metal.tar.gz':
    '739a3e00a3ffb9c2c76aca2771d029947395ac4f6dd63cf0fa7eb862d020b855',
  'gezel-native-0.1.38-darwin-arm64.tar.gz':
    '36f39c20bca458c8b8b3ef80027816226cd5ed6daac7cdb74101f90e6dec28d1',
  'gezel-native-0.1.38-linux-arm64-cpu.tar.gz':
    '10d22bd36a95914e0ae0f834236b0358b263191845139938214826368bc65da8',
  'gezel-native-0.1.38-linux-arm64-cuda.tar.gz':
    'a7b762e90b9efccc86b95e5edd9bc55c5343867a0915790b96adc34ab1e41961',
  'gezel-native-0.1.38-linux-arm64.tar.gz':
    'db894132cfdad3b319bb6691e5a6ea858db86884b8856f17e8b4a0bebf4534f8',
  'gezel-native-0.1.38-linux-x64-cpu.tar.gz':
    'de1f27775efefd9781c8b2acd068aad6ae0ca96b12f42357fddc8e19ed069c61',
  'gezel-native-0.1.38-linux-x64-cuda.tar.gz':
    '0dcedbb8711b63f9b1b9ea8269988559c0aa98059d086a84c926c3fed5abe6b8',
  'gezel-native-0.1.38-linux-x64-vulkan.tar.gz':
    '6c05a49adb85ee26e9462b9425f979c7f6dfe3a2774d5c11ae858679c6cd0559',
  'gezel-native-0.1.38-linux-x64.tar.gz':
    'fae068d5a25d2e3071828caab02971b3c00ffe44ffc052c8d73254c54843904a',
  'gezel-native-0.1.38-win32-x64-cpu.zip':
    '7603502abd994dc8365f8fd777b9ae9273ca01667f9cdc57629877b8fbcc1157',
  'gezel-native-0.1.38-win32-x64-cuda.zip':
    '0ff19f626d41164defdae7866f00fdab7348ae8e54f2e0584f130cc7c70a125c',
  'gezel-native-0.1.38-win32-x64-vulkan.zip':
    '5ac0aaa247be34c641c8c850d90bab7b860d792be393a948b4001751c047f94b',
  'gezel-native-0.1.38-win32-x64.zip':
    'fd583799416ec82723b2fc91a7df9d4b516e160f2d9a450514e7b39c847d2a77',
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

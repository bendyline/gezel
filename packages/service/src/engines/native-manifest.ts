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
export const NATIVE_ENGINE_RELEASE = '0.1.48';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '39d75e65acbfa76395385afa3ec6729c6e6f365695f6de15735dcfb2ad078c1a';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.48. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.48-darwin-arm64-metal.tar.gz':
    'c5d585f82ad60a6a2e626aada3d893e548d4222defba35d483ae4b63a42de5e1',
  'gezel-native-0.1.48-darwin-arm64.tar.gz':
    'ff2541f35a84a7c21ef74c50595836ffeea2a4d2bb9586d1330db1046f8db1f0',
  'gezel-native-0.1.48-linux-arm64-cpu.tar.gz':
    '36a92ae97bd99dd66207fb3afaed933aa7c151053305aa0351df69c83fabe961',
  'gezel-native-0.1.48-linux-arm64-cuda.tar.gz':
    'deb3d40fd56586e01ddedc2ccc4ba494feb56a19b5e0c201ead6397a091fe287',
  'gezel-native-0.1.48-linux-arm64.tar.gz':
    '5554d4c4b363658e3e6d45ade60d1f3fc6e80ac84a56194ad4a00abc57cc7916',
  'gezel-native-0.1.48-linux-x64-cpu.tar.gz':
    '81d9a5f0afc686c2143a6648d080dbff1f4b2e3e011e3705a14fb5501f300cd6',
  'gezel-native-0.1.48-linux-x64-cuda.tar.gz':
    '84a5ebbe87f9c6c9b6034ebdb6d4ea86ef9c8b55d2e6e398c7f2c986dfa4cbe7',
  'gezel-native-0.1.48-linux-x64-vulkan.tar.gz':
    '42a43de7dae8be373725cc33a6d8b18b8b173a778078893b8ae55acfc9cb1ed5',
  'gezel-native-0.1.48-linux-x64.tar.gz':
    'c954a0e3f89f8e069c3b085af582436a67bac9323221858cc8080d8dba12afc9',
  'gezel-native-0.1.48-win32-arm64-cpu.zip':
    '220ce86f4493e1351191a3afc26c5a1633bb0566b21b8378c9ec92905ac771ab',
  'gezel-native-0.1.48-win32-arm64.zip':
    '390164dc761cf069765446e06e782dd61122aef87918497a0b20bc50991249aa',
  'gezel-native-0.1.48-win32-x64-cpu.zip':
    '8faa72eae3e8e446c1dc1e60f8b68daa7276030cd210e0b1fde013ae1346f7b1',
  'gezel-native-0.1.48-win32-x64-cuda.zip':
    'fbbd02208e551a66882389189c8e66bed2240f83b74dea631ccc4f438d8fd65e',
  'gezel-native-0.1.48-win32-x64-vulkan.zip':
    'e0addf75c0144399f9ac2d3771ed9afe5cc0b602084bfa12a9262c1ba04ef12b',
  'gezel-native-0.1.48-win32-x64.zip':
    '44654bdf67c9fe528176927eebf3552b14cb71228ef73e915f94d1c56cf2cc1c',
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

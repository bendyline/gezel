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
export const NATIVE_ENGINE_RELEASE = '0.1.25';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = 'a230ed74a38c074df59c1acc72e04d1d11c32d27547d007221f0b0d9d64d1cbf';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.25. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.25-darwin-arm64-metal.tar.gz':
    'a0ca402a686eef983b5c4f1806cf8b2085effda82a68d237e326f527bb3db96b',
  'gezel-native-0.1.25-darwin-arm64.tar.gz':
    'b086282fd071d2bd714de3a31f9814371cefd6882ac18f7d8de79868f5f1d2c0',
  'gezel-native-0.1.25-linux-arm64-cpu.tar.gz':
    '881633ff47ca08f892c2148ad7afc9cc9eacced554068c313133c13d47d8c546',
  'gezel-native-0.1.25-linux-arm64-cuda.tar.gz':
    '35d82160e230bd703ae8daf90165f52de1285060620e4edebf9c9cd37c23c5ca',
  'gezel-native-0.1.25-linux-arm64.tar.gz':
    '9b74a08bb2e685dcd73570ad76752f4383d307e160661f0e8a1775b1e3564d28',
  'gezel-native-0.1.25-linux-x64-cpu.tar.gz':
    '87488990828913b332349b929ba98598a8c9e151aeacde062db3a1a4a8649253',
  'gezel-native-0.1.25-linux-x64-cuda.tar.gz':
    '167ebaaf3755af72f647086c8d791d8c6c827fad58eca4ef9546902567e49ceb',
  'gezel-native-0.1.25-linux-x64-vulkan.tar.gz':
    '47e6efe613ec84807e64b24efc40a7360eff64ac543fc0aa9179195f394733a0',
  'gezel-native-0.1.25-linux-x64.tar.gz':
    'aa57873020089dafcb4f237d33ee2a20bc78634321372bfa43485a0f210a5a93',
  'gezel-native-0.1.25-win32-x64-cpu.zip':
    '1836caae51a87b37ae636e94b96368c0dc595c387763c9233a20133a5b83fd84',
  'gezel-native-0.1.25-win32-x64-cuda.zip':
    '9da905dd3f97e2334e6a01ce65279bef564a22437f0a5d03a3843fc55ddef577',
  'gezel-native-0.1.25-win32-x64-vulkan.zip':
    'fd8e2bdd050490bcc77fc9d6b4568f36e1558646de12a5b01256ca84ad2d73e9',
  'gezel-native-0.1.25-win32-x64.zip':
    '97d4ac65369637eafc58858f3fa46e44ce588b400bdda2d35d80531552e04fe5',
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

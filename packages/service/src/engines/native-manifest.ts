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
export const NATIVE_ENGINE_RELEASE = '0.1.19';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '35559474a6c852c01091525177d6f9e95fec1356be7b1f3c966e9494113420e0';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.19. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.19-darwin-arm64-metal.tar.gz':
    '5bbb331ea66c5c9be88ec91e39d46abb2f169f0794061e43f2a6fa4225667ca1',
  'gezel-native-0.1.19-darwin-arm64.tar.gz':
    '07e015d8bde62e56aa4fb5194108c412c4d61bd0f5bd7f23d2d0aa2f833bb93c',
  'gezel-native-0.1.19-linux-arm64-cpu.tar.gz':
    '0a1b59c11a1b7458574ebfe22d5c0d696ef1316afe4267d0fed75dba55bc0f6c',
  'gezel-native-0.1.19-linux-arm64-cuda.tar.gz':
    'cc85b7a856a28c5ac19655005e5bb471c801d44402beec4991ab2b76e2ec3c3e',
  'gezel-native-0.1.19-linux-arm64.tar.gz':
    'cbbe42446d92fb88ceeab291ca5583b4c716f2ac7ddd4060d0673427c38ffc9b',
  'gezel-native-0.1.19-linux-x64-cpu.tar.gz':
    '5cb604035d7ccbb67cfaf01bf53e1b2e6d1da543b9b6c735c5a2bb2a92bc4232',
  'gezel-native-0.1.19-linux-x64-cuda.tar.gz':
    '22c763b679eda1fd4599aa12e78f72118943ff543395d5047a108d71f020ec07',
  'gezel-native-0.1.19-linux-x64-vulkan.tar.gz':
    '9c6507673eccd6a4e51e2f51a78b3ba583f5e2f3bc7cc39e4e0c6dc9c3843318',
  'gezel-native-0.1.19-linux-x64.tar.gz':
    'd45f0638ff5f0a5e36d708dbe3b54cdffbd9fdec5515fb6a175de32f4e2ca326',
  'gezel-native-0.1.19-win32-x64-cpu.zip':
    '53887cfc090e81d649fbeecf42887835431902e5db3e9ca4b9489bc048b3c8e9',
  'gezel-native-0.1.19-win32-x64-cuda.zip':
    'a4df3aa97c96408c7df2842ff42e073963a9ddcafdcc89712d6f8e4724530435',
  'gezel-native-0.1.19-win32-x64-vulkan.zip':
    'e3470567b83a67d07f7763ad48b93c5edfbdf6f131978d953acde8e33ef6f336',
  'gezel-native-0.1.19-win32-x64.zip':
    '7f8af4a8ea3aaa384a480a4b8170702420bb2992dbde140406322e861edb5bcd',
});
// END PINNED NATIVE ARCHIVE HASHES

/**
 * native-v0.1.19 is Developer ID signed, but its standalone archives were
 * not submitted to Apple's notary service. The Electron release notarizes
 * its enclosing app later; that is not the same distribution contract.
 */
export const NATIVE_ENGINE_MACOS_NOTARIZED = false;

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

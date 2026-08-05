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
export const NATIVE_ENGINE_RELEASE = '0.1.31';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = 'f08b166235c1362e1e2d3db2bb44f6685b391710f71ed6d0b13b74c30d481294';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every archive published by native-v0.1.31. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.31-darwin-arm64-metal.tar.gz':
    '1c96b9ce9917775ea0bf129267ec23e91086241be16064b237e309d32df1371a',
  'gezel-native-0.1.31-darwin-arm64.tar.gz':
    '2a5c54d8343813b6a4eb4cabf2941db36c94f53b20a0300061fe42821f1bc752',
  'gezel-native-0.1.31-linux-arm64-cpu.tar.gz':
    'cc7f5415727478ddc0f9a9e2bd0a85c67738adee1a46d56db608fb9dd95d21ec',
  'gezel-native-0.1.31-linux-arm64-cuda.tar.gz':
    'd6ccbb1eecee804f9191ae27a3bbe678ca60271d0ba191c59871e33100303ff6',
  'gezel-native-0.1.31-linux-arm64.tar.gz':
    'e4853c7109f59bb6241ff5450ba21859d19f3a0b08f111c532c0a30d88425410',
  'gezel-native-0.1.31-linux-x64-cpu.tar.gz':
    '32a57f189f5e8f07298bf633c22171bd55972ee27f24a38da0c538bdb57ad122',
  'gezel-native-0.1.31-linux-x64-cuda.tar.gz':
    '13ddc2fbdf5548ad803f25098a3afcd911a342f2848eb76c5cef0805c3fad993',
  'gezel-native-0.1.31-linux-x64-vulkan.tar.gz':
    '2320c51bb5a090d9df8ef3a29c025b70fd26b1d2537de04a028eaf4117b46c90',
  'gezel-native-0.1.31-linux-x64.tar.gz':
    '73eab4623c1240f8b32e1174b1561468af3eec64595f0a6b26656d07577d912e',
  'gezel-native-0.1.31-win32-x64-cpu.zip':
    'e637b02ed5e7ad2227a121f02c65cbbc8b4f10d99058d77325e0e08c7ee89228',
  'gezel-native-0.1.31-win32-x64-cuda.zip':
    'ba79aaadcb13af2b6cbc13253dfe5d6f6ce970686a68cbd06d48b7ad997eda7a',
  'gezel-native-0.1.31-win32-x64-vulkan.zip':
    '7c575655f74d069223a7f80166d6e0d0c7250045e1c52363ccc9c5b0f108239a',
  'gezel-native-0.1.31-win32-x64.zip':
    'd3c35001ba6057dfc3b17d4ec30350d8fa63489a07b46afb6fdc798176334304',
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

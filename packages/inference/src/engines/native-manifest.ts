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
export const NATIVE_ENGINE_RELEASE = '0.1.65';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '9a2601591af7281ad793da05f84c2a494b16081bc1ed54013790f55fbe8e4630';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.65. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.65-darwin-arm64-metal.tar.gz':
    'a455b1d34ac9be0252b13c150d5460cca273b0350ef556f0fcc6c7fe0f2458cb',
  'gezel-native-0.1.65-darwin-arm64.tar.gz':
    'a24047ee526820a4eb03270e4a6640dcaceaac76cfe7f9edf1b7bdaffa7bf7f2',
  'gezel-native-0.1.65-linux-arm64-cpu.tar.gz':
    '2ce55b21d64191a392853be0a0d05253bce865e7c0c0271dd4fda01a832ee71d',
  'gezel-native-0.1.65-linux-arm64-cuda.tar.gz':
    'd5fafb764ace8e7069b078b511bfcce59f8f6c3b98804b83d89b90d2b15c8043',
  'gezel-native-0.1.65-linux-arm64.tar.gz':
    '83cc61fa45ff76c50adeca41b8bb19f7cf7d8de8a8e602063f7b4377cd0bb601',
  'gezel-native-0.1.65-linux-x64-cpu.tar.gz':
    '4d5708ddfad47cf982e245ecfc783008bf5e44e9192579c34ae6ec1932c8d97a',
  'gezel-native-0.1.65-linux-x64-cuda.tar.gz':
    '17005648fc68b097d940782c290547ffeced4d5e1de39d9f37c6997af6f921a9',
  'gezel-native-0.1.65-linux-x64-rocm.tar.gz':
    '76470faca95e744a217cff3ecd3ff3a2f7590263aed246b4ea4ce96af283a944',
  'gezel-native-0.1.65-linux-x64-vulkan.tar.gz':
    'ac829e043f8876105aa3173cd81363bfc2ebb78225af798aa31db6e561ec75a0',
  'gezel-native-0.1.65-linux-x64.tar.gz':
    '927464fc12bb4eea4d3bd5a75ba10eaa808d60cd364a386be97045d5e0b79ded',
  'gezel-native-0.1.65-win32-arm64-cpu.zip':
    'd8edfd3174a128868ad9401db8609efec83eeac4ffd0fbd0c839b199285f239b',
  'gezel-native-0.1.65-win32-arm64-cuda.zip':
    '181898eabbed63643210d532b84fce0d945e277809d6c61333dffc98037ed3d6',
  'gezel-native-0.1.65-win32-arm64.zip':
    '9d164504b67b8b3262ccc20863da8550fe15f67e82944dabb43c12439ab38f9d',
  'gezel-native-0.1.65-win32-x64-cpu.zip':
    '088e468a6575fedbf6163df0b4241f3ae02671fc387ba551fb4705a4de1ecf47',
  'gezel-native-0.1.65-win32-x64-cuda.zip':
    '1617e0eb6f5d93c3f70fa466d7e966b6a41dd7e7b14bc769f0192b59e2597a6b',
  'gezel-native-0.1.65-win32-x64-rocm.zip':
    '360529b1b264cb8ee51364787c400ff32f91c52e498b08820f5f554ba28acb3a',
  'gezel-native-0.1.65-win32-x64-vulkan.zip':
    'a138501612c20296e468074d532585edf8fe5c0f9cab4cc61e053c4b50f8eb74',
  'gezel-native-0.1.65-win32-x64.zip':
    'b832276c92022c4bbaebb014e1da7501ecd23892a3e3645b01109f49dc97a878',
});

/** Download size in bytes of every engine archive published by native-v0.1.65. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.65-darwin-arm64-metal.tar.gz': 8301654,
  'gezel-native-0.1.65-darwin-arm64.tar.gz': 42919309,
  'gezel-native-0.1.65-linux-arm64-cpu.tar.gz': 10225170,
  'gezel-native-0.1.65-linux-arm64-cuda.tar.gz': 629696110,
  'gezel-native-0.1.65-linux-arm64.tar.gz': 43076743,
  'gezel-native-0.1.65-linux-x64-cpu.tar.gz': 14565424,
  'gezel-native-0.1.65-linux-x64-cuda.tar.gz': 1054735088,
  'gezel-native-0.1.65-linux-x64-rocm.tar.gz': 321591097,
  'gezel-native-0.1.65-linux-x64-vulkan.tar.gz': 28384107,
  'gezel-native-0.1.65-linux-x64.tar.gz': 58390904,
  'gezel-native-0.1.65-win32-arm64-cpu.zip': 6847487,
  'gezel-native-0.1.65-win32-arm64-cuda.zip': 251102248,
  'gezel-native-0.1.65-win32-arm64.zip': 42809701,
  'gezel-native-0.1.65-win32-x64-cpu.zip': 10009372,
  'gezel-native-0.1.65-win32-x64-cuda.zip': 799689156,
  'gezel-native-0.1.65-win32-x64-rocm.zip': 249366609,
  'gezel-native-0.1.65-win32-x64-vulkan.zip': 23449441,
  'gezel-native-0.1.65-win32-x64.zip': 56201321,
});
// END PINNED NATIVE ARCHIVE HASHES

/**
 * True only when the pinned release's standalone macOS archives were
 * Developer ID signed and accepted by Apple's notary service before
 * packaging. Electron notarization is a separate distribution contract.
 */
export const NATIVE_ENGINE_MACOS_NOTARIZED = true;

/**
 * The download size of the archive the resolver fetches for this platform
 * and variant, when this build pins it. Undefined under a dev release
 * override, whose archives this build has no sizes for.
 */
export function pinnedEngineArchiveBytes(
  platformKey: string,
  variant: string | undefined,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  if (effectiveEngineRelease() !== NATIVE_ENGINE_RELEASE) return undefined;
  const key = variant ? `${platformKey}-${variant}` : platformKey;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return NATIVE_ENGINE_ARCHIVE_BYTES[`gezel-native-${NATIVE_ENGINE_RELEASE}-${key}.${ext}`];
}

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

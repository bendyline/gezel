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
export const NATIVE_ENGINE_RELEASE = '0.1.52';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '1a2183ad785671be0f78a0f25816f7c802ce668ebe4fa58d640d336ebcbd7023';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.52. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.52-darwin-arm64-metal.tar.gz':
    '8c8619530592692ad9fd905823a5bc7772a652d4257905919dac088c5fa86347',
  'gezel-native-0.1.52-darwin-arm64.tar.gz':
    '3088b7d97968ea206bf58a516da2a9c635d7622672da220d48d790fd5555a797',
  'gezel-native-0.1.52-linux-arm64-cpu.tar.gz':
    'ec4b992eb372e735156691950eadb2aa8f7e5ef29437b53a9da6fe8cc2a7912b',
  'gezel-native-0.1.52-linux-arm64-cuda.tar.gz':
    '4f97fd70f0d132f0bfcaadfd113f63add7d8b63982edf8b1b7a46301702047f5',
  'gezel-native-0.1.52-linux-arm64.tar.gz':
    '3fa2c58ff75bea7ec0f739821250307bfba78cb026779ec3ad1ef935286af534',
  'gezel-native-0.1.52-linux-x64-cpu.tar.gz':
    '1fbfd06acfea1ef9e2629c121da2d7da13ee2e76a0cebb8cf07b779938817966',
  'gezel-native-0.1.52-linux-x64-cuda.tar.gz':
    '5c3c05f285c3922845b72e470ecfcd5e510b874a35ae841cd655a7098b541ffd',
  'gezel-native-0.1.52-linux-x64-vulkan.tar.gz':
    '33a6dd016bd2cf0aada7f34c364a457acc524373b52a1d3f1f6e83c1240e93a7',
  'gezel-native-0.1.52-linux-x64.tar.gz':
    'f17afac30f984da17b6098bf5f9c5e88e9f9e128b8fbea0b5ff67a360a494313',
  'gezel-native-0.1.52-win32-arm64-cpu.zip':
    '49f011b05eec55cc3f60730fdd46e3d28de331f60b195eb29abaa04fe62835a3',
  'gezel-native-0.1.52-win32-arm64-cuda.zip':
    '7dbc99fd9516ea5a5cc49ad2c157bb66a240ecc2b5a5e22fae33142a6615caec',
  'gezel-native-0.1.52-win32-arm64.zip':
    'dfe61d86eae932e03d92665aa42b81121e21cfa76a85424d993b5726ee5fa504',
  'gezel-native-0.1.52-win32-x64-cpu.zip':
    'b1147052367daf694d6001ef0d45a8897a39a1d74cb776a42f22529d5c21f919',
  'gezel-native-0.1.52-win32-x64-cuda.zip':
    '3c9568591d19ba04ceb12ae2e9f9f2a4ac7ade4597458a8674d444c06407324f',
  'gezel-native-0.1.52-win32-x64-vulkan.zip':
    '9cb1e7721d1dbebfa830ec8cba1bbbbcb41f0145d60461e4bf50c4e347feecb2',
  'gezel-native-0.1.52-win32-x64.zip':
    '7c94605b0783695174773ac2327274d91bb9d7ae31e7d932a2b9df78d44424df',
});

/** Download size in bytes of every engine archive published by native-v0.1.52. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.52-darwin-arm64-metal.tar.gz': 7056567,
  'gezel-native-0.1.52-darwin-arm64.tar.gz': 42206061,
  'gezel-native-0.1.52-linux-arm64-cpu.tar.gz': 8836310,
  'gezel-native-0.1.52-linux-arm64-cuda.tar.gz': 620408821,
  'gezel-native-0.1.52-linux-arm64.tar.gz': 42037958,
  'gezel-native-0.1.52-linux-x64-cpu.tar.gz': 12914985,
  'gezel-native-0.1.52-linux-x64-cuda.tar.gz': 993543364,
  'gezel-native-0.1.52-linux-x64-vulkan.tar.gz': 25672744,
  'gezel-native-0.1.52-linux-x64.tar.gz': 57183428,
  'gezel-native-0.1.52-win32-arm64-cpu.zip': 5618616,
  'gezel-native-0.1.52-win32-arm64-cuda.zip': 219555740,
  'gezel-native-0.1.52-win32-arm64.zip': 42114295,
  'gezel-native-0.1.52-win32-x64-cpu.zip': 8714442,
  'gezel-native-0.1.52-win32-x64-cuda.zip': 749856660,
  'gezel-native-0.1.52-win32-x64-vulkan.zip': 21123132,
  'gezel-native-0.1.52-win32-x64.zip': 55662940,
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

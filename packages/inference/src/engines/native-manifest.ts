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
export const NATIVE_ENGINE_RELEASE = '0.1.55';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '12cefeabcb0b6dafbf2acba684dcdc65e69accae31e1208329ddcfee4f594578';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.55. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.55-darwin-arm64-metal.tar.gz':
    'a78b42160946965d769322066624becb2ac77947a1cd262c787d4f5959b503e0',
  'gezel-native-0.1.55-darwin-arm64.tar.gz':
    '622f99bcdd0af7ba7c7582e01832624a79b6b5c8982b56b598dfd25c0efb3e12',
  'gezel-native-0.1.55-linux-arm64-cpu.tar.gz':
    'e1f2134dcfee3cd8afd42934116c8c04068533517a812eb69b84dbf6b858282d',
  'gezel-native-0.1.55-linux-arm64-cuda.tar.gz':
    '910fe1fd08f555e1956bf95456b7674cc7b721756297b4ab7612180a7f147394',
  'gezel-native-0.1.55-linux-arm64.tar.gz':
    '2f574a6e94b501293c14da2f6881ad495241d770cd76e6f3c5c82d57a194c70e',
  'gezel-native-0.1.55-linux-x64-cpu.tar.gz':
    'eef15b1c8e0e8f10169620366f323e92e4cea3210f28253b530483bbc82ca8fd',
  'gezel-native-0.1.55-linux-x64-cuda.tar.gz':
    '1c521154b2e6cf576f3719320053c170129bb74fcc2c101eaf6da90eeb3f7d6e',
  'gezel-native-0.1.55-linux-x64-vulkan.tar.gz':
    'ecf1a223e25bddbf856eae711335e2d0599a5de787449ad848cb684954ee69ce',
  'gezel-native-0.1.55-linux-x64.tar.gz':
    '1df89aafc1bac343c6179c619d217f94b12a35d90ae51d53b722cb721d4ec80e',
  'gezel-native-0.1.55-win32-arm64-cpu.zip':
    'e18c4df20fcd316589fb0db872fcdc689f5a5e0916b80c90620ac5ab530dfca4',
  'gezel-native-0.1.55-win32-arm64-cuda.zip':
    '3c78100c16f88b388ee1bc3c67b4083bb21b55d1d5d7685ab3444c52199f1517',
  'gezel-native-0.1.55-win32-arm64.zip':
    '8d5d6f6bfb97bb06fdfb1f678202d83bd34345e1e48a2e75b80a9271a3fbad72',
  'gezel-native-0.1.55-win32-x64-cpu.zip':
    '927dd4577049f4c28389ed79af96313208877e0acbdc4ee0e31295c14cc2c8c6',
  'gezel-native-0.1.55-win32-x64-cuda.zip':
    'ca542242d959d2e26592dc33bfef27e0469e5d172355fa2871a796ff25fbeaf8',
  'gezel-native-0.1.55-win32-x64-vulkan.zip':
    '0831fc19871c9810623245eb7e6894c9e7cc321db89d775f7b1531d0c666096f',
  'gezel-native-0.1.55-win32-x64.zip':
    '7c199d85b305d66266bd047053e99b7b2af3f44b30bc5a5360b20f113705f7aa',
});

/** Download size in bytes of every engine archive published by native-v0.1.55. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.55-darwin-arm64-metal.tar.gz': 7388002,
  'gezel-native-0.1.55-darwin-arm64.tar.gz': 42223983,
  'gezel-native-0.1.55-linux-arm64-cpu.tar.gz': 9223187,
  'gezel-native-0.1.55-linux-arm64-cuda.tar.gz': 621626307,
  'gezel-native-0.1.55-linux-arm64.tar.gz': 42036572,
  'gezel-native-0.1.55-linux-x64-cpu.tar.gz': 13398320,
  'gezel-native-0.1.55-linux-x64-cuda.tar.gz': 1000324682,
  'gezel-native-0.1.55-linux-x64-vulkan.tar.gz': 26290461,
  'gezel-native-0.1.55-linux-x64.tar.gz': 57185673,
  'gezel-native-0.1.55-win32-arm64-cpu.zip': 6049206,
  'gezel-native-0.1.55-win32-arm64-cuda.zip': 243595126,
  'gezel-native-0.1.55-win32-arm64.zip': 42236453,
  'gezel-native-0.1.55-win32-x64-cpu.zip': 9131430,
  'gezel-native-0.1.55-win32-x64-cuda.zip': 756437370,
  'gezel-native-0.1.55-win32-x64-vulkan.zip': 21673873,
  'gezel-native-0.1.55-win32-x64.zip': 55668335,
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

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
export const NATIVE_ENGINE_RELEASE = '0.1.57';

/** sha256 of the pinned release's `SHA256SUMS` asset. All-zeros = unpinned. */
export const SHA256SUMS_DIGEST = '977b0ad4cdb8983ed44d7a3223267038b1f35b2806d8a1807d7d15c5c7e94f47';

// BEGIN PINNED NATIVE ARCHIVE HASHES
/** Exact SHA256 values for every engine archive published by native-v0.1.57. */
export const NATIVE_ENGINE_ARCHIVE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'gezel-native-0.1.57-darwin-arm64-metal.tar.gz':
    '6b97be648b032980cf73663db4424140f4cc04577972dc283b956af677ce884a',
  'gezel-native-0.1.57-darwin-arm64.tar.gz':
    'e8ca070c4d3961e95946ed32fe7376ddbc97e407dd3f5b78e26cab20c8fb286a',
  'gezel-native-0.1.57-linux-arm64-cpu.tar.gz':
    'cc87822123602a0024c63a0d65789232a665140cb2fe37b106d5bd680d12f795',
  'gezel-native-0.1.57-linux-arm64-cuda.tar.gz':
    '315a441e5698800945f7030e9da961e20f3cf379a4b75c98e1d6ba88c8fee1c5',
  'gezel-native-0.1.57-linux-arm64.tar.gz':
    '0684b77d23f008f8a2aa0d9d8931437bacd8569fb6c10d3ddab61a5fb25b6a06',
  'gezel-native-0.1.57-linux-x64-cpu.tar.gz':
    'b2100842f51c393b92667535798e49932173d52626f5ae72c40005b3408f1201',
  'gezel-native-0.1.57-linux-x64-cuda.tar.gz':
    '2fca7720614687e8491be17366060c604551257199d395f795b27a87216bcde9',
  'gezel-native-0.1.57-linux-x64-vulkan.tar.gz':
    'c1014a1fe1d241ad1ee9abfa5badafcce208cbff8d38b4b4deb4779f31a95bef',
  'gezel-native-0.1.57-linux-x64.tar.gz':
    'a7f3dbe1941c3d03ed121c32be1bdd199aea47080b03d89989590a0f5d13c5ff',
  'gezel-native-0.1.57-win32-arm64-cpu.zip':
    '12d66681cec1872f23b015c7d0bd45a25ed262342da6b0ecea8bea303adf2105',
  'gezel-native-0.1.57-win32-arm64-cuda.zip':
    'b437a9f0894673179f91a1af75d5d7d058dafa1b4f48a57eab123596f1c21ca4',
  'gezel-native-0.1.57-win32-arm64.zip':
    '21cddb8b733f9a2669d64b1ada18002f60bb2779f2d5e2aacfb88214db00da7e',
  'gezel-native-0.1.57-win32-x64-cpu.zip':
    'a81f7c6754f1954a0ed5de1efc47d6194dc60d912138a9d2b8e4f992168b12c6',
  'gezel-native-0.1.57-win32-x64-cuda.zip':
    '9e3f21713fe77c23536dd4124244ac3834f90c82d6e470cb6836a73bb4f7c592',
  'gezel-native-0.1.57-win32-x64-vulkan.zip':
    '0d473300317b4f6cb072bdd7875ce1536a85fe50e781c435e1aef1c4cbdb08e5',
  'gezel-native-0.1.57-win32-x64.zip':
    '89a073abcfc97e50b9a0c39f56862b51ac21139b7ca4a3e7a75105dca56292a2',
});

/** Download size in bytes of every engine archive published by native-v0.1.57. */
export const NATIVE_ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = Object.freeze({
  'gezel-native-0.1.57-darwin-arm64-metal.tar.gz': 7387963,
  'gezel-native-0.1.57-darwin-arm64.tar.gz': 42223786,
  'gezel-native-0.1.57-linux-arm64-cpu.tar.gz': 9223249,
  'gezel-native-0.1.57-linux-arm64-cuda.tar.gz': 621626283,
  'gezel-native-0.1.57-linux-arm64.tar.gz': 42040003,
  'gezel-native-0.1.57-linux-x64-cpu.tar.gz': 13398337,
  'gezel-native-0.1.57-linux-x64-cuda.tar.gz': 1000325316,
  'gezel-native-0.1.57-linux-x64-vulkan.tar.gz': 26290440,
  'gezel-native-0.1.57-linux-x64.tar.gz': 57190295,
  'gezel-native-0.1.57-win32-arm64-cpu.zip': 6049234,
  'gezel-native-0.1.57-win32-arm64-cuda.zip': 243595554,
  'gezel-native-0.1.57-win32-arm64.zip': 42236484,
  'gezel-native-0.1.57-win32-x64-cpu.zip': 9131460,
  'gezel-native-0.1.57-win32-x64-cuda.zip': 756439338,
  'gezel-native-0.1.57-win32-x64-vulkan.zip': 21673895,
  'gezel-native-0.1.57-win32-x64.zip': 55668381,
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

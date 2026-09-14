/**
 * Which platforms can run a bundled engine, and which engine they get.
 *
 * This lives in core, beside {@link resolvePlatformKey}, because it is the
 * same kind of fact — a property of the build matrix, not of the daemon — and
 * because four separate callers need it and only one of them can import the
 * service: `default-provider.ts` and the first-run bootstrap (service), the
 * `gezel model` commands and the TUI model picker (CLI).
 *
 * Before this module the darwin-arm64 rule was written out four times as an
 * inline ternary. The service's own docblock claimed the default and the
 * first-run pin "can never disagree", which was true of those two and false of
 * the other two: the CLI copies would have kept routing a new platform to
 * llama.cpp no matter what the matrix said.
 */

/**
 * Platform keys we ship a bundled `llama-server` for — see
 * `.github/workflows/build-native.yml`.
 *
 * First-run auto-enrols users into on-device only on these combos; everyone
 * else (notably Intel Mac) lands on a cloud provider by default rather than
 * downloading a 3-10 GB model that would then fail with "no engine bundled"
 * at the first chat turn.
 *
 * **Keep this in step with the build matrix.** Adding a platform there without
 * adding it here ships binaries nothing ever selects.
 */
export const SUPPORTED_ON_DEVICE_PLATFORMS: ReadonlyArray<`${NodeJS.Platform}-${string}`> = [
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
];

export function isSupportedOnDevicePlatform(platform: NodeJS.Platform, arch: string): boolean {
  return (SUPPORTED_ON_DEVICE_PLATFORMS as readonly string[]).includes(`${platform}-${arch}`);
}

/** The local inference engine a given platform should use. */
export type OnDeviceProvider = 'mlx' | 'llama-cpp';

/**
 * Apple Silicon gets MLX — it is measurably faster than llama.cpp Metal there.
 * Everything else gets llama.cpp, including Windows-on-ARM, which ships a
 * CPU-only llama build. MLX cannot run anywhere but Apple Silicon.
 *
 * Note this answers for a *machine*, so a caller comparing a remote daemon's
 * platform against its own must pass the one it actually means.
 */
export function resolveOnDeviceProvider(platform: NodeJS.Platform, arch: string): OnDeviceProvider {
  return platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'llama-cpp';
}

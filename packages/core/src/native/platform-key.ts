/**
 * Map a (platform, arch) pair to the subdirectory name used under
 * the bundled `native-bin/` tree (e.g. `win32-x64`, `darwin-arm64`,
 * `linux-arm64`). Returns `null` on platforms we don't ship engine
 * binaries for; callers should treat that as "no bundled engine
 * available" and avoid further probing.
 *
 * Mirrors `packages/app/src/supervisor/native-bin.ts` — kept in sync
 * because both the supervisor (pre-spawn) and the service (system
 * service launches) resolve the same per-platform subtree.
 */
export function resolvePlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64';
  }
  return null;
}

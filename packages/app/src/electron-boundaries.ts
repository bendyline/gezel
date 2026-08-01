import { resolve } from 'node:path';

/**
 * Detect the "we were told to be the daemon but booted as an app" launch.
 *
 * The supervisor spawns `process.execPath` with the gezeld entrypoint, which
 * only runs the daemon when the child environment carries
 * `ELECTRON_RUN_AS_NODE=1`. Without it Electron ignores the script argument
 * and starts a second Gezel: no runtime files ever appear, the parent burns
 * its whole startup budget, falls back to embedded, and the second copy takes
 * the same branch and spawns a third. Returns the offending argument so main
 * can name it and exit rather than stall.
 */
export function daemonEntrypointArgument(argv: readonly string[]): string | null {
  return argv.slice(1).find((arg) => /(^|[\\/])gezeld\.js$/.test(arg)) ?? null;
}

/** Pure policy used by the Electron navigation hook (kept out of main.ts for testing). */
export function isAllowedTopLevelNavigation(
  candidate: string,
  allowedOrigin: string | null,
  allowedFileUrl: string | null,
): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'file:')
      return allowedFileUrl !== null && parsed.href === allowedFileUrl;
    return allowedOrigin !== null && parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

/** Compare already-realpathed directories without accidentally authorizing descendants. */
export function isExactApprovedPath(
  target: string,
  approved: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalize = (path: string) => {
    const absolute = resolve(path);
    return platform === 'win32' || platform === 'darwin' ? absolute.toLowerCase() : absolute;
  };
  const normalizedTarget = normalize(target);
  return approved.some((path) => normalize(path) === normalizedTarget);
}

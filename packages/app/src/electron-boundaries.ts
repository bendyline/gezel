import { resolve } from 'node:path';

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

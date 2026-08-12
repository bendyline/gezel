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

/** True only for a capability-bearing preview document on this daemon. */
export function isPreviewDocumentUrl(candidate: string, allowedOrigin: string | null): boolean {
  if (!allowedOrigin) return false;
  try {
    const parsed = new URL(candidate);
    return parsed.origin === allowedOrigin && parsed.pathname.startsWith('/preview/');
  } catch {
    return false;
  }
}

/**
 * Preview frames may link between files covered by their capability, but may
 * never replace themselves with an external document. External services is a
 * resource/API permission, not a navigation or phishing escape hatch.
 */
export function isAllowedPreviewNavigation(
  candidate: string,
  allowedOrigin: string | null,
): boolean {
  return isPreviewDocumentUrl(candidate, allowedOrigin);
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === 'https:' || url.protocol === 'wss:') return '443';
  if (url.protocol === 'http:' || url.protocol === 'ws:') return '80';
  return '';
}

function isSameDaemonEndpoint(candidate: URL, allowedOrigin: URL): boolean {
  if (candidate.origin === allowedOrigin.origin) return true;
  const matchingSocketScheme =
    (allowedOrigin.protocol === 'https:' && candidate.protocol === 'wss:') ||
    (allowedOrigin.protocol === 'http:' && candidate.protocol === 'ws:');
  return (
    matchingSocketScheme &&
    candidate.hostname === allowedOrigin.hostname &&
    effectivePort(candidate) === effectivePort(allowedOrigin)
  );
}

/**
 * Identify outbound renderer traffic that must pass the live daemon policy.
 * Same-daemon HTTP(S)/WebSocket requests are product IPC, not external egress;
 * inert and non-network schemes are handled by their existing boundaries.
 */
export function isExternalRendererNetworkRequest(
  candidate: string,
  allowedOrigin: string | null,
): boolean {
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
    if (!allowedOrigin) return true;
    return !isSameDaemonEndpoint(parsed, new URL(allowedOrigin));
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth request policy for resources initiated by a preview frame.
 * CSP is the primary browser boundary; this Electron hook also cancels a
 * request before it can leave the process. Inert data/blob URLs never reach an
 * off-box host. File, custom, extension, and other schemes are always denied.
 */
export function isAllowedPreviewResourceRequest(
  candidate: string,
  allowedOrigin: string | null,
  allowExternalServices: boolean,
): boolean {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
    if (allowExternalServices) return true;
    if (!allowedOrigin) return false;
    return isSameDaemonEndpoint(parsed, new URL(allowedOrigin));
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

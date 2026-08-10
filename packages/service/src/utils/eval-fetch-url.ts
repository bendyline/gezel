const HERMETIC_EVAL_MARKER = 'GEZEL_EVAL_HERMETIC';
const FETCH_URL_ORIGINS = 'GEZEL_EVAL_FETCH_URL_ALLOWED_ORIGINS';

/**
 * Permit a URL to reach an eval-owned loopback fixture without weakening the
 * production SSRF boundary.
 *
 * The eval runner must opt in twice: set the hermetic marker and provide a
 * JSON array of exact HTTPS loopback origins. Values are intentionally not
 * patterns, and a malformed entry fails the entire allowlist closed.
 */
export function isAllowedHermeticEvalFetchUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[HERMETIC_EVAL_MARKER] !== '1') return false;

  const encodedOrigins = env[FETCH_URL_ORIGINS];
  if (!encodedOrigins) return false;

  let configured: unknown;
  try {
    configured = JSON.parse(encodedOrigins);
  } catch {
    return false;
  }
  if (!Array.isArray(configured) || configured.length === 0) return false;

  const origins: string[] = [];
  for (const value of configured) {
    if (typeof value !== 'string') return false;
    const origin = exactHttpsLoopbackOrigin(value);
    if (!origin || value !== origin) return false;
    origins.push(origin);
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }
  if (target.username || target.password) return false;
  const targetOrigin = exactHttpsLoopbackOrigin(target.origin);
  return targetOrigin !== null && origins.includes(targetOrigin);
}

function exactHttpsLoopbackOrigin(rawOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (host !== '127.0.0.1' && host !== '::1') return null;
  return url.origin;
}

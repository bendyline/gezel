/**
 * Network failures talking to a third-party site are an expected degraded
 * state, not a route exception. Left as a raw 502, `opaqueServerErrors`
 * redacts them to `internal_error` and logs each one as an unexpected daemon
 * fault, so a gezel reading the web cannot tell "that site is down" from "gezel
 * is broken" and the service log fills with ERROR lines for dead links. These
 * fixed codes survive the middleware; the detail goes to the log only.
 */
export const UPSTREAM_FETCH_ERROR_CODES = [
  'upstream_timeout',
  'upstream_unreachable',
  'upstream_tls_failed',
] as const;

export type UpstreamFetchErrorCode = (typeof UPSTREAM_FETCH_ERROR_CODES)[number];

export interface UpstreamFetchFailure {
  code: UpstreamFetchErrorCode;
  status: 502 | 504;
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NODATA',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

function isTlsCode(code: string): boolean {
  return (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.includes('CERT') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
  );
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 4) return;
    seen.add(value);
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === 'string') codes.push(record.code);
    visit(record.cause, depth + 1);
    // Happy-eyeballs connects fail with an AggregateError of per-address errors.
    if (Array.isArray(record.errors)) for (const inner of record.errors) visit(inner, depth + 1);
  };
  visit(err, 0);
  return codes;
}

/**
 * `timedOut` is the route's own deadline having fired; undici reports that
 * abort as whatever reason the controller carried, so the caller knows best.
 * Returns null for anything that is not recognisably the remote side's fault,
 * which the route must leave to the opaque-error path.
 */
export function classifyUpstreamFetchError(
  err: unknown,
  timedOut: boolean,
): UpstreamFetchFailure | null {
  if (timedOut) return { code: 'upstream_timeout', status: 504 };
  const codes = errorCodes(err);
  if (codes.some(isTlsCode)) return { code: 'upstream_tls_failed', status: 502 };
  if (codes.some((code) => TIMEOUT_CODES.has(code))) {
    return { code: 'upstream_timeout', status: 504 };
  }
  if (codes.some((code) => UNREACHABLE_CODES.has(code))) {
    return { code: 'upstream_unreachable', status: 502 };
  }
  // undici's own wrappers: a failed connect, or a body stream cut mid-read.
  if (
    err instanceof TypeError &&
    (err.message === 'fetch failed' || err.message === 'terminated')
  ) {
    return { code: 'upstream_unreachable', status: 502 };
  }
  return null;
}

export function isUpstreamFetchErrorCode(value: unknown): value is UpstreamFetchErrorCode {
  return (
    typeof value === 'string' && (UPSTREAM_FETCH_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const codes = errorCodes(err);
  return codes.length > 0 ? `${err.message} [${codes.join(', ')}]` : err.message;
}

import type { FailureKind, RunFailure } from './protocol.js';

/** A failure the runner can name, as opposed to a crash. */
export class RunnerError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface HttpFailure {
  status: number;
  retryAfterMs?: number;
  url: string;
}

/** `Retry-After` in ms: delta-seconds or an HTTP date. */
export function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : undefined;
}

export function kindForStatus(status: number): FailureKind {
  if (status === 429) return 'throttled';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not-found';
  if (status >= 500) return 'upstream';
  return 'input';
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Name what went wrong. Components wrap HTTP errors in their own messages
 * (an error hook), so the last failing response the guard saw is the better
 * witness than the thrown value.
 */
export function classify(err: unknown, lastHttpFailure: HttpFailure | undefined): RunFailure {
  if (err instanceof RunnerError) {
    return {
      kind: err.kind,
      message: err.message,
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    };
  }
  const e = err as {
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown };
    response?: { status?: unknown; headers?: Record<string, unknown> };
  } | null;
  const message = String(e?.message ?? err);
  // The sandbox's permission model refused something; say what, or the
  // message ("Access to this API has been restricted") explains nothing.
  const denied = err as { code?: unknown; permission?: unknown; resource?: unknown } | null;
  if (denied?.code === 'ERR_ACCESS_DENIED') {
    const what = [denied.permission, denied.resource]
      .filter((v) => typeof v === 'string')
      .join(' ');
    return { kind: 'component', message: what ? `${message} (${what})` : message };
  }
  const status = typeof e?.response?.status === 'number' ? e.response.status : undefined;
  if (status !== undefined) {
    const header = e?.response?.headers?.['retry-after'];
    const wait = retryAfterMs(header);
    return {
      kind: kindForStatus(status),
      message,
      status,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    };
  }
  if (lastHttpFailure) {
    return {
      kind: kindForStatus(lastHttpFailure.status),
      message,
      status: lastHttpFailure.status,
      ...(lastHttpFailure.retryAfterMs !== undefined
        ? { retryAfterMs: lastHttpFailure.retryAfterMs }
        : {}),
    };
  }
  const code = String(e?.code ?? e?.cause?.code ?? '');
  if (NETWORK_CODES.has(code)) return { kind: 'network', message };
  return { kind: 'component', message };
}

/** Every string a connection value carries that looks like a credential. */
export function secretsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 8) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) secretsOf(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A connection's key names the connection kind; it is not a secret.
      if (k === 'key' || k === 'configVarKey') continue;
      secretsOf(v, out);
    }
  }
  return out;
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[secret]');
  }
  return out;
}

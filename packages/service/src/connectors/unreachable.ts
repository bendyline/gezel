/**
 * A connection that could not reach its service is waiting, not broken: the
 * request never got an answer because there was no network (a plane, a
 * laptop out of range) or the host did not respond. It is shown as a calm
 * state ("Offline since 10:45"), retried soon, and cleared by the first pass
 * that gets through. An answer of any kind, even an error, is the service
 * speaking, and stays an error.
 *
 * Node's own message for all of these is "fetch failed"; the reason is in the
 * cause chain, which is where this reads it.
 */

import { HttpStatusError } from '@bendyline/gezel';
import { hasUsableNetwork } from '../system/network-presence.js';

export interface Unreachable {
  /** This computer has no usable network at all. */
  offline: boolean;
  /** The host that did not answer, when the error names it. */
  host?: string;
  /** The errno or undici code, or `FETCH_FAILED` when none was given. */
  code: string;
}

const CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

const REASONS: Record<string, string> = {
  ENOTFOUND: 'its address could not be looked up',
  EAI_AGAIN: 'its address could not be looked up',
  ENETUNREACH: 'there is no route to it',
  ENETDOWN: 'there is no route to it',
  EHOSTUNREACH: 'there is no route to it',
  EHOSTDOWN: 'there is no route to it',
  ECONNREFUSED: 'it refused the connection',
  ECONNRESET: 'the connection was cut off',
  ECONNABORTED: 'the connection was cut off',
  EPIPE: 'the connection was cut off',
  UND_ERR_SOCKET: 'the connection was cut off',
  UND_ERR_CLOSED: 'the connection was cut off',
  ETIMEDOUT: 'it did not answer in time',
  UND_ERR_CONNECT_TIMEOUT: 'it did not answer in time',
};

/** Each error in the chain: `cause` links and an AggregateError's members. */
function* chain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0 && seen.size < 16) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as Record<string, unknown>;
    yield e;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors);
  }
}

function hostOf(e: Record<string, unknown>): string | undefined {
  for (const key of ['hostname', 'host'] as const) {
    const v = e[key];
    if (typeof v === 'string' && /[a-z]/i.test(v)) return v;
  }
  // undici: "Connect Timeout Error (attempted address: oauth2.googleapis.com:443, …)"
  const message = typeof e.message === 'string' ? e.message : '';
  return /attempted address: ([a-z0-9.-]*[a-z][a-z0-9.-]*):\d+/i.exec(message)?.[1];
}

/**
 * Whether an error means the request never reached its service, and why.
 * Null for anything the service answered (an HTTP status), a cancel, or an
 * ordinary bug.
 */
export function unreachableFrom(
  err: unknown,
  hasNetwork: () => boolean = hasUsableNetwork,
): Unreachable | null {
  if (err instanceof HttpStatusError) return null;
  let code: string | undefined;
  let host: string | undefined;
  let fetchFailed = false;
  for (const e of chain(err)) {
    if (e.name === 'AbortError') return null;
    const c = typeof e.code === 'string' ? e.code : undefined;
    if (c && CODES.has(c)) code ??= c;
    host ??= hostOf(e);
    const message = typeof e.message === 'string' ? e.message : '';
    if (/^fetch failed$|getaddrinfo|socket hang up/i.test(message)) fetchFailed = true;
    if (!c) {
      const named = /\b(E[A-Z_]+|UND_ERR_[A-Z_]+)\b/.exec(message)?.[1];
      if (named && CODES.has(named)) code ??= named;
    }
  }
  if (!code && !fetchFailed) return null;
  return { offline: !hasNetwork(), code: code ?? 'FETCH_FAILED', ...(host ? { host } : {}) };
}

/**
 * Codes that mean no connection was ever made, so nothing was sent. A reset,
 * a broken pipe or a timeout can come after the request went out, and are
 * left out on purpose.
 */
const NEVER_CONNECTED = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  // nodemailer, before the message is handed over: the address lookup, the
  // connection, TLS, sign-in, or the server refusing the recipients.
  'EDNS',
  'ECONNECTION',
  'ETLS',
  'EAUTH',
  'EENVELOPE',
]);

/**
 * Whether an error proves a send never reached its service: no connection
 * was made, or the service answered with a refusal (an HTTP 4xx other than
 * 408). Anything else may have been delivered, and stays uncertain.
 */
export function sendNeverDelivered(err: unknown): boolean {
  for (const e of chain(err)) {
    if (e.name === 'AbortError') return false;
    const code = typeof e.code === 'string' ? e.code : undefined;
    if (code && NEVER_CONNECTED.has(code)) return true;
    const status = e.status ?? e.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
      return true;
    }
  }
  return false;
}

/** One plain sentence: what could not be reached, and why. */
export function describeUnreachable(u: Unreachable, service?: string): string {
  const what = u.host ?? service ?? 'the service';
  if (u.offline) return `Couldn't reach ${what}: this computer seems to be offline.`;
  const reason = REASONS[u.code] ?? 'the request could not be sent';
  return `Couldn't reach ${what}: ${reason}${u.code === 'FETCH_FAILED' ? '' : ` (${u.code})`}.`;
}

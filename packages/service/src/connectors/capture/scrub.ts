/**
 * Turn raw captured exchanges into a cassette safe to keep: the replay
 * exchanges a contract sidecar uses (`ConnectorTestExchange`), with what a
 * person wrote or owns replaced.
 *
 * Deny by default. Every string in a JSON response becomes a stable
 * pseudonym unless it is a date, a number, or a short lowercase code
 * (`confirmed`, `text/plain`): adapter logic branches on those, and they say
 * nothing about a person. The same original always gets the same pseudonym,
 * and a value a response handed out is replaced the same way in the URLs of
 * later requests, so a recorded pass still replays: a page token, an id, a
 * folder name line up. Text that is not JSON is replaced whole. Only an
 * allowlist of response headers is kept; request headers are dropped; a query
 * parameter named like a secret is always redacted.
 *
 * Fails closed: if a known secret, a bearer token, or any original string
 * that was pseudonymized is still in the result, it throws.
 */

import { createHash } from 'node:crypto';
import type { ConnectorTestExchange } from '@bendyline/gezel';
import type { RawExchange } from './capture-fetch.js';

export class CassetteLeakError extends Error {
  constructor(what: string) {
    super(`the scrubbed cassette still contains ${what}; nothing was kept`);
    this.name = 'CassetteLeakError';
  }
}

export interface ScrubOptions {
  /** Credential values the leak check looks for (tokens, keys, passwords). */
  secrets?: readonly string[];
}

const KEPT_HEADERS = new Set(['content-type', 'retry-after', 'link', 'etag', 'last-modified']);
const KEPT_HEADER_PREFIXES = ['x-ratelimit-', 'x-rate-limit-'];
const SECRET_PARAM =
  /^(?:access_token|refresh_token|id_token|token|key|api_key|apikey|code|client_secret|password|sig|signature|secret|auth)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_LIKE = /^-?\d+(?:\.\d+)?$/;
const CODE_LIKE = /^[a-z][a-z0-9_./+-]{0,23}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PATH_WORD = /^(?:[a-z][a-zA-Z0-9_.-]{0,40}|v\d+(?:\.\d+)?|\$[a-z]+)$/;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

/** A string adapter logic may branch on, and that says nothing about a person. */
function isSafeValue(value: string): boolean {
  return ISO_DATE.test(value) || NUMBER_LIKE.test(value) || CODE_LIKE.test(value) || value === '';
}

class Pseudonyms {
  readonly originals = new Map<string, string>();

  of(value: string): string {
    const known = this.originals.get(value);
    if (known) return known;
    const h = createHash('sha256').update(value).digest('hex').slice(0, 10);
    const pseudonym = EMAIL.test(value) ? `user-${h}@example.invalid` : `p-${h}`;
    this.originals.set(value, pseudonym);
    return pseudonym;
  }

  /** The pseudonym already given to `value`, if a response handed it out. */
  known(value: string): string | undefined {
    return this.originals.get(value);
  }
}

function scrubUrl(raw: string, names: Pseudonyms): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return names.of(raw);
  }
  url.username = '';
  url.password = '';
  const segments = url.pathname.split('/').map((segment) => {
    const decoded = safeDecode(segment);
    if (!decoded) return segment;
    const known = names.known(decoded);
    if (known) return encodeURIComponent(known);
    if (EMAIL.test(decoded)) return encodeURIComponent(names.of(decoded));
    if (PATH_WORD.test(decoded) || NUMBER_LIKE.test(decoded) || ISO_DATE.test(decoded)) {
      return segment;
    }
    return encodeURIComponent(names.of(decoded));
  });
  url.pathname = segments.join('/');
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (SECRET_PARAM.test(key)) params.append(key, 'REDACTED');
    else if (names.known(value)) params.append(key, names.known(value)!);
    else if (EMAIL.test(value)) params.append(key, names.of(value));
    else params.append(key, value);
  }
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function scrubJson(value: unknown, names: Pseudonyms): unknown {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return scrubUrl(value, names);
    return isSafeValue(value) ? value : names.of(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, names));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubJson(v, names)]),
    );
  }
  return value;
}

/** Name every replaceable string a response holds, before any URL is scrubbed. */
function register(value: unknown, names: Pseudonyms): void {
  if (typeof value === 'string') {
    if (!/^https?:\/\//i.test(value) && !isSafeValue(value)) names.of(value);
  } else if (Array.isArray(value)) {
    for (const v of value) register(v, names);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) register(v, names);
  }
}

function scrubHeaders(headers: Record<string, string>, names: Pseudonyms): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (!KEPT_HEADERS.has(k) && !KEPT_HEADER_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] =
      k === 'link'
        ? value.replace(/<([^>]+)>/g, (_, u: string) => `<${scrubUrl(u, names)}>`)
        : value;
  }
  return out;
}

/** Throws when anything the scrub was meant to remove is still present. */
export function assertNoLeak(
  serialized: string,
  checks: { secrets?: readonly string[]; originals?: Iterable<string> },
): void {
  for (const secret of checks.secrets ?? []) {
    if (secret.length >= 6 && serialized.includes(secret))
      throw new CassetteLeakError('a credential');
  }
  if (BEARER.test(serialized) || JWT.test(serialized))
    throw new CassetteLeakError('a bearer token');
  for (const original of checks.originals ?? []) {
    if (original.length >= 8 && serialized.includes(JSON.stringify(original).slice(1, -1))) {
      throw new CassetteLeakError('a value that should have been replaced');
    }
  }
}

export function scrubExchanges(
  raw: readonly RawExchange[],
  opts: ScrubOptions = {},
): ConnectorTestExchange[] {
  const names = new Pseudonyms();
  // First every response's strings, so a URL that carries one (a page token,
  // an id, a folder) is scrubbed the same way whichever came first.
  const parsed = raw.map((ex) => {
    if (ex.bodyText === undefined || ex.bodyText === '') return undefined;
    try {
      const json: unknown = JSON.parse(ex.bodyText);
      register(json, names);
      return { json };
    } catch {
      return { text: ex.bodyText };
    }
  });
  const out: ConnectorTestExchange[] = [];
  for (const [i, ex] of raw.entries()) {
    const url = scrubUrl(ex.url, names);
    const p = parsed[i];
    let body: unknown;
    if (p && 'json' in p) {
      body = scrubJson(p.json, names);
    } else if (p && 'text' in p) {
      body = `[text body of ${Buffer.byteLength(p.text)} bytes, not kept]`;
    } else if (ex.bodyOmitted) {
      body = `[${ex.bodyOmitted} body, not kept]`;
    }
    out.push({
      kind: 'http',
      request: { method: ex.method, url },
      response: {
        status: ex.status,
        headers: scrubHeaders(ex.headers, names),
        ...(body !== undefined ? { body } : {}),
      },
    });
  }
  // The originals that were replaced must not survive anywhere.
  const originals = [...names.originals.keys()].filter((o) => !isSafeValue(o));
  assertNoLeak(JSON.stringify(out), {
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    originals,
  });
  return out;
}

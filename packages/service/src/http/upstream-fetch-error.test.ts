import { describe, expect, it } from 'vitest';
import { classifyUpstreamFetchError } from './upstream-fetch-error.js';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('classifyUpstreamFetchError', () => {
  it('treats the route deadline as a timeout whatever the abort reason', () => {
    expect(classifyUpstreamFetchError(new Error('fetch_url timeout'), true)).toEqual({
      code: 'upstream_timeout',
      status: 504,
    });
  });

  it.each([
    ['ENOTFOUND', 'upstream_unreachable', 502],
    ['ECONNREFUSED', 'upstream_unreachable', 502],
    ['UND_ERR_SOCKET', 'upstream_unreachable', 502],
    ['UND_ERR_CONNECT_TIMEOUT', 'upstream_timeout', 504],
    ['CERT_HAS_EXPIRED', 'upstream_tls_failed', 502],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'upstream_tls_failed', 502],
  ])('classifies an undici failure caused by %s', (code, expected, status) => {
    const err = new TypeError('fetch failed', { cause: withCode('detail', code) });
    expect(classifyUpstreamFetchError(err, false)).toEqual({ code: expected, status });
  });

  it('reads per-address errors from a happy-eyeballs AggregateError', () => {
    const aggregate = new AggregateError([
      withCode('connect ECONNREFUSED ::1', 'ECONNREFUSED'),
      withCode('connect ECONNREFUSED 1.2.3.4', 'ECONNREFUSED'),
    ]);
    const err = new TypeError('fetch failed', { cause: aggregate });
    expect(classifyUpstreamFetchError(err, false)?.code).toBe('upstream_unreachable');
  });

  it('treats a body stream cut mid-read as unreachable', () => {
    expect(classifyUpstreamFetchError(new TypeError('terminated'), false)?.code).toBe(
      'upstream_unreachable',
    );
  });

  it('leaves anything else to the opaque-error path', () => {
    expect(classifyUpstreamFetchError(new Error('boom'), false)).toBeNull();
    expect(classifyUpstreamFetchError(new TypeError('x is not a function'), false)).toBeNull();
    expect(classifyUpstreamFetchError('string failure', false)).toBeNull();
  });
});

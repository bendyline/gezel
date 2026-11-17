import { HttpStatusError } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { describeUnreachable, unreachableFrom } from './unreachable.js';

/** What undici throws: a bare "fetch failed" with the reason in `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function errno(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

const online = () => true;
const offline = () => false;

describe('unreachableFrom', () => {
  it('reads the reason and the host from the cause chain', () => {
    const err = fetchFailed(
      errno('ENOTFOUND', 'getaddrinfo ENOTFOUND gmail.googleapis.com', {
        hostname: 'gmail.googleapis.com',
      }),
    );
    expect(unreachableFrom(err, online)).toEqual({
      offline: false,
      code: 'ENOTFOUND',
      host: 'gmail.googleapis.com',
    });
    expect(unreachableFrom(err, offline)?.offline).toBe(true);
  });

  it('looks inside an AggregateError and an undici connect timeout', () => {
    const refused = fetchFailed(
      new AggregateError([errno('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443')], ''),
    );
    expect(unreachableFrom(refused, online)).toEqual({ offline: false, code: 'ECONNREFUSED' });
    const timeout = fetchFailed(
      errno(
        'UND_ERR_CONNECT_TIMEOUT',
        'Connect Timeout Error (attempted address: graph.microsoft.com:443, timeout: 10000ms)',
      ),
    );
    expect(unreachableFrom(timeout, online)).toMatchObject({
      code: 'UND_ERR_CONNECT_TIMEOUT',
      host: 'graph.microsoft.com',
    });
  });

  it('still recognizes a bare "fetch failed" and an IMAP error that only names its code', () => {
    expect(unreachableFrom(new TypeError('fetch failed'), offline)).toEqual({
      offline: true,
      code: 'FETCH_FAILED',
    });
    expect(unreachableFrom(new Error('getaddrinfo ENOTFOUND imap.example.test'), online)).toEqual({
      offline: false,
      code: 'ENOTFOUND',
    });
  });

  it('is null when the service answered, the request was cancelled, or it is a bug', () => {
    expect(unreachableFrom(new HttpStatusError(503, 'unavailable'), offline)).toBeNull();
    expect(
      unreachableFrom(Object.assign(new Error('aborted'), { name: 'AbortError' }), offline),
    ).toBeNull();
    expect(unreachableFrom(new Error('Cannot read properties of undefined'), offline)).toBeNull();
    expect(
      unreachableFrom(new Error('The sign-in was revoked. Re-link the account.'), offline),
    ).toBeNull();
  });
});

describe('describeUnreachable', () => {
  it('says offline plainly, and otherwise why the host did not answer', () => {
    expect(
      describeUnreachable({ offline: true, code: 'ENOTFOUND', host: 'gmail.googleapis.com' }),
    ).toBe("Couldn't reach gmail.googleapis.com: this computer seems to be offline.");
    expect(describeUnreachable({ offline: false, code: 'ECONNREFUSED' }, 'Fastmail')).toBe(
      "Couldn't reach Fastmail: it refused the connection (ECONNREFUSED).",
    );
    expect(describeUnreachable({ offline: false, code: 'FETCH_FAILED' })).toBe(
      "Couldn't reach the service: the request could not be sent.",
    );
  });
});

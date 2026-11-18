import { describe, expect, it } from 'vitest';
import { RunnerError, classify, kindForStatus, retryAfterMs, scrub, secretsOf } from './failure.js';

describe('retryAfterMs', () => {
  it('reads delta-seconds and HTTP dates, and nothing else', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(retryAfterMs('7', now)).toBe(7000);
    expect(retryAfterMs('0.5', now)).toBe(500);
    expect(retryAfterMs('Tue, 17 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Tue, 17 Nov 2026 11:59:00 GMT', now)).toBeUndefined();
    expect(retryAfterMs('-3', now)).toBeUndefined();
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs('  ', now)).toBeUndefined();
    expect(retryAfterMs(7, now)).toBeUndefined();
  });
});

describe('kindForStatus', () => {
  it.each([
    [429, 'throttled'],
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [410, 'not-found'],
    [500, 'upstream'],
    [503, 'upstream'],
    [400, 'input'],
    [422, 'input'],
  ])('%i is %s', (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });
});

describe('classify', () => {
  it('keeps what a RunnerError already named', () => {
    expect(classify(new RunnerError('origin', 'not declared'), undefined)).toEqual({
      kind: 'origin',
      message: 'not declared',
    });
    expect(classify(new RunnerError('throttled', 'wait', 429, 5000), undefined)).toEqual({
      kind: 'throttled',
      message: 'wait',
      status: 429,
      retryAfterMs: 5000,
    });
  });

  it('says what the permission model refused', () => {
    const denied = Object.assign(new Error('Access to this API has been restricted'), {
      code: 'ERR_ACCESS_DENIED',
      permission: 'FileSystemRead',
      resource: '/etc/passwd',
    });
    expect(classify(denied, undefined)).toEqual({
      kind: 'component',
      message: 'Access to this API has been restricted (FileSystemRead /etc/passwd)',
    });
    const bare = Object.assign(new Error('restricted'), { code: 'ERR_ACCESS_DENIED' });
    expect(classify(bare, undefined)).toEqual({ kind: 'component', message: 'restricted' });
  });

  it('names an HTTP error by its status and carries the wait', () => {
    const err = Object.assign(new Error('Request failed with status code 429'), {
      response: { status: 429, headers: { 'retry-after': '3' } },
    });
    expect(classify(err, undefined)).toEqual({
      kind: 'throttled',
      message: 'Request failed with status code 429',
      status: 429,
      retryAfterMs: 3000,
    });
    const noWait = Object.assign(new Error('gone'), { response: { status: 404 } });
    expect(classify(noWait, undefined)).toEqual({
      kind: 'not-found',
      message: 'gone',
      status: 404,
    });
  });

  it('falls back to the last failing response when a component rewrote the error', () => {
    expect(
      classify(new Error('Airtable said no'), { status: 401, url: 'https://x.test/a' }),
    ).toEqual({ kind: 'auth', message: 'Airtable said no', status: 401 });
    expect(
      classify(new Error('busy'), { status: 429, url: 'https://x.test/a', retryAfterMs: 9000 }),
    ).toEqual({ kind: 'throttled', message: 'busy', status: 429, retryAfterMs: 9000 });
  });

  it('names network failures by their code, on the error or its cause', () => {
    const direct = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    expect(classify(direct, undefined)).toEqual({ kind: 'network', message: 'connect refused' });
    const wrapped = Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    expect(classify(wrapped, undefined)).toEqual({ kind: 'network', message: 'fetch failed' });
  });

  it('calls anything else a component failure, whatever was thrown', () => {
    expect(classify(new Error('boom'), undefined)).toEqual({ kind: 'component', message: 'boom' });
    expect(classify('a string', undefined)).toEqual({ kind: 'component', message: 'a string' });
    expect(classify(null, undefined)).toEqual({ kind: 'component', message: 'null' });
  });
});

describe('secretsOf and scrub', () => {
  it('collects credential-length strings, skipping the connection kind', () => {
    const value = {
      key: 'apiKey-connection-kind',
      configVarKey: 'connection-config-var',
      fields: { apiKey: 'sk-1234567890', short: 'abc', nested: ['token-abcdefgh', 42] },
    };
    expect(secretsOf(value)).toEqual(['sk-1234567890', 'token-abcdefgh']);
    expect(secretsOf(undefined)).toEqual([]);
  });

  it('replaces every occurrence of every secret', () => {
    expect(
      scrub('a sk-1234567890 b sk-1234567890 c token-abcdefgh', [
        'sk-1234567890',
        'token-abcdefgh',
        '',
      ]),
    ).toBe('a [secret] b [secret] c [secret]');
    expect(scrub('nothing here', ['sk-1234567890'])).toBe('nothing here');
  });
});

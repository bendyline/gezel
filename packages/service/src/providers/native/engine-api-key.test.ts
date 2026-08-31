import { afterEach, describe, expect, it } from 'vitest';
import { engineApiKey, resetEngineApiKeyForTests, withEngineApiKey } from './engine-api-key.js';

afterEach(() => resetEngineApiKeyForTests());

describe('engineApiKey', () => {
  it('is stable within a process and unguessable', () => {
    const a = engineApiKey();
    expect(engineApiKey()).toBe(a);
    // 32 random bytes, hex-encoded.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a different token per process', () => {
    const a = engineApiKey();
    resetEngineApiKeyForTests();
    expect(engineApiKey()).not.toBe(a);
  });
});

describe('withEngineApiKey', () => {
  it('adds the bearer token to every request', async () => {
    let seen: Headers | undefined;
    const wrapped = withEngineApiKey(
      (async (_u: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers ?? {});
        return new Response('{}');
      }) as unknown as typeof fetch,
      'tok',
    );

    await wrapped('http://127.0.0.1:1/v1/models');
    expect(seen?.get('authorization')).toBe('Bearer tok');
  });

  it('preserves the caller’s other headers', async () => {
    let seen: Headers | undefined;
    const wrapped = withEngineApiKey(
      (async (_u: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers ?? {});
        return new Response('{}');
      }) as unknown as typeof fetch,
      'tok',
    );

    await wrapped('http://127.0.0.1:1/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(seen?.get('content-type')).toBe('application/json');
    expect(seen?.get('authorization')).toBe('Bearer tok');
  });

  it('does not clobber an Authorization the caller already set', async () => {
    let seen: Headers | undefined;
    const wrapped = withEngineApiKey(
      (async (_u: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers ?? {});
        return new Response('{}');
      }) as unknown as typeof fetch,
      'tok',
    );

    await wrapped('http://127.0.0.1:1/v1/models', {
      headers: { Authorization: 'Bearer caller-owns-this' },
    });
    expect(seen?.get('authorization')).toBe('Bearer caller-owns-this');
  });

  it('passes the request body and method through untouched', async () => {
    let method: string | undefined;
    let body: unknown;
    const wrapped = withEngineApiKey(
      (async (_u: unknown, init?: RequestInit) => {
        method = init?.method;
        body = init?.body;
        return new Response('{}');
      }) as unknown as typeof fetch,
      'tok',
    );

    await wrapped('http://127.0.0.1:1/v1/chat/completions', {
      method: 'POST',
      body: '{"stream":true}',
    });
    expect(method).toBe('POST');
    expect(body).toBe('{"stream":true}');
  });
});

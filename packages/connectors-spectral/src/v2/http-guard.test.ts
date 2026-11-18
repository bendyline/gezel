import http, { type Server, createServer } from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerError } from './failure.js';
import { installHttpGuard } from './http-guard.js';
import type { RecordedExchange } from './protocol.js';

/**
 * The guard patches process-wide HTTP (the SDK's axios default adapter,
 * `node:http(s)` and `fetch`), as it must in the runner's one-job process.
 * Each test here restores what it patched so the next starts clean.
 */

type AxiosInstance = {
  defaults: { adapter: unknown };
  get(url: string, config?: Record<string, unknown>): Promise<{ status: number; data: unknown }>;
  getAdapter(adapter: unknown): (config: Record<string, unknown>) => Promise<unknown>;
  getUri(config: Record<string, unknown>): string;
  AxiosError: new (
    message: string,
    code: string,
    config: unknown,
    request: unknown,
    response: unknown,
  ) => Error;
  AxiosHeaders: new (headers?: Record<string, string>) => unknown;
};

const sdkRequire = createRequire(require.resolve('@prismatic-io/spectral'));
const axios = sdkRequire('axios') as AxiosInstance;

type Patchable = Record<'request' | 'get', unknown>;
const httpMod = http as unknown as Patchable;
const httpsMod = https as unknown as Patchable;
let saved: {
  http: [unknown, unknown];
  https: [unknown, unknown];
  fetch: typeof fetch;
  adapter: unknown;
};

beforeEach(() => {
  saved = {
    http: [httpMod.request, httpMod.get],
    https: [httpsMod.request, httpsMod.get],
    fetch: globalThis.fetch,
    adapter: axios.defaults.adapter,
  };
});

afterEach(() => {
  [httpMod.request, httpMod.get] = saved.http;
  [httpsMod.request, httpsMod.get] = saved.https;
  globalThis.fetch = saved.fetch;
  axios.defaults.adapter = saved.adapter;
});

let server: Server;
let base: string;
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(String(req.url));
    if (req.url === '/slow-down') {
      res.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (req.url === '/hop') {
      res.writeHead(302, { location: '/ok' }).end();
      return;
    }
    if (req.url === '/away') {
      res.writeHead(302, { location: 'https://elsewhere.example/' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  hits = [];
});

const runnerError = (kind: string) =>
  expect.objectContaining({ name: 'RunnerError', kind }) as unknown as RunnerError;

describe('the HTTP guard', () => {
  it('lets the SDK reach a declared origin and refuses any other before a request', async () => {
    installHttpGuard({ axios, origins: [base] });
    const ok = await axios.get(`${base}/ok`);
    expect(ok.data).toEqual({ ok: true });
    await expect(axios.get('https://api.example.com/x')).rejects.toEqual(runnerError('origin'));
    expect(hits).toEqual(['/ok']);
  });

  it('remembers the last failing response and the wait it asked for', async () => {
    const guard = installHttpGuard({ axios, origins: [base] });
    expect(guard.lastFailure).toBeUndefined();
    await expect(axios.get(`${base}/slow-down`)).rejects.toThrow(/429/);
    expect(guard.lastFailure).toEqual({
      status: 429,
      retryAfterMs: 7000,
      url: `${base}/slow-down`,
    });
  });

  it('checks node:http and node:https directly, by URL or by options', () => {
    installHttpGuard({ axios, origins: ['*.example.com'] });
    const get = httpsMod.get as (...args: unknown[]) => unknown;
    const request = httpMod.request as (...args: unknown[]) => unknown;
    expect(() => get('https://example.com/')).toThrow(runnerError('origin'));
    expect(() => get(new URL('https://evil.test/'))).toThrow(runnerError('origin'));
    // The wildcard is for https only.
    expect(() => request({ hostname: 'api.example.com', path: '/x' })).toThrow(
      runnerError('origin'),
    );
    expect(() => request({ host: 'other.test', port: 8080 })).toThrow(/http:\/\/other\.test:8080/);
    expect(() => request()).toThrow(/no address/);
  });

  it('follows fetch redirects by hand and checks every hop', async () => {
    installHttpGuard({ axios, origins: [base] });
    const followed = await fetch(`${base}/hop`);
    expect(await followed.json()).toEqual({ ok: true });
    expect(hits).toEqual(['/hop', '/ok']);

    const manual = await fetch(`${base}/hop`, { redirect: 'manual' });
    expect(manual.status).toBe(302);

    await expect(fetch(`${base}/away`)).rejects.toEqual(runnerError('origin'));
    await expect(fetch(new Request('https://api.example.com/'))).rejects.toEqual(
      runnerError('origin'),
    );
  });

  it('remembers a failing fetch response', async () => {
    const guard = installHttpGuard({ axios, origins: [base] });
    const res = await fetch(`${base}/slow-down`);
    expect(res.status).toBe(429);
    expect(guard.lastFailure).toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  describe('in replay mode', () => {
    const replay: RecordedExchange[] = [
      {
        request: { method: 'GET', url: 'https://api.example.com/items?b=2&a=1' },
        response: { status: 200, body: { items: [1] } },
      },
      {
        request: { url: 'https://api.example.com/missing' },
        response: { status: 404, headers: { 'x-why': 'gone' }, body: 'not here' },
      },
      {
        request: { method: 'POST', url: 'https://api.example.com/fetched' },
        response: { status: 429, headers: { 'retry-after': '2' } },
      },
      {
        request: { url: 'https://api.example.com/never' },
        response: {},
      },
    ];

    it('answers from recordings in any query order and opens no socket', async () => {
      const guard = installHttpGuard({ axios, origins: [], replay });
      const ok = await axios.get('https://api.example.com/items', { params: { a: 1, b: 2 } });
      expect(ok).toMatchObject({ status: 200, data: { items: [1] } });

      const missing = axios.get('https://api.example.com/missing');
      await expect(missing).rejects.toMatchObject({ response: { status: 404 } });
      expect(guard.lastFailure).toMatchObject({ status: 404 });

      const fetched = await fetch('https://api.example.com/fetched', { method: 'POST' });
      expect(fetched.status).toBe(429);
      expect(guard.lastFailure).toMatchObject({ status: 429, retryAfterMs: 2000 });

      expect(guard.usedRecordings()).toEqual([0, 1, 2]);
      expect(guard.unusedRecordings()).toBe(1);
      expect(hits).toEqual([]);
    });

    it('fails a request with no recording, or one used already, as a replay miss', async () => {
      installHttpGuard({ axios, origins: [], replay });
      await expect(axios.get('https://api.example.com/other')).rejects.toEqual(
        runnerError('replay-miss'),
      );
      await fetch('https://api.example.com/fetched', { method: 'POST' });
      await expect(fetch('https://api.example.com/fetched', { method: 'POST' })).rejects.toEqual(
        runnerError('replay-miss'),
      );
      const get = httpMod.get as (...args: unknown[]) => unknown;
      expect(() => get(`${base}/ok`)).toThrow(runnerError('replay-miss'));
    });

    it('accepts a status the caller declares valid', async () => {
      installHttpGuard({ axios, origins: [], replay });
      const res = await axios.get('https://api.example.com/missing', {
        validateStatus: () => true,
      });
      expect(res).toMatchObject({ status: 404, data: 'not here' });
      const empty = await axios.get('https://api.example.com/never');
      expect(empty).toMatchObject({ status: 200, data: '' });
    });
  });
});

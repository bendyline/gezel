import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../../service.js';
import { assertPublicUrl } from '../../utils/ssrf.js';

vi.mock('../../utils/ssrf.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/ssrf.js')>();
  return {
    ...actual,
    // DNS is deliberately outside this route test. The production SSRF
    // implementation has its own coverage; here we verify that every URL the
    // route is about to fetch (including redirects) is passed through it.
    assertPublicUrl: vi.fn(async () => undefined),
  };
});

/**
 * Positive, route-level coverage for the curl-equivalent `fetch_url` tool.
 * The request enters through the real authenticated HTTPS service route, while
 * only the outbound transport and DNS/SSRF lookup are replaced with hermetic
 * test doubles. No production-only bypass or loopback exception is involved.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;
let outboundFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-fetch-url-route-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  svc = await startService({ home });
  await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  // Capture the real service transport before each test replaces global fetch.
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

beforeEach(() => {
  outboundFetch = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', outboundFetch);
  vi.mocked(assertPublicUrl).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(async () => {
  if (svc) await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

async function fetchUrl(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/fetch-url`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('fetch_url route', () => {
  it('returns a successful text GET response', async () => {
    outboundFetch.mockResolvedValueOnce(
      new Response('fixture response', {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-fixture': 'get',
        },
      }),
    );

    const res = await fetchUrl({ url: 'https://fixture.example/articles/42' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-fixture': 'get',
      },
      truncated: false,
      mimeType: 'text/plain; charset=utf-8',
      body: 'fixture response',
    });
    expect(assertPublicUrl).toHaveBeenCalledWith('https://fixture.example/articles/42');
    expect(outboundFetch).toHaveBeenCalledWith(
      'https://fixture.example/articles/42',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('forwards a POST method, headers, and body', async () => {
    outboundFetch.mockResolvedValueOnce(
      new Response('{"accepted":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await fetchUrl({
      url: 'https://fixture.example/events',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-123',
      },
      body: '{"kind":"browser-check"}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
      body: '{"accepted":true}',
      truncated: false,
    });
    expect(outboundFetch).toHaveBeenCalledWith(
      'https://fixture.example/events',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-123',
        },
        body: '{"kind":"browser-check"}',
        redirect: 'manual',
      }),
    );
  });

  it('revalidates and follows a relative redirect hop', async () => {
    outboundFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          statusText: 'Found',
          headers: { location: '/downloads/final' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('redirected', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/plain' },
        }),
      );

    const res = await fetchUrl({ url: 'https://fixture.example/downloads/start' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 200, body: 'redirected' });
    expect(assertPublicUrl).toHaveBeenNthCalledWith(1, 'https://fixture.example/downloads/start');
    expect(assertPublicUrl).toHaveBeenNthCalledWith(2, 'https://fixture.example/downloads/final');
    expect(outboundFetch).toHaveBeenCalledTimes(2);
  });

  it('returns binary payloads as base64', async () => {
    const bytes = Uint8Array.from([0, 255, 16, 128, 42]);
    outboundFetch.mockResolvedValueOnce(
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );

    const res = await fetchUrl({ url: 'https://fixture.example/blob.bin' });
    expect(await res.json()).toMatchObject({
      status: 200,
      mimeType: 'application/octet-stream',
      bodyBase64: Buffer.from(bytes).toString('base64'),
      truncated: false,
    });
  });

  it('truncates the body at maxBytes', async () => {
    outboundFetch.mockResolvedValueOnce(
      new Response('abcdefghij', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const res = await fetchUrl({
      url: 'https://fixture.example/large.txt',
      maxBytes: 4,
    });
    expect(await res.json()).toMatchObject({
      status: 200,
      body: 'abcd',
      truncated: true,
    });
  });
});

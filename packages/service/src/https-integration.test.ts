/**
 * Smoke test for the HTTPS+HTTP/2 transport. Boots the daemon (HTTPS
 * is the default), hits `/api/health` over a trusting fetch built
 * from the in-memory cert, and asserts the request succeeded. The
 * key thing this catches is the "did the secure server actually
 * negotiate" path — if Hono / @hono/node-server / our serve-options
 * shape ever changes incompatibly, this fails fast. Also asserts the
 * cert pin (rejects untrusted callers) and the fingerprint shape the
 * Electron renderer relies on.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { connect as connectHttp2 } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from './service.js';

let svc: RunningService;
let baseUrl: string;
let trustingFetch: typeof fetch;

async function requestHttp2Status(authority: string, path = '/'): Promise<number> {
  if (!svc.cert) throw new Error('expected cert to be present in HTTPS mode');
  const client = connectHttp2(baseUrl, { ca: svc.cert.certPem });
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = client.request({
        ':authority': authority,
        ':method': 'GET',
        ':path': path,
      });
      request.once('error', reject);
      request.once('response', (headers) => {
        const status = headers[':status'];
        request.resume();
        request.once('end', () => resolve(Number(status)));
      });
      request.end();
    });
  } finally {
    client.close();
  }
}

// Match the 30s hook timeout that other startService-driven integration
// tests use — the 10s default is unreliable under concurrent test-runner
// load (cert gen + secret store init + MCP setup all racing across
// parallel files).
beforeAll(async () => {
  // HTTPS is the default transport — clearing the operator escape
  // hatch is enough to guarantee the secure path is exercised here.
  delete process.env.GEZEL_INSECURE_TRANSPORT;
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'lv-https-'));
  svc = await startService({ home });
  baseUrl = `https://127.0.0.1:${svc.port}`;
  if (!svc.cert) throw new Error('expected cert to be present in HTTPS mode');
  trustingFetch = createTrustingFetch({ cert: svc.cert.certPem });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  // Background sweeps (memory health, bootstrap) can finish writing
  // after `stop()` returns; the rm races them and trips ENOTEMPTY.
  // Best-effort cleanup is fine for a tmpdir — the OS reaps it later.
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

describe('https transport', () => {
  it('serves /api/health over HTTPS', async () => {
    const res = await trustingFetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it('rejects connections that do not trust our cert', async () => {
    // Stock fetch (no custom dispatcher) doesn't trust the self-signed
    // cert — confirms the trust path is actually validating, not just
    // disabled. Node throws a fetch failure with a TLS-flavored cause.
    await expect(fetch(`${baseUrl}/api/health`)).rejects.toThrow();
  });

  it('exposes a fingerprint matching the cert', async () => {
    expect(svc.cert?.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.cert?.fingerprintBase64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('enforces the DNS-rebinding authority guard over HTTP/2', async () => {
    expect(await requestHttp2Status(`127.0.0.1:${svc.port}`)).toBe(200);
    expect(await requestHttp2Status('attacker.example')).toBe(403);
  });
});

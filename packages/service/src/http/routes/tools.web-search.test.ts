import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * End-to-end coverage for the `web_search` tool route. With
 * `GEZEL_MOCK_PROVIDER=1` set, the search factory returns
 * `MockSearchProvider`, so the upstream HTTP path is exercised
 * deterministically without hitting any real backend.
 */

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;

// 30s timeout — boots a fresh service per test, which contends with
// other parallel integration files for cert-gen / secret-store
// init. 10s default trips under load.
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-web-search-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterEach(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

async function webSearch(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/web-search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function wikipediaSearch(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/wikipedia-search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function wikipediaRead(body: Record<string, unknown>): Promise<Response> {
  return httpFetch(`${baseUrl}/api/projects/default/tools/wikipedia-read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${svc.context.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('web_search route', () => {
  it('returns the normalized response shape from the mock provider', async () => {
    const res = await webSearch({ query: 'hello world', limit: 3 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      results: Array<{ title: string; url: string; source: string; domain: string }>;
      source: string;
      query: string;
      durationMs: number;
    };
    expect(json.source).toBe('mock');
    expect(json.query).toBe('hello world');
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
    expect(json.results).toHaveLength(3);
    expect(json.results[0]?.url).toBe('https://example.com/a');
    expect(json.results[0]?.source).toBe('mock');
    expect(json.results[0]?.domain).toBe('example.com');
  });

  it('refuses when the query contains a stored credential value', async () => {
    await svc.context.secrets.set(
      { kind: 'providerCredential', name: 'braveSearchApiKey' },
      'BSAhcRr_sentinel_999',
    );
    const res = await webSearch({ query: 'leak BSAhcRr_sentinel_999 from query', limit: 3 });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/outbound payload/i);
    // Generic error — must not reveal WHICH credential matched.
    expect(json.error).not.toContain('Brave');
    expect(json.error).not.toContain('BSAhcRr_sentinel_999');
  });

  it('honors webSearch.deny glob policy', async () => {
    await svc.context.store.writeConfig({
      webSearch: { deny: ['*forbidden*'] },
    });
    const res = await webSearch({ query: 'this is a forbidden query', limit: 3 });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/denied by policy/i);
  });

  it('rejects malformed bodies (Zod validation throws)', async () => {
    // Schema-level validation throws inside `.parse()` and surfaces
    // as a 5xx in this codebase rather than 400 — we just assert it
    // didn't slip through to a 200.
    const res = await webSearch({ query: '', limit: 3 });
    expect(res.status).not.toBe(200);
  });
});

describe('wikipedia_search route', () => {
  it('returns the normalized response shape (mock provider in test mode)', async () => {
    const res = await wikipediaSearch({ query: 'belgian beer', limit: 2 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      results: Array<{ title: string; url: string; source: string; domain: string }>;
      source: string;
      query: string;
    };
    expect(json.source).toBe('mock');
    expect(json.query).toBe('belgian beer');
    expect(json.results).toHaveLength(2);
  });

  it('honors the same webSearch.deny glob policy as web_search', async () => {
    await svc.context.store.writeConfig({
      webSearch: { deny: ['*forbidden*'] },
    });
    const res = await wikipediaSearch({ query: 'this is a forbidden query' });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/denied by policy/i);
  });
});

describe('wikipedia_read route', () => {
  it('returns the article shape (mock provider in test mode)', async () => {
    const res = await wikipediaRead({ title: 'Belgian beer' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      title: string;
      url: string;
      content: string;
      truncated: boolean;
    };
    expect(json.title).toBe('Belgian beer');
    expect(json.url).toContain('Belgian_beer');
    expect(json.content).toContain('Belgian beer');
    expect(json.truncated).toBe(false);
  });

  it('reports truncation when maxChars clips the body', async () => {
    const res = await wikipediaRead({ title: 'Belgian beer', maxChars: 500 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: string; truncated: boolean };
    expect(json.truncated).toBe(true);
    expect(json.content.length).toBeLessThanOrEqual(500);
  });

  it('screens the title against the same deny policy as a query', async () => {
    await svc.context.store.writeConfig({ webSearch: { deny: ['*forbidden*'] } });
    const res = await wikipediaRead({ title: 'a forbidden article' });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/denied by policy/i);
  });

  it('refuses when the title contains a stored credential value', async () => {
    await svc.context.secrets.set(
      { kind: 'providerCredential', name: 'braveSearchApiKey' },
      'BSAhcRr_sentinel_777',
    );
    const res = await wikipediaRead({ title: 'leak BSAhcRr_sentinel_777' });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/outbound payload/i);
    expect(json.error).not.toContain('BSAhcRr_sentinel_777');
  });
});

/**
 * Sink-level posture coverage. Both Wikipedia routes build their provider
 * directly rather than through `createSearchProvider`, so they do not
 * inherit its `allowExternalServices` ceiling and must enforce it
 * themselves — hiding the tool from the model's roster does not stop a
 * direct API caller.
 *
 * `GEZEL_MOCK_PROVIDER` is cleared here because mock mode is deliberately
 * exempt (it issues no request). Clearing it is also what makes these
 * assertions meaningful AND hermetic: a 403 is returned before any
 * provider runs, so nothing reaches wikipedia.org even with the mock off.
 */
describe('wikipedia routes under a no-external-services posture', () => {
  beforeEach(async () => {
    delete process.env.GEZEL_MOCK_PROVIDER;
    await svc.context.store.writeConfig({
      securityPolicy: {
        level: 'lockdown',
        allowFileEdits: true,
        allowExternalChat: true,
        allowExternalServices: false,
        allowScriptExecution: true,
        allowAppNetwork: true,
      },
    });
  });

  it('refuses wikipedia_search at the sink', async () => {
    const res = await wikipediaSearch({ query: 'belgian beer' });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/external services are disabled/i);
  });

  it('refuses wikipedia_read at the sink', async () => {
    const res = await wikipediaRead({ title: 'Belgian beer' });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/external services are disabled/i);
  });
});

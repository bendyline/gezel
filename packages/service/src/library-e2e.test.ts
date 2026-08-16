import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from './service.js';

/**
 * The shared library end-to-end, through the real daemon: a document filed by
 * a person is findable by its content, and a file dropped into the folder from
 * outside the app (a sync client landing another device's edit) is picked up
 * too. Exercises the whole chain — ensure → project index → documents facade.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let httpFetch: typeof fetch;
let home: string;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-library-e2e-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

function auth(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: { ...auth(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

type SearchBody = {
  results: Array<{ path: string; snippet: string; score?: number }>;
  engine: string;
};

/** The index runs on a background tick, so give it a bounded window. */
async function searchUntil(q: string, want: string): Promise<SearchBody> {
  const deadline = Date.now() + 30_000;
  let last: SearchBody = { results: [], engine: 'unavailable' };
  while (Date.now() < deadline) {
    const res = await api('GET', `/api/documents/search?q=${encodeURIComponent(q)}`);
    last = (await res.json()) as SearchBody;
    if (last.results.some((r) => r.path === want)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

describe('shared document library, end to end', () => {
  it('finds a document by its content, not just its name', async () => {
    await api('PUT', '/api/documents/write', {
      path: 'policies/refunds.md',
      content: '# Refunds\n\nOrders are refunded within thirty days, no questions asked.',
    });

    const found = await searchUntil('refunded', 'policies/refunds.md');
    if (found.engine === 'unavailable') return; // sqlite/FTS unavailable here
    expect(found.results.map((r) => r.path)).toContain('policies/refunds.md');
  }, 60_000);

  it('picks up a file dropped into the folder from outside the app', async () => {
    // The watcher attaches on a startup-delayed reconcile, so wait for it
    // rather than racing it — a file written before any watcher exists is
    // the poll's job, on a cadence no test should sit through.
    await new Promise((r) => setTimeout(r, 8_000));

    // What a cloud-sync client does when another device adds a document:
    // it writes the file directly, with no API call to tell us.
    await writeFile(
      join(home, 'documents', 'handbook.md'),
      '# Handbook\n\nThe ooievaar convention governs naming.',
      'utf8',
    );

    const found = await searchUntil('ooievaar', 'handbook.md');
    if (found.engine === 'unavailable') return;
    expect(found.results.map((r) => r.path)).toContain('handbook.md');
  }, 60_000);
});

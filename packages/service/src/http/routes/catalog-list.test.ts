import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogItemSummary } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-catalog-list-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function list(path: string, headers: Record<string, string> = {}) {
  const res = await httpFetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  expect(res.status).toBe(200);
  return { res, items: ((await res.json()) as { items: CatalogItemSummary[] }).items };
}

describe('GET /api/catalog/:kind filters', () => {
  it('leaves out community entries with community=0', async () => {
    const all = await list('/api/catalog/toolset');
    const reviewed = await list('/api/catalog/toolset?community=0');
    expect(reviewed.items.length).toBeGreaterThan(0);
    expect(reviewed.items.some((item) => item.sourceId === 'community')).toBe(false);
    expect(reviewed.items.length).toBe(
      all.items.filter((item) => item.sourceId !== 'community').length,
    );
  });

  it('returns only the named items with ids', async () => {
    const { items } = await list('/api/catalog/toolset?ids=github,not-a-toolset');
    expect(items.map((item) => item.manifest.id)).toEqual(['github']);
  });

  it('compresses the list for a client that accepts gzip', async () => {
    const { res, items } = await list('/api/catalog/toolset?community=0', {
      'Accept-Encoding': 'gzip',
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(items.length).toBeGreaterThan(0);
  });
});

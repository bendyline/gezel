import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let client: GezelClient;
let home: string;
let rawFetch: (path: string, headers: Record<string, string>) => Promise<Response>;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-craftbook-offer-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({
    baseUrl: `${scheme}://127.0.0.1:${svc.port}`,
    token: svc.context.token,
    fetch: httpFetch,
  });
  rawFetch = (path, headers) =>
    httpFetch(`${scheme}://127.0.0.1:${svc.port}${path}`, {
      headers: { Authorization: `Bearer ${svc.context.token}`, ...headers },
    });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('a typed project’s craftbook offer', () => {
  it("suggests the type's installed books under the type's name", async () => {
    const { project, applied } = await client.createTypedProject({
      name: 'Training',
      projectType: { typeId: 'fitness-coach' },
    });
    expect(applied.craftbooksInstalled).toContain('training-recap');
    const offer = await client.listProjectCraftbooks(project.id);
    expect(offer.suggestedIds).toContain('training-recap');
    expect(offer.projectType).toEqual({ id: 'fitness-coach', label: 'Fitness Coach' });
  }, 30_000);
});

describe('the craftbook offer on the wire', () => {
  it('is compressed for a client that accepts gzip, and reads the same', async () => {
    const res = await rawFetch('/api/projects/default/craftbooks', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe((await client.listProjectCraftbooks('default')).items.length);
  }, 30_000);
});

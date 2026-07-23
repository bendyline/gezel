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

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-delete-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('DELETE /api/gezels/:id', () => {
  it('permanently deletes a gezel and removes it from the listing', async () => {
    const created = await client.createGezel({ name: 'Doomed Gezel' });
    const result = await client.deleteGezel(created.id);
    expect(result).toEqual({ ok: true, id: created.id, name: created.name });
    expect((await client.listGezels()).gezels.some((gezel) => gezel.id === created.id)).toBe(false);
  });

  it('returns an error for an unknown gezel', async () => {
    await expect(client.deleteGezel('does-not-exist')).rejects.toThrow();
  });
});

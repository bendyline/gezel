import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * The general `search` tool reaches the Handboek. A gezel beside a Word
 * document keeps `search` and nothing Handboek-specific (`how_do_i` is not in
 * its kit), so "add a paragraph on why Gezel is awesome" is answered from the
 * product's own manual only if this holds: the bundled catalog is mounted like
 * any installed one and the knowledge arm of project search covers it.
 */
let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;
let baseUrl: string;
const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorArchive = process.env.GEZEL_HANDBOEK_GEZK;
const archive = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'assets',
  'handboek',
  'handboek.gezk',
);
// The service build makes the archive; it is not committed. A local checkout
// that never built it skips, and CI, which always builds it, never does.
const built = existsSync(archive) || Boolean(process.env.CI);

describe.skipIf(!built)('project search', () => {
  beforeAll(async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    process.env.GEZEL_HANDBOEK_GEZK = archive;
    home = await mkdtemp(join(tmpdir(), 'gezel-search-handboek-'));
    svc = await startService({ home });
    baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
    httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  }, 120_000);

  afterAll(async () => {
    await svc?.stop();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
    else process.env.GEZEL_MOCK_PROVIDER = priorMock;
    if (priorArchive === undefined) delete process.env.GEZEL_HANDBOEK_GEZK;
    else process.env.GEZEL_HANDBOEK_GEZK = priorArchive;
  }, 30_000);

  it('answers from the Handboek in the Default project', async () => {
    const res = await httpFetch(`${baseUrl}/api/projects/default/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${svc.context.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'What is gezel?', maxResults: 10 }),
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: Array<{ catalogId?: string; uri?: string }>;
    };
    expect(
      results.some(
        (hit) =>
          hit.catalogId === 'handboek' && hit.uri?.startsWith('knowledge://bendyline/handboek/'),
      ),
    ).toBe(true);
  }, 120_000);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningService, startService } from '../../service.js';

const craftbookMocks = vi.hoisted(() => ({
  suggestCraftbooks: vi.fn(),
}));

vi.mock('../../craftbook/suggest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../craftbook/suggest.js')>();
  return { ...actual, suggestCraftbooks: craftbookMocks.suggestCraftbooks };
});

let svc: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-linked-search-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true });
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('project search links', () => {
  it('searches the active project and its direct links, but not unrelated projects', async () => {
    const linked = await svc.context.store.createProject({ name: 'Physics Engine' });
    await svc.context.store.createProject({ name: 'Unrelated' });
    await svc.context.store.updateProject('default', { linkedProjectIds: [linked.id] });
    const search = vi
      .spyOn(svc.context.search, 'searchProject')
      .mockResolvedValue({ results: [], truncated: false });
    craftbookMocks.suggestCraftbooks.mockResolvedValue([
      {
        id: 'vehicle-physics',
        name: 'Vehicle physics',
        description: 'Tune realistic vehicle motion.',
        source: 'bundled',
        version: '1.2.0',
        stepCount: 4,
        score: 0.52,
        semantic: 0.7,
        lexical: 0.1,
      },
      {
        id: 'local-driving-review',
        name: 'Driving review',
        source: 'local',
        stepCount: 2,
        score: 0.09,
        lexical: 0.09,
      },
      {
        id: 'weak-option',
        name: 'Weak option',
        source: 'project',
        stepCount: 1,
        score: 0.2,
        semantic: 0.25,
        lexical: 0.01,
      },
    ]);

    const response = await httpFetch(`${baseUrl}/api/projects/default/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${svc.context.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'vehicle suspension' }),
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith(
      'vehicle suspension',
      expect.objectContaining({ projectIds: ['default', linked.id], includeShared: true }),
    );
    expect(craftbookMocks.suggestCraftbooks).toHaveBeenCalledWith(
      expect.objectContaining({ catalog: svc.context.catalog, store: svc.context.store }),
      { projectId: 'default', query: 'vehicle suspension', topK: 5 },
    );
    expect(await response.json()).toMatchObject({
      results: [],
      craftbooks: [
        {
          id: 'vehicle-physics',
          source: 'bundled',
          invocation: {
            tool: 'invoke_craftbook',
            arguments: {
              craftbookId: 'vehicle-physics',
              description: 'vehicle suspension',
            },
          },
        },
        {
          id: 'local-driving-review',
          source: 'local',
        },
      ],
    });
  });
});

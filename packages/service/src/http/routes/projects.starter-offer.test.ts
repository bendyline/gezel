import type { CatalogItemSummary, Task } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { listProjectCraftbookOffer } from '../../craftbook/applicable.js';
import type { ServiceContext } from '../context.js';
import { projectRoutes } from './projects.js';

vi.mock('../../craftbook/applicable.js', () => ({
  listProjectCraftbookOffer: vi.fn(),
  suggestedCraftbookIdsForType: () => [],
}));
const book = (id: string, tags: string[] = []) =>
  ({
    sourceId: 'bundled',
    manifest: {
      kind: 'craftbook-template',
      id,
      tags,
    },
  }) as CatalogItemSummary;

describe('project starter offer', () => {
  it('decides tag fallback globally, before project applicability', async () => {
    vi.mocked(listProjectCraftbookOffer).mockResolvedValue({
      items: [book('research-report')],
      missingToolsets: {},
      establishedCodebase: true,
    });
    const context = {
      catalog: {
        list: vi
          .fn()
          .mockResolvedValue([book('research-report'), book('unavailable-here', ['starter'])]),
      },
      store: { getProject: vi.fn().mockResolvedValue({ id: 'default' }) },
      tasks: { list: vi.fn().mockResolvedValue([]) },
    } as unknown as ServiceContext;
    const response = await projectRoutes(context).request('/default/craftbooks');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ starterIds: [], durationEstimatesMs: {} });
  });

  it('returns legacy starters and install-local history estimates to older catalogs', async () => {
    vi.mocked(listProjectCraftbookOffer).mockResolvedValue({
      items: [book('research-report')],
      missingToolsets: {},
      establishedCodebase: false,
    });
    const history = [
      {
        status: 'complete',
        createdAt: '2026-10-08T10:00:00Z',
        sourceCraftbookIds: [{ role: 'main', catalogId: 'research-report' }],
        craftbook: { steps: [{ completedAt: '2026-10-08T10:04:00Z' }] },
      },
    ] as Task[];
    const context = {
      catalog: { list: vi.fn().mockResolvedValue([book('research-report')]) },
      store: { getProject: vi.fn().mockResolvedValue({ id: 'default' }) },
      tasks: { list: vi.fn().mockResolvedValue(history) },
    } as unknown as ServiceContext;
    const response = await projectRoutes(context).request('/default/craftbooks');
    expect(await response.json()).toMatchObject({
      starterIds: ['research-report'],
      durationEstimatesMs: { 'research-report': 240_000 },
    });
  });
});

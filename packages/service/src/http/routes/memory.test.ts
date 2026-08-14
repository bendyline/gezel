import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { memoryRoutes } from './memory.js';

function context(memory: Record<string, unknown>): ServiceContext {
  return { memory } as unknown as ServiceContext;
}

describe('memory routes', () => {
  it('returns a successful lexical fallback when semantic search is degraded', async () => {
    const searchAllDetailed = vi.fn(async () => ({
      results: [
        {
          text: 'The launch checklist requires a rollback plan.',
          score: 1,
          day: '2026-08-14',
          scope: 'project',
          id: 'test',
          kind: 'fact',
        },
      ],
      mode: 'lexical' as const,
      degraded: {
        code: 'semantic_search_unavailable' as const,
        message:
          'Semantic memory search is temporarily unavailable; searched saved memory text directly instead.',
      },
    }));
    const app = memoryRoutes(context({ searchAllDetailed }));

    const response = await app.request('/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gezelId: 'gunnar',
        projectId: 'test',
        query: 'rollback plan',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: 'lexical',
      degraded: { code: 'semantic_search_unavailable' },
      results: [{ text: 'The launch checklist requires a rollback plan.' }],
    });
    expect(searchAllDetailed).toHaveBeenCalledWith('gunnar', 'test', 'rollback plan', 10);
  });

  it('reports a durable save when semantic indexing is deferred', async () => {
    const save = vi.fn(async () => ({
      status: 'saved' as const,
      indexed: false,
      degraded: {
        code: 'semantic_index_unavailable' as const,
        message: 'Memory was saved, but semantic indexing is temporarily unavailable.',
      },
    }));
    const app = memoryRoutes(context({ save }));

    const response = await app.request('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        id: 'test',
        text: 'Remember the rollback plan.',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'saved',
      indexed: false,
      degraded: { code: 'semantic_index_unavailable' },
    });
  });
});

import type { UnifiedSearchResult } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchService } from '../search/search-service.js';
import {
  gatherTaskReferences,
  referencesHistoryDetails,
  taskReferencesAsRetrieval,
} from './references.js';

function knowledge(id: string, title: string, snippet: string, chunk = 'a'): UnifiedSearchResult {
  return {
    kind: 'knowledge',
    id: `knowledge:food:${id}:${chunk}`,
    title,
    snippet,
    retrievalSource: 'knowledge',
    catalogId: 'wikipedia-food-drink',
    catalogVersion: '2026.5.0',
    uri: `knowledge://bendyline/wikipedia-food-drink/${id}#chunk=${chunk}`,
    score: 100,
  };
}

function shared(path: string, snippet: string): UnifiedSearchResult {
  return {
    kind: 'document',
    id: `document:${path}`,
    title: path,
    snippet,
    path,
    retrievalSource: 'shared',
    score: 90,
  };
}

function searchReturning(results: UnifiedSearchResult[]) {
  const calls: Array<{ query: string; opts: unknown }> = [];
  const search = {
    searchProject: async (query: string, opts: unknown) => {
      calls.push({ query, opts });
      return { results, truncated: false };
    },
  } as unknown as Pick<SearchService, 'searchProject'>;
  return { search, calls };
}

const BOOK = 'PowerPoint from Content';

describe('gatherTaskReferences', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps entries that name the subject and drops vector-only neighbours', async () => {
    const { search, calls } = searchReturning([
      knowledge('290627', 'Quiche', 'Quiche is a French tart with a savoury custard filling.'),
      knowledge('290627', 'Quiche', 'Quiche Lorraine is the best-known variant.', 'b'),
      knowledge('18668378', 'QuEChERS', 'A sample preparation method for pesticide analysis.'),
      shared('recipes.md', 'Sunday quiche: two eggs per person, one cup of cream.'),
    ]);
    const references = await gatherTaskReferences({
      search,
      projectId: 'default',
      subject: 'quiche',
      craftbookName: BOOK,
    });
    expect(references?.subject).toBe('quiche');
    expect(references?.items.map((item) => item.title)).toEqual(['Quiche', 'recipes.md']);
    expect(references?.items[0]).toMatchObject({
      source: 'knowledge',
      uri: 'knowledge://bendyline/wikipedia-food-drink/290627#chunk=a',
      catalogId: 'wikipedia-food-drink',
    });
    expect(calls[0]?.opts).toMatchObject({
      projectIds: ['default'],
      sources: ['knowledge', 'shared'],
      skipColdEmbedder: true,
    });
  });

  it("does not ground on the book's own name", async () => {
    const { search } = searchReturning([
      shared('PowerPoint tips.md', 'Keep every slide to one idea.'),
      knowledge('290627', 'Quiche', 'Quiche is a French tart.'),
    ]);
    const references = await gatherTaskReferences({
      search,
      projectId: 'default',
      subject: 'Can you create a PowerPoint about quiche',
      craftbookName: BOOK,
    });
    expect(references?.items.map((item) => item.title)).toEqual(['Quiche']);
  });

  it('is null when the subject is only the deliverable, or nothing matched', async () => {
    const { search, calls } = searchReturning([shared('PowerPoint tips.md', 'Slides.')]);
    expect(
      await gatherTaskReferences({
        search,
        projectId: 'p',
        subject: 'PowerPoint',
        craftbookName: BOOK,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
    expect(
      await gatherTaskReferences({
        search,
        projectId: 'p',
        subject: 'quiche',
        craftbookName: BOOK,
      }),
    ).toBeNull();
  });

  it('traces why each candidate did or did not make the list', async () => {
    const { search } = searchReturning([
      knowledge('290627', 'Quiche', 'Quiche is a French tart.'),
      knowledge('290627', 'Quiche', 'Quiche Lorraine is the best-known variant.', 'b'),
      knowledge('18668378', 'QuEChERS', 'A sample preparation method.'),
      { ...shared('notes.md', 'quiche notes'), path: undefined },
      ...['a', 'b', 'c', 'd', 'e'].map((n) => shared(`quiche-${n}.md`, `quiche ${n}`)),
    ]);
    let trace: import('@bendyline/gezel').RetrievalDecisionTrace | null = null;
    const references = await gatherTaskReferences({
      search,
      projectId: 'default',
      subject: 'quiche',
      craftbookName: BOOK,
      onDecisionTrace: (t) => {
        trace = t;
      },
    });
    const finished = trace as unknown as import('@bendyline/gezel').RetrievalDecisionTrace;
    expect(finished.surface).toBe('references');
    expect(finished.counts).toEqual({
      kept: 5,
      'duplicate-path': 1,
      lexical: 1,
      'source-policy': 1,
      'reference-limit': 1,
    });
    expect(references?.selection).toMatchObject({
      method: 'lexical',
      candidates: 9,
      rejected: { 'duplicate-path': 1, lexical: 1, 'source-policy': 1, 'reference-limit': 1 },
    });
  });

  it('launches without references when the search misses its budget', async () => {
    vi.useFakeTimers();
    const search = {
      searchProject: () => new Promise(() => {}),
    } as unknown as Pick<SearchService, 'searchProject'>;
    const pending = gatherTaskReferences({
      search,
      projectId: 'p',
      subject: 'quiche',
      craftbookName: BOOK,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toBeNull();
  });
});

describe('taskReferencesAsRetrieval', () => {
  it("reads as the chat bubble's consulted-sources disclosure", () => {
    const retrieval = taskReferencesAsRetrieval({
      subject: 'quiche',
      gatheredAt: 't',
      items: [
        {
          source: 'knowledge',
          title: 'Quiche',
          uri: 'knowledge://bendyline/wikipedia-food-drink/290627',
          snippet: 'A French tart.',
        },
        { source: 'shared', title: 'recipes.md', path: 'recipes.md' },
      ],
    });
    expect(retrieval?.injectedBytes).toBeUndefined();
    expect(retrieval?.hits).toEqual([
      {
        source: 'knowledge',
        uri: 'knowledge://bendyline/wikipedia-food-drink/290627',
        title: 'Quiche',
        score: 2,
        injectedText: 'A French tart.',
      },
      { source: 'shared', path: 'recipes.md', title: 'recipes.md', score: 1 },
    ]);
    expect(taskReferencesAsRetrieval(undefined)).toBeUndefined();
  });
});

describe('referencesHistoryDetails', () => {
  it('records citations and counts, never the subject or snippet text', () => {
    const details = referencesHistoryDetails({
      subject: 'quiche',
      gatheredAt: 't',
      items: [
        {
          source: 'knowledge',
          title: 'Quiche',
          uri: 'knowledge://bendyline/wikipedia-food-drink/290627#chunk=a',
          snippet: 'A French tart.',
        },
        { source: 'shared', title: 'recipes.md', path: 'recipes.md', snippet: 'Sunday quiche.' },
      ],
    });
    expect(details).toMatchObject({
      kept: 2,
      bySource: { knowledge: 1, shared: 1 },
      citations: ['knowledge://bendyline/wikipedia-food-drink/290627', 'shared:recipes.md'],
    });
    expect(details.subjectHash).toMatch(/^[0-9a-f]{16}$/);
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('quiche');
    expect(serialized).not.toContain('French tart');
  });
});

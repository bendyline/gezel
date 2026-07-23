import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the embedding pipeline so the content fan-out doesn't load
// transformers.js (and so we can assert it's called exactly once).
const embedMock = vi.fn(async (_text: string) => [0.1, 0.2, 0.3]);
vi.mock('../memory/embeddings.js', () => ({
  embed: (text: string) => embedMock(text),
  embedQuery: (text: string) => embedMock(text),
}));

import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { GlobalIndex, SessionSearchHit } from '../index-store/global-index.js';
import type { MemoryManager } from '../memory/manager.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import { SearchService, fuzzyScore } from './search-service.js';

function makeService(
  opts: {
    projects?: Array<{ id: string; name: string }>;
    gezels?: Array<{ id: string; name: string; role?: string }>;
    documents?: Array<{ name: string; path: string; isDirectory: boolean }>;
    files?: Record<string, Array<{ path: string; size: number; mtimeMs: number }>>;
    code?: ContentIndex['searchCode'];
    sessionHits?: SessionSearchHit[];
    documentHits?: Array<{ path: string; lineStart: number; snippet: string }>;
  } = {},
) {
  const store = {
    listProjects: vi.fn(async () => opts.projects ?? []),
    listGezels: vi.fn(async () => opts.gezels ?? []),
    listDocumentsRecursive: vi.fn(async () => opts.documents ?? []),
  } as unknown as Store;

  const contentIndex = {
    searchCode:
      opts.code ??
      vi.fn(async () => ({ results: [], engine: 'unavailable' as const, truncated: false })),
    searchDocs: vi.fn(async () => ({
      results: [],
      engine: 'unavailable' as const,
      truncated: false,
    })),
    findSymbol: vi.fn(async () => ({
      matches: [],
      truncated: false,
      engine: 'unavailable' as const,
    })),
  } as unknown as ContentIndex;

  const memory = {
    searchVector: vi.fn(async () => []),
  } as unknown as MemoryManager;

  const indexManager = {
    readFiles: vi.fn(async (id: string) => opts.files?.[id] ?? []),
  } as unknown as WorkspaceIndexManager;

  const globalIndex = {
    searchSessions: vi.fn(async () => opts.sessionHits ?? []),
    searchDocuments: vi.fn(async () => opts.documentHits ?? []),
    searchHistory: vi.fn(async () => null),
    status: vi.fn(async () => ({
      available: true,
      sessions: 0,
      history: 0,
      historyBackfilledAt: null,
      documents: 0,
    })),
  } as unknown as GlobalIndex;

  return new SearchService(store, contentIndex, memory, indexManager, globalIndex);
}

beforeEach(() => {
  embedMock.mockClear();
});

describe('fuzzyScore', () => {
  it('ranks exact > prefix > substring > subsequence > miss', () => {
    expect(fuzzyScore('game', 'game')).toBe(1);
    const prefix = fuzzyScore('ga', 'game')!;
    const substring = fuzzyScore('am', 'game')!;
    const subseq = fuzzyScore('gm', 'game')!;
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subseq);
    expect(fuzzyScore('xyz', 'game')).toBeNull();
  });
});

describe('SearchService.quickOpen', () => {
  it('matches project, gezel, document, and file names', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Space Shooter' }],
      gezels: [{ id: 'g1', name: 'Laxmi', role: 'Voorman' }],
      documents: [{ name: 'resume.md', path: 'jobs/resume.md', isDirectory: false }],
      files: { p1: [{ path: 'src/index.html', size: 1, mtimeMs: 0 }] },
    });

    const proj = await svc.quickOpen('space');
    expect(proj[0]?.kind).toBe('project');
    expect(proj[0]?.title).toBe('Space Shooter');

    const gez = await svc.quickOpen('laxmi');
    expect(gez.some((r) => r.kind === 'gezel' && r.title === 'Laxmi')).toBe(true);

    const file = await svc.quickOpen('index.html');
    const hit = file.find((r) => r.kind === 'file');
    expect(hit?.projectId).toBe('p1');
    expect(hit?.path).toBe('src/index.html');
    expect(hit?.source).toBe('workspace');
  });

  it('returns nothing for a query that matches no name', async () => {
    const svc = makeService({ projects: [{ id: 'p1', name: 'Space Shooter' }] });
    expect(await svc.quickOpen('zzzzz')).toEqual([]);
  });

  it('invalidateCatalog forces a rebuild so new entities are found immediately', async () => {
    const projects = [{ id: 'p1', name: 'Space Shooter' }];
    const store = {
      listProjects: vi.fn(async () => projects),
      listGezels: vi.fn(async () => []),
      listDocumentsRecursive: vi.fn(async () => []),
    } as unknown as Store;
    const svc = new SearchService(
      store,
      {} as unknown as ContentIndex,
      {} as unknown as MemoryManager,
      { readFiles: vi.fn(async () => []) } as unknown as WorkspaceIndexManager,
    );

    expect(await svc.quickOpen('shop')).toEqual([]); // catalog cached, no Pet Shop yet
    projects.push({ id: 'p2', name: 'Pet Shop' });
    expect(await svc.quickOpen('shop')).toEqual([]); // still cached within TTL
    svc.invalidateCatalog();
    const after = await svc.quickOpen('shop');
    expect(after[0]?.title).toBe('Pet Shop');
  });
});

describe('SearchService.search (full)', () => {
  it('embeds the query once across the cross-project content fan-out', async () => {
    const code = vi.fn(async () => ({
      results: [
        {
          path: 'src/game.js',
          lineStart: 10,
          lineEnd: 12,
          kind: 'chunk',
          snippet: 'shoot()',
          score: 0.9,
          source: 'vector' as const,
        },
      ],
      engine: 'semantic' as const,
      truncated: false,
    })) as unknown as ContentIndex['searchCode'];

    const svc = makeService({
      projects: [
        { id: 'p1', name: 'Space Shooter' },
        { id: 'p2', name: 'Pet Shop' },
        { id: 'p3', name: 'Tank Combat' },
      ],
      code,
    });

    const { results } = await svc.search('shoot', { mode: 'full' });
    // One embed for the whole fan-out, not one per project.
    expect(embedMock).toHaveBeenCalledTimes(1);
    // Content hits surfaced from the per-project index.
    expect(results.some((r) => r.kind === 'content' && r.path === 'src/game.js')).toBe(true);
    // Each project's searchCode got the precomputed vector.
    expect(code as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);
    expect((code as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      queryVector: [0.1, 0.2, 0.3],
    });
  });

  it('names mode skips the content fan-out (no embedding)', async () => {
    const svc = makeService({ projects: [{ id: 'p1', name: 'Space Shooter' }] });
    await svc.search('space', { mode: 'names' });
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('surfaces session transcript hits with gezel/project display names', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Space Shooter' }],
      gezels: [{ id: 'g1', name: 'Laxmi' }],
      sessionHits: [
        {
          sessionId: 'sess-1',
          gezelId: 'g1',
          projectId: 'p1',
          title: 'Weapon tuning',
          snippet: 'we agreed to nerf the laser',
          messageStart: 4,
          lastActivityAt: '2026-06-01T00:00:00Z',
          archived: false,
        },
      ],
    });
    const { results } = await svc.search('laser', { mode: 'full' });
    const hit = results.find((r) => r.kind === 'session');
    expect(hit?.id).toBe('session:sess-1');
    expect(hit?.title).toBe('Weapon tuning');
    expect(hit?.subtitle).toBe('Laxmi · Space Shooter');
    expect(hit?.gezelId).toBe('g1');
    expect(hit?.projectId).toBe('p1');
  });

  it('collapses a document content hit into the catalog document row by id', async () => {
    const svc = makeService({
      documents: [{ name: 'style.md', path: 'guides/style.md', isDirectory: false }],
      documentHits: [{ path: 'guides/style.md', lineStart: 3, snippet: 'zwaluw pattern' }],
    });
    const { results } = await svc.search('style', { mode: 'full' });
    const docRows = results.filter((r) => r.id === 'document:guides/style.md');
    expect(docRows).toHaveLength(1);
  });
});

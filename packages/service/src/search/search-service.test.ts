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
    gezels?: Array<{ id: string; name: string; role?: string; roleBasedName?: string }>;
    documents?: Array<{ name: string; path: string; isDirectory: boolean }>;
    files?: Record<string, Array<{ path: string; size: number; mtimeMs: number }>>;
    code?: ContentIndex['searchCode'];
    sessionHits?: SessionSearchHit[];
    documentHits?: Array<{ path: string; lineStart: number; snippet: string }>;
    libraryHits?: Array<{
      path: string;
      lineStart: number;
      lineEnd?: number;
      snippet: string;
      score?: number;
    }>;
    artifactFiles?: Record<string, string[]>;
    artifactHits?: Array<{ path: string; lineStart: number; snippet: string }>;
    areaHits?: Array<{ areaPath: string; summary: string; score: number }>;
    /** Vector-memory rows returned for every scope the fan-out asks about. */
    memoryHits?: Array<{ text: string; score: number; day: string }>;
    memorySearch?: MemoryManager['searchVector'];
  } = {},
) {
  const store = {
    listProjects: vi.fn(async () => opts.projects ?? []),
    listGezels: vi.fn(async () => opts.gezels ?? []),
    listDocumentsRecursive: vi.fn(async () => opts.documents ?? []),
    sharedProjectId: vi.fn(async () => 'shared'),
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
    searchArtifacts: vi.fn(async () => ({
      results: opts.artifactHits ?? [],
      truncated: false,
    })),
    listArtifactIndexFiles: vi.fn(async (id: string) => opts.artifactFiles?.[id] ?? []),
    findSymbol: vi.fn(async () => ({
      matches: [],
      truncated: false,
      engine: 'unavailable' as const,
    })),
    searchAreaSummaries: vi.fn(async () => opts.areaHits ?? []),
    searchLibrary: vi.fn(async () => ({
      results: opts.libraryHits ?? [],
      engine: 'hybrid' as const,
    })),
  } as unknown as ContentIndex;

  const memory = {
    searchVector: opts.memorySearch ?? vi.fn(async () => opts.memoryHits ?? []),
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

  /**
   * The product's whole vocabulary is roles — a user reading the Handboek
   * types "meester", not the random first name that gezel was given. The role
   * was in the catalog as a display subtitle but was never a match target, so
   * searching the app's own front-door concept found nothing.
   */
  it('finds a gezel by role and by role-based name, not just by first name', async () => {
    const svc = makeService({
      gezels: [
        { id: 'g1', name: 'Ulrike', role: 'Meester', roleBasedName: 'meester' },
        { id: 'g2', name: 'Senga', role: 'Boekwachter', roleBasedName: 'boekwachter' },
      ],
    });

    const byRole = await svc.quickOpen('meester');
    expect(byRole[0]?.kind).toBe('gezel');
    expect(byRole[0]?.title).toBe('Ulrike');

    const byOtherRole = await svc.quickOpen('boekwachter');
    expect(byOtherRole[0]?.title).toBe('Senga');

    // Names still work, and still outrank a role match on the same query.
    const byName = await svc.quickOpen('ulrike');
    expect(byName[0]?.title).toBe('Ulrike');
  });

  it('ranks an exact name match above another gezel matched by role', async () => {
    const svc = makeService({
      gezels: [
        { id: 'g1', name: 'Klerk', role: 'Reviewer' },
        { id: 'g2', name: 'Bram', role: 'Klerk' },
      ],
    });
    const results = await svc.quickOpen('klerk');
    expect(results.map((r) => r.title)).toEqual(['Klerk', 'Bram']);
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
      { listArtifactIndexFiles: vi.fn(async () => []) } as unknown as ContentIndex,
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

  /**
   * Vector search is nearest-neighbour, so it hands back its top K for any
   * query at all — including gibberish. Without a floor the palette answered
   * a nonsense string with three confident-looking memories, and "No results"
   * became unreachable on any install that had memories at all.
   */
  it('drops memory hits below the relevance floor', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Space Shooter' }],
      memoryHits: [
        { text: 'The deployment runbook lives in docs/deploy.md', score: 0.82, day: '2026-08-01' },
        { text: 'Examples:', score: 0.13, day: '2026-08-01' },
        { text: 'New messages:', score: 0.33, day: '2026-08-01' },
      ],
    });

    const { results } = await svc.search('deployment runbook', { mode: 'full' });
    const memories = results.filter((r) => r.kind === 'memory');
    expect(memories).toHaveLength(1);
    expect(memories[0]?.snippet).toBe('The deployment runbook lives in docs/deploy.md');
  });

  it('returns nothing at all when only sub-floor memories match', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Space Shooter' }],
      memoryHits: [
        { text: 'Examples:', score: 0.11, day: '2026-08-01' },
        { text: 'New messages:', score: 0.33, day: '2026-08-01' },
      ],
    });
    const { results } = await svc.search('zzqqxx', { mode: 'full' });
    expect(results).toEqual([]);
  });

  /**
   * A memory id carries its scope and day, so the same sentence remembered by
   * two gezels (or on two days) cleared the id-based pass and listed twice —
   * observed four times over in one live query.
   */
  it('collapses the same remembered sentence recorded in several scopes', async () => {
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Space Shooter' }],
      gezels: [
        { id: 'g1', name: 'Ada' },
        { id: 'g2', name: 'Bram' },
      ],
      memoryHits: [
        { text: 'Sessions are stored as JSON files.', score: 0.86, day: '2026-08-01' },
        { text: '  sessions ARE stored as JSON files.  ', score: 0.7, day: '2026-08-02' },
      ],
    });

    const { results } = await svc.search('where are sessions stored', { mode: 'full' });
    const memories = results.filter((r) => r.kind === 'memory');
    expect(memories).toHaveLength(1);
    // The best-scoring copy survives, keeping its own navigable id.
    expect(memories[0]?.snippet).toBe('Sessions are stored as JSON files.');
    expect(memories[0]?.id.startsWith('memory:')).toBe(true);
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

  it('surfaces artifact-corpus hits and catalog rows with source artifacts', async () => {
    const record = 'data/bluesky/posts/2026-08/001--sunrise.md';
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Ops' }],
      artifactFiles: { p1: [record] },
      artifactHits: [{ path: record, lineStart: 5, snippet: 'sunrise over the haven' }],
    });

    const { results } = await svc.search('sunrise', { mode: 'full' });

    const content = results.find((r) => r.kind === 'content' && r.source === 'artifacts');
    expect(content).toMatchObject({
      id: `content:p1:artifacts:${record}:5`,
      title: '001--sunrise.md',
      subtitle: `Ops · ${record}`,
      snippet: 'sunrise over the haven',
      projectId: 'p1',
      path: record,
      line: 5,
    });

    // The name catalog carries the indexed record too, as a file entry.
    const file = results.find((r) => r.kind === 'file' && r.source === 'artifacts');
    expect(file).toMatchObject({
      id: `file:p1:artifacts:${record}`,
      title: '001--sunrise.md',
      projectId: 'p1',
      path: record,
    });
  });
});

describe('SearchService.searchProject', () => {
  it('stays inside the authorized project and current gezel while including shared documents', async () => {
    const code = vi.fn(async (projectId: string) => ({
      results: [
        {
          path: `src/${projectId}.ts`,
          lineStart: 10,
          lineEnd: 24,
          kind: 'chunk',
          snippet: `${projectId} vehicle physics`,
          score: 0.9,
          source: 'vector' as const,
        },
      ],
      engine: 'semantic' as const,
      truncated: false,
    })) as unknown as ContentIndex['searchCode'];
    const memorySearch = vi.fn(async (scope: string, id: string) => [
      { text: `${scope}:${id}:physics decision`, score: 0.84, day: '2026-08-19' },
    ]) as unknown as MemoryManager['searchVector'];
    const svc = makeService({
      projects: [
        { id: 'p1', name: 'Driving Game' },
        { id: 'p2', name: 'Unrelated App' },
      ],
      gezels: [
        { id: 'g1', name: 'Ada' },
        { id: 'g2', name: 'Bram' },
      ],
      code,
      memorySearch,
      libraryHits: [
        {
          path: 'guides/vehicle-physics.md',
          lineStart: 4,
          lineEnd: 18,
          snippet: 'shared vehicle physics conventions',
          score: 0.8,
        },
      ],
      areaHits: [
        {
          areaPath: '::project',
          summary: 'The driving model separates tire grip, suspension, and input response.',
          score: 0.75,
        },
      ],
      sessionHits: [
        {
          sessionId: 'unrelated-session',
          gezelId: 'g2',
          projectId: 'p2',
          title: 'Must not leak',
          snippet: 'private transcript',
          messageStart: 1,
          lastActivityAt: '2026-08-19T00:00:00Z',
          archived: false,
        },
      ],
    });

    const { results } = await svc.searchProject('improve vehicle physics', {
      projectIds: ['p1'],
      gezelId: 'g1',
    });

    expect(code as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect((code as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('p1');
    expect(memorySearch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'project',
      'p1',
      expect.any(Array),
      expect.any(Number),
    );
    expect(memorySearch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'gezel',
      'g1',
      expect.any(Array),
      expect.any(Number),
    );
    expect(results.some((result) => result.projectId === 'p2')).toBe(false);
    expect(results.some((result) => result.kind === 'session')).toBe(false);
    expect(new Set(results.map((result) => result.retrievalSource))).toEqual(
      new Set(['workspace', 'project-memory', 'gezel-memory', 'shared']),
    );
    expect(results.find((result) => result.id === 'overview:p1:::project')).toMatchObject({
      title: 'Driving Game overview',
      retrievalSource: 'workspace',
    });
    expect(results.find((result) => result.retrievalSource === 'shared')).toMatchObject({
      path: 'guides/vehicle-physics.md',
      line: 4,
      lineEnd: 18,
    });
  });

  it('honors corpus filters without disabling the generic search surface', async () => {
    const code = vi.fn(async () => ({
      results: [],
      engine: 'fts',
      truncated: false,
    })) as unknown as ContentIndex['searchCode'];
    const svc = makeService({
      projects: [{ id: 'p1', name: 'Driving Game' }],
      code,
      libraryHits: [{ path: 'guides/physics.md', lineStart: 1, snippet: 'physics', score: 0.9 }],
    });

    const { results } = await svc.searchProject('physics', {
      projectIds: ['p1'],
      sources: ['shared'],
    });
    expect(code as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(results.map((result) => result.retrievalSource)).toEqual(['shared']);
  });
});

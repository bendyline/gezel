import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the embedding pipeline so the content fan-out doesn't load
// transformers.js (and so we can assert it's called exactly once).
const embedMock = vi.fn(async (_text: string) => [0.1, 0.2, 0.3]);
const embeddingStatusMock = vi.fn(() => 'ready' as 'cold' | 'warming' | 'ready');
vi.mock('../memory/embeddings.js', () => ({
  embed: (text: string) => embedMock(text),
  embedQuery: (text: string) => embedMock(text),
  embeddingPipelineStatus: () => embeddingStatusMock(),
}));

import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import type { GlobalIndex, SessionSearchHit } from '../index-store/global-index.js';
import type { MemoryManager } from '../memory/manager.js';
import type { WorkspaceIndexManager } from '../workspace/index-manager.js';
import { MERGE_WEIGHTS, SearchService, fuzzyScore } from './search-service.js';

function makeService(
  opts: {
    projects?: Array<{ id: string; name: string }>;
    gezels?: Array<{ id: string; name: string; role?: string; roleBasedName?: string }>;
    documents?: Array<{ name: string; path: string; isDirectory: boolean }>;
    files?: Record<string, Array<{ path: string; size: number; mtimeMs: number }>>;
    code?: ContentIndex['searchCode'];
    docHits?: Array<{ sourcePath: string; lineStart: number; lineEnd?: number; snippet: string }>;
    symbolHits?: Array<{ name: string; kind: string; path: string; lineStart: number }>;
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
      results: opts.docHits ?? [],
      engine: 'unavailable' as const,
      truncated: false,
    })),
    searchArtifacts: vi.fn(async () => ({
      results: opts.artifactHits ?? [],
      truncated: false,
    })),
    listArtifactIndexFiles: vi.fn(async (id: string) => opts.artifactFiles?.[id] ?? []),
    findSymbol: vi.fn(async () => ({
      matches: opts.symbolHits ?? [],
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
  embeddingStatusMock.mockReturnValue('ready');
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

  it('penalizes a scattered short subsequence below a genuine substring', () => {
    // "kim" is a subsequence of "SKILL.md" by accident and a substring of
    // "checkImageRefsResolve.ts" on purpose; linearly weighted the accident
    // scored 0.41, enough for a wall of skills fixtures to outrank the
    // library document that actually said Kim.
    const accident = fuzzyScore('kim', 'SKILL.md')!;
    const real = fuzzyScore('kim', 'checkImageRefsResolve.ts')!;
    expect(accident).toBeLessThan(0.25);
    expect(real).toBeGreaterThan(accident * 2);
    // Compactness dominates: the same letters closer together score higher.
    expect(fuzzyScore('kim', 'kinematics.ts')!).toBeGreaterThan(accident);
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

  it('finds mail by subject and by sender, opening as an artifact file', async () => {
    const svc = makeService({ projects: [{ id: 'p1', name: 'Inbox Project' }] });
    svc.setExtraCatalogs({
      mailEntries: async () => [
        {
          projectId: 'p1',
          path: 'data/work-mail/inbox/2026-08-19--quarterly-report--abcd1234/001--2026-08-19T14-32--from-alice--deadbeef.md',
          subject: 'quarterly report',
          from: 'alice',
          date: '2026-08-19 14:32',
        },
      ],
    });

    const bySubject = await svc.quickOpen('quarterly report');
    expect(bySubject[0]).toMatchObject({
      kind: 'mail',
      title: 'quarterly report',
      subtitle: 'alice · 2026-08-19 14:32',
      projectId: 'p1',
      source: 'artifacts',
    });
    expect(bySubject[0]?.path).toContain('quarterly-report');

    // Sender reachable via keywords (at the usual keyword discount).
    const bySender = await svc.quickOpen('alice');
    expect(bySender.some((r) => r.kind === 'mail')).toBe(true);

    // Personal mail outranks catalog kinds but never a typed task title.
    expect(MERGE_WEIGHTS.mail).toBeGreaterThan(MERGE_WEIGHTS.craftbook);
    expect(MERGE_WEIGHTS.mail).toBeLessThan(MERGE_WEIGHTS.task);
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

  it('answers from the keyword arms rather than wait for a cold embedder', async () => {
    const code = vi.fn(async () => ({
      results: [{ path: 'src/physics.ts', lineStart: 1, snippet: 'physics', score: 0.8 }],
      engine: 'fts',
      truncated: false,
    })) as unknown as ContentIndex['searchCode'];
    const svc = makeService({ projects: [{ id: 'p1', name: 'Driving Game' }], code });
    embeddingStatusMock.mockReturnValue('warming');

    const { results } = await svc.searchProject('physics', {
      projectIds: ['p1'],
      skipColdEmbedder: true,
    });

    expect(embedMock).not.toHaveBeenCalled();
    expect((code as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).not.toHaveProperty(
      'queryVector',
    );
    expect(results.map((result) => result.path)).toContain('src/physics.ts');
  });

  it('waits for the embedder when the caller did not opt out', async () => {
    const code = vi.fn(async () => ({
      results: [],
      engine: 'fts',
      truncated: false,
    })) as unknown as ContentIndex['searchCode'];
    const svc = makeService({ projects: [{ id: 'p1', name: 'Driving Game' }], code });
    embeddingStatusMock.mockReturnValue('cold');

    await svc.searchProject('physics', { projectIds: ['p1'] });

    expect(embedMock).toHaveBeenCalledTimes(1);
  });
});

describe('cross-corpus merge ordering (scoring tripwire)', () => {
  // Pins the exact merged order the weighted merge produces across every
  // scoring path — catalog fuzzy, hybrid code scores, FTS pseudo-relevance,
  // symbol fuzzy + fallback, area lexical, memory cosine, session, library.
  // Any ranking change must update this test DELIBERATELY, with the diff
  // explained; the relevance/tier calibration refactor is expected to keep
  // this order except where a comment below says otherwise.
  it('merges every corpus in the pinned order', async () => {
    const code = vi.fn(async () => ({
      engine: 'hybrid' as const,
      truncated: false,
      results: [
        {
          path: 'src/engine.ts',
          name: 'engine',
          lineStart: 3,
          lineEnd: 9,
          snippet: 'rocket engine thrust curve',
          score: 0.9,
          source: 'vector' as const,
        },
        {
          path: 'src/hud.ts',
          name: 'hud',
          lineStart: 1,
          lineEnd: 4,
          snippet: 'hud shows thrust readout',
          score: 0.5,
          source: 'fts' as const,
        },
      ],
    })) as unknown as ContentIndex['searchCode'];
    const memorySearch = vi.fn(async (scope: string) =>
      scope === 'project'
        ? [{ text: 'Thrust tuning lives in engine.ts', score: 0.8, day: '2026-08-01' }]
        : [{ text: 'User prefers metric units', score: 0.5, day: '2026-08-02' }],
    ) as unknown as MemoryManager['searchVector'];

    const svc = makeService({
      projects: [{ id: 'p1', name: 'Thrust Lab' }],
      gezels: [{ id: 'g1', name: 'Rem' }],
      code,
      memorySearch,
      docHits: [
        { sourcePath: 'docs/thrust.docx', lineStart: 2, snippet: 'thrust doc one' },
        { sourcePath: 'docs/nozzle.docx', lineStart: 5, snippet: 'thrust doc two' },
      ],
      artifactHits: [{ path: 'reports/thrust.md', lineStart: 1, snippet: 'thrust artifact' }],
      symbolHits: [
        { name: 'thrustVector', kind: 'function', path: 'src/engine.ts', lineStart: 3 },
        { name: 'applyForce', kind: 'function', path: 'src/engine.ts', lineStart: 40 },
      ],
      areaHits: [{ areaPath: 'src', summary: 'Engine and HUD code.', score: 0.7 }],
      sessionHits: [
        {
          sessionId: 's1',
          gezelId: 'g1',
          projectId: 'p1',
          title: 'Thrust chat',
          snippet: 'we discussed thrust',
          messageStart: 1,
          lastActivityAt: '2026-08-19T00:00:00Z',
          archived: false,
        },
      ],
      libraryHits: [
        { path: 'guides/thrust.md', lineStart: 4, snippet: 'thrust guide', score: 0.9 },
        { path: 'guides/nozzles.md', lineStart: 9, snippet: 'nozzle guide' },
      ],
    });

    const { results } = await svc.search('thrust', { mode: 'full' });
    // Deliberate ranking history: FTS-only corpora carried a FLAT 0.6
    // pseudo-relevance until the calibration refactor replaced it with
    // rank-decayed pseudo-relevance (ftsRankRelevance: rank 0 = 0.6
    // bit-identical, rank 1 ≈ 0.55, …). The only rows that moved were
    // rank-1 FTS rows: the unscored library hit (0.6→0.55 × 680: 408→374,
    // now below the 0.9-scored code hit at 378) and the second docs hit
    // (252→231, now below the rank-0 session at 240). Every rank-0 and
    // every real-scored row is in its pre-refactor position.
    // Memory ids end in a content hash the test cannot precompute — read the
    // suffix off the live rows and pin the deterministic prefix around it.
    const projectMemoryHash = results
      .find((r) => r.retrievalSource === 'project-memory')!
      .id.split(':')
      .at(-1);
    const gezelMemoryHash = results
      .find((r) => r.retrievalSource === 'gezel-memory')!
      .id.split(':')
      .at(-1);
    expect(results.map((r) => r.id)).toEqual([
      'project:p1', // project name prefix match: 0.95 × 1000
      'document:guides/thrust.md', // library, real hybrid score 0.9 × 680
      'symbol:p1:src/engine.ts:thrustVector', // symbol prefix fuzzy 0.95 × 520
      'content:p1:src/engine.ts:3', // code hybrid 0.9 × 420
      'document:guides/nozzles.md', // library, no score → FTS rank-1 pseudo-relevance × 680
      'overview:p1:src', // area lexical 0.7 × 420
      `memory:project:p1:2026-08-01:${projectMemoryHash}`, // project memory 0.8 × 360
      'content:p1:docs/thrust.docx:2', // docs FTS rank 0 (0.6 × 420, bit-identical)
      'content:p1:artifacts:reports/thrust.md:1', // artifacts FTS rank 0
      'session:s1', // session FTS rank 0 (0.6 × 400)
      'content:p1:docs/nozzle.docx:5', // docs FTS rank 1 (decayed)
      'content:p1:src/hud.ts:1', // code hybrid 0.5 × 420
      'symbol:p1:src/engine.ts:applyForce', // symbol fallback 0.4 × 520
      `memory:gezel:g1:2026-08-02:${gezelMemoryHash}`, // gezel memory 0.5 × 360
    ]);

    // Calibration invariants: every row carries a 0–1 relevance, tier derives
    // from the single strong-tier constant, and score = relevance × weight.
    for (const r of results) {
      expect(r.relevance).toBeGreaterThanOrEqual(0);
      expect(r.relevance).toBeLessThanOrEqual(1);
      expect(r.tier).toBe(r.relevance! >= 0.6 ? 'strong' : 'weak');
      expect(r.score).toBeCloseTo(r.relevance! * MERGE_WEIGHTS[r.kind], 10);
    }
    expect(results.find((r) => r.id === 'content:p1:src/engine.ts:3')?.tier).toBe('strong');
    expect(results.find((r) => r.id === 'content:p1:src/hud.ts:1')?.tier).toBe('weak');
  });
});

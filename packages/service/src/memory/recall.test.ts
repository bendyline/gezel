import { describe, expect, it, vi } from 'vitest';
import type { MemoryKind } from './daily-markdown.js';
import type { MemoryManager } from './manager.js';
import { ageInDays, decayedScore, renderRecallBlock, runAutoRecall } from './recall.js';

function stubMemory(
  results: Array<{
    text: string;
    scope: 'gezel' | 'project';
    day: string;
    score: number;
    kind?: MemoryKind;
  }>,
): MemoryManager {
  return {
    searchVector: async (scope: 'gezel' | 'project') =>
      results.filter((r) => r.scope === scope).map((r) => ({ ...r, id: 'anything' })),
  } as unknown as MemoryManager;
}

const stubEmbed = async () => [0.1, 0.2, 0.3];

describe('runAutoRecall', () => {
  const baseArgs = {
    gezelId: 'ada',
    projectId: 'default',
    query: 'what were we working on?',
    providerName: 'ollama' as const,
    embedQuery: stubEmbed,
  };

  it('returns filtered & deduped hits up to topK', async () => {
    const memory = stubMemory([
      { text: 'A', scope: 'project', day: '2026-04-10', score: 0.9 },
      { text: 'B', scope: 'gezel', day: '2026-04-11', score: 0.7 },
      { text: 'A', scope: 'project', day: '2026-04-12', score: 0.6 },
      { text: 'C', scope: 'project', day: '2026-04-13', score: 0.2 }, // below minScore
    ]);
    const hits = await runAutoRecall({
      ...baseArgs,
      config: {},
      memory,
    });
    expect(hits).not.toBeNull();
    expect(hits!.map((h) => h.text)).toEqual(['A', 'B']);
  });

  it('is disabled when config.autoRecall.enabled is false', async () => {
    const memory = stubMemory([{ text: 'x', scope: 'project', day: 'd', score: 0.9 }]);
    const hits = await runAutoRecall({
      ...baseArgs,
      config: { autoRecall: { enabled: false } },
      memory,
    });
    expect(hits).toBeNull();
  });

  it('per-gezel true override beats a global off setting', async () => {
    const memory = stubMemory([{ text: 'x', scope: 'project', day: 'd', score: 0.9 }]);
    const hits = await runAutoRecall({
      ...baseArgs,
      config: { autoRecall: { enabled: false } },
      memory,
      gezelOptIn: true,
    });
    expect(hits).not.toBeNull();
    expect(hits).toHaveLength(1);
  });

  it('per-gezel false override disables even when global is on', async () => {
    const memory = stubMemory([{ text: 'x', scope: 'project', day: 'd', score: 0.9 }]);
    const hits = await runAutoRecall({
      ...baseArgs,
      config: {},
      memory,
      gezelOptIn: false,
    });
    expect(hits).toBeNull();
  });

  it('uses tighter topK for ollama by default', async () => {
    const memory = stubMemory([
      { text: 'a', scope: 'project', day: 'd', score: 0.9 },
      { text: 'b', scope: 'project', day: 'd', score: 0.85 },
      { text: 'c', scope: 'project', day: 'd', score: 0.8 },
      { text: 'd', scope: 'project', day: 'd', score: 0.75 },
      { text: 'e', scope: 'project', day: 'd', score: 0.7 },
    ]);
    const ollamaHits = await runAutoRecall({
      ...baseArgs,
      config: {},
      memory,
    });
    expect(ollamaHits).toHaveLength(3);

    const openaiHits = await runAutoRecall({
      ...baseArgs,
      providerName: 'openai',
      config: {},
      memory,
    });
    expect(openaiHits).toHaveLength(4);
  });
});

describe('recall cold-start guard', () => {
  it('skips embedding entirely when no memory index and no content index exist', async () => {
    const embedQuery = vi.fn(async () => {
      throw new Error('should not embed');
    });
    const memory = {
      hasIndex: () => false,
      searchVector: async () => [],
    } as unknown as MemoryManager;
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'first message on a fresh install',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery,
      contentIndex: { hasIndex: async () => false, searchCode: async () => ({}) } as never,
    });
    expect(hits).toBeNull();
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('still embeds when the content index exists even without memories', async () => {
    const memory = {
      hasIndex: () => false,
      searchVector: async () => [],
    } as unknown as MemoryManager;
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'q',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      contentIndex: {
        hasIndex: async () => true,
        searchCode: async () => ({
          results: [
            {
              path: 'src/a.ts',
              lineStart: 1,
              lineEnd: 2,
              kind: 'chunk',
              snippet: 'hit',
              score: 0.9,
              source: 'vector' as const,
            },
          ],
          engine: 'semantic' as const,
          truncated: false,
        }),
      } as never,
    });
    expect(hits!.map((h) => h.scope)).toEqual(['workspace']);
  });

  it('fails open when a ready embedding pipeline exceeds the interactive deadline', async () => {
    const embedQuery = vi.fn(() => new Promise<number[]>(() => {}));
    const memory = {
      hasIndex: () => true,
      embeddingStatus: () => 'ready',
      searchVector: async () => [],
    } as unknown as MemoryManager;
    const startedAt = Date.now();

    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'do not block this turn',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery,
      interactiveDeadlineMs: 20,
    });

    expect(hits).toBeNull();
    expect(embedQuery).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('warms a cold embedding pipeline in the background without delaying the turn', async () => {
    const embedQuery = vi.fn(() => new Promise<number[]>(() => {}));
    const memory = {
      hasIndex: () => true,
      embeddingStatus: () => 'cold',
      searchVector: async () => [],
    } as unknown as MemoryManager;

    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'warm for later',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery,
      interactiveDeadlineMs: 10_000,
    });

    expect(hits).toBeNull();
    expect(embedQuery).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight embedding wait without waiting for its deadline', async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const embedQuery = vi.fn(() => {
      markStarted();
      return new Promise<number[]>(() => {});
    });
    const memory = {
      hasIndex: () => true,
      embeddingStatus: () => 'ready',
      searchVector: async () => [],
    } as unknown as MemoryManager;

    const recall = runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'cancel me',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery,
      interactiveDeadlineMs: 10_000,
      signal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(recall).resolves.toBeNull();
  });
});

describe('shared-library recall', () => {
  const libraryIndex = (results: Array<{ path: string; snippet: string; score: number }>) =>
    ({
      hasIndex: async () => true,
      searchCode: async () => ({ results: [], engine: 'semantic' as const, truncated: false }),
      searchLibrary: async () => ({
        results: results.map((r) => ({ lineStart: 1, ...r })),
        engine: 'hybrid' as const,
      }),
    }) as never;

  it('surfaces a strong library hit regardless of the session project', async () => {
    // The library is install-wide: a policy filed once answers the question
    // wherever it is asked, so this leg is not scoped to `projectId`.
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'some-unrelated-project',
      query: 'what is our refund window',
      providerName: 'openai',
      config: {},
      memory: stubMemory([]),
      embedQuery: stubEmbed,
      contentIndex: libraryIndex([
        { path: 'policies/refunds.md', snippet: 'Refunds within 30 days.', score: 0.82 },
      ]),
      libraryProjectId: 'shared',
    });
    expect(hits!.map((h) => h.scope)).toEqual(['library']);
    expect(hits![0]!.text).toContain('policies/refunds.md');
    expect(renderRecallBlock(hits!)).toContain('- [library] `policies/refunds.md`');
  });

  it('drops weak matches — a global corpus makes a loose hit an intrusion', async () => {
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'unrelated question',
      providerName: 'openai',
      config: {},
      memory: stubMemory([]),
      embedQuery: stubEmbed,
      contentIndex: libraryIndex([
        { path: 'notes/misc.md', snippet: 'Tangentially similar prose.', score: 0.31 },
      ]),
      libraryProjectId: 'shared',
    });
    expect(hits ?? []).toEqual([]);
  });

  it('skips the leg entirely when no library exists', async () => {
    const searchLibrary = vi.fn();
    await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'q',
      providerName: 'openai',
      config: {},
      memory: stubMemory([]),
      embedQuery: stubEmbed,
      contentIndex: {
        hasIndex: async () => true,
        searchCode: async () => ({ results: [], engine: 'semantic' as const, truncated: false }),
        searchLibrary,
      } as never,
      libraryProjectId: null,
    });
    expect(searchLibrary).not.toHaveBeenCalled();
  });
});

describe('index-enriched recall', () => {
  it('appends deduped code hits from the content index after the memory hits', async () => {
    const memory = stubMemory([
      { text: 'We use a token bucket', scope: 'project', day: '2026-06-10', score: 0.9 },
    ]);
    const searchCode = async () => ({
      results: [
        {
          path: 'src/limiter.ts',
          lineStart: 10,
          lineEnd: 20,
          kind: 'chunk',
          snippet: 'export function rateLimit()   { … }',
          score: 0.8,
          source: 'vector' as const,
        },
        {
          path: 'src/limiter.ts',
          lineStart: 40,
          lineEnd: 50,
          kind: 'chunk',
          snippet: 'duplicate path, dropped',
          score: 0.7,
          source: 'vector' as const,
        },
        {
          path: 'src/colors.ts',
          lineStart: 1,
          lineEnd: 2,
          kind: 'doc',
          snippet: 'below the score floor',
          score: 0.3,
          source: 'fts' as const,
        },
      ],
      engine: 'semantic' as const,
      truncated: false,
    });
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'rate limiting',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      contentIndex: { searchCode } as never,
    });
    expect(hits!.map((h) => h.scope)).toEqual(['project', 'workspace']);
    expect(hits![1]!.text).toContain('`src/limiter.ts:10`');
    expect(hits![1]!.text).toContain('rateLimit');
    expect(hits![1]!.text).not.toContain('  '); // snippet whitespace collapsed
  });

  it('keeps package and TypeScript config payloads out of prompt recall', async () => {
    const memory = stubMemory([]);
    const searchCode = async () => ({
      results: [
        {
          path: 'package.json',
          lineStart: 1,
          lineEnd: 4,
          kind: 'chunk',
          snippet: '{ "name": "default", "private": true }',
          score: 0.99,
          source: 'vector' as const,
        },
        {
          path: 'packages/app/tsconfig.json',
          lineStart: 1,
          lineEnd: 5,
          kind: 'chunk',
          snippet: '{ "compilerOptions": { "strict": true } }',
          score: 0.98,
          source: 'vector' as const,
        },
        {
          path: 'src/limiter.ts',
          lineStart: 10,
          lineEnd: 20,
          kind: 'chunk',
          snippet: 'export function rateLimit() { … }',
          score: 0.8,
          source: 'vector' as const,
        },
      ],
      engine: 'semantic' as const,
      truncated: false,
    });
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'rate limiting',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      contentIndex: { searchCode } as never,
    });

    expect(hits!.map((hit) => hit.text)).toEqual([
      '`src/limiter.ts:10` — export function rateLimit() { … }',
    ]);
  });

  it('memory hits still return when the code search throws', async () => {
    const memory = stubMemory([{ text: 'A fact', scope: 'gezel', day: '2026-06-10', score: 0.9 }]);
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'q',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      contentIndex: {
        searchCode: async () => {
          throw new Error('index locked');
        },
      } as never,
    });
    expect(hits!.map((h) => h.text)).toEqual(['A fact']);
  });
});

describe('status decay', () => {
  it('decayedScore halves-ish a status at one tau and leaves other kinds alone', () => {
    expect(decayedScore(0.8, 'status', 7)).toBeCloseTo(0.8 / Math.E, 10);
    expect(decayedScore(0.8, 'status', 0)).toBe(0.8);
    expect(decayedScore(0.8, 'fact', 30)).toBe(0.8);
    expect(decayedScore(0.8, 'pref', 30)).toBe(0.8);
    expect(decayedScore(0.8, undefined, 30)).toBe(0.8);
  });

  it('ageInDays counts whole UTC days and falls back to 0 on junk', () => {
    const now = new Date('2026-06-11T01:00:00Z');
    expect(ageInDays('2026-06-11', now)).toBe(0);
    expect(ageInDays('2026-06-10', now)).toBe(1);
    expect(ageInDays('2026-06-01', now)).toBe(10);
    expect(ageInDays('not-a-day', now)).toBe(0);
  });

  it('re-ranks: a fresh status outranks a stale higher-raw status', async () => {
    const now = new Date('2026-06-11T12:00:00Z');
    const memory = stubMemory([
      { text: 'stale', scope: 'project', day: '2026-06-01', score: 0.9, kind: 'status' },
      { text: 'fresh', scope: 'project', day: '2026-06-11', score: 0.6, kind: 'status' },
    ]);
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'q',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      now,
    });
    // stale: 0.9 * e^(-10/7) ≈ 0.215 → below minScore, dropped entirely.
    expect(hits!.map((h) => h.text)).toEqual(['fresh']);
  });

  it('does not decay durable kinds regardless of age', async () => {
    const now = new Date('2026-06-11T12:00:00Z');
    const memory = stubMemory([
      { text: 'old decision', scope: 'project', day: '2026-01-01', score: 0.5, kind: 'decision' },
      { text: 'old untagged', scope: 'project', day: '2026-01-01', score: 0.45 },
    ]);
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'q',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      now,
    });
    expect(hits!.map((h) => h.text)).toEqual(['old decision', 'old untagged']);
  });

  it('carries kind through to the returned hits', async () => {
    const memory = stubMemory([
      { text: 'a pref', scope: 'gezel', day: '2026-06-10', score: 0.8, kind: 'pref' },
    ]);
    const hits = await runAutoRecall({
      gezelId: 'ada',
      projectId: 'default',
      query: 'q',
      providerName: 'openai',
      config: {},
      memory,
      embedQuery: stubEmbed,
      now: new Date('2026-06-11T00:00:00Z'),
    });
    expect(hits![0]!.kind).toBe('pref');
  });
});

describe('renderRecallBlock', () => {
  it('returns empty string for no hits', () => {
    expect(renderRecallBlock([])).toBe('');
  });

  it('formats each hit with scope/day prefix', () => {
    const block = renderRecallBlock([
      { text: 'Used pgvector for embeddings', scope: 'project', day: '2026-04-10', score: 0.9 },
      { text: 'User prefers terse replies', scope: 'gezel', day: '2026-04-09', score: 0.85 },
    ]);
    expect(block).toContain('### Recalled from prior sessions');
    expect(block).toContain('- [project/2026-04-10] Used pgvector for embeddings');
    expect(block).toContain('- [gezel/2026-04-09] User prefers terse replies');
  });

  it('renders status hits with explicit temporality that self-refreshes with now', () => {
    const hits = [
      {
        text: 'The staging key is missing.',
        scope: 'project' as const,
        day: '2026-06-01',
        score: 0.7,
        kind: 'status' as const,
      },
    ];
    const at10 = renderRecallBlock(hits, new Date('2026-06-11T12:00:00Z'));
    expect(at10).toContain(
      '- [project/2026-06-01] As of 2026-06-01 (10 days ago): The staging key is missing.',
    );
    const at1 = renderRecallBlock(hits, new Date('2026-06-02T12:00:00Z'));
    expect(at1).toContain('(1 day ago):');
    const at0 = renderRecallBlock(hits, new Date('2026-06-01T12:00:00Z'));
    expect(at0).toContain('(today):');
  });

  it('renders workspace hits without a day stamp', () => {
    const block = renderRecallBlock([
      {
        text: '`src/limiter.ts:10` — export function rateLimit()',
        scope: 'workspace',
        day: '',
        score: 0.8,
      },
    ]);
    expect(block).toContain('- [workspace] `src/limiter.ts:10` — export function rateLimit()');
    expect(block).not.toContain('[workspace/]');
  });

  it('filters manifest and TypeScript config hits from frozen recall snapshots', () => {
    const block = renderRecallBlock([
      {
        text: '`package.json:1` — { "name": "default" }',
        scope: 'workspace',
        day: '',
        score: 0.99,
      },
      {
        text: '`packages/app/tsconfig.json:1` — { "compilerOptions": {} }',
        scope: 'workspace',
        day: '',
        score: 0.98,
      },
      {
        text: '`src/limiter.ts:10` — export function rateLimit()',
        scope: 'workspace',
        day: '',
        score: 0.8,
      },
    ]);

    expect(block).not.toContain('package.json');
    expect(block).not.toContain('tsconfig.json');
    expect(block).toContain('src/limiter.ts');
  });

  it('returns no recall block when a frozen config hit was the only result', () => {
    const block = renderRecallBlock([
      {
        text: '`package.json:1` — { "name": "default" }',
        scope: 'workspace',
        day: '',
        score: 0.99,
      },
    ]);

    expect(block).toBe('');
  });

  it('renders non-status kinds with the legacy line shape', () => {
    const block = renderRecallBlock(
      [
        {
          text: 'Chose Hono.',
          scope: 'project' as const,
          day: '2026-06-01',
          score: 0.7,
          kind: 'decision' as const,
        },
      ],
      new Date('2026-06-11T00:00:00Z'),
    );
    expect(block).toContain('- [project/2026-06-01] Chose Hono.');
    expect(block).not.toContain('As of');
  });
});

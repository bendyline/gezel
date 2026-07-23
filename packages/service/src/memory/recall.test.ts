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

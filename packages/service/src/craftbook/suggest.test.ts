import { EmbeddingsDisabledError } from '@bendyline/gezel-inference/internal/memory/embeddings';
import { describe, expect, it } from 'vitest';
import {
  type CraftbookCandidate,
  rankCraftbookSuggestions,
  usefulCraftbooksForSearch,
} from './suggest.js';

const cand = (
  id: string,
  name: string,
  description: string,
  extra: Partial<CraftbookCandidate> = {},
): CraftbookCandidate => ({ id, name, description, source: 'bundled', stepCount: 4, ...extra });

// Deterministic stand-in for the embedding model: three orthogonal axes
// (game / review / data) so cosine ordering is predictable. Returns
// L2-normalized vectors, matching the real `embed()` contract.
function fakeVec(text: string): number[] {
  const t = text.toLowerCase();
  const v = [
    /game|arcade|shooter|play/.test(t) ? 1 : 0,
    /review|pull request|\bpr\b|diff/.test(t) ? 1 : 0,
    /data|csv|transcribe|index|folder/.test(t) ? 1 : 0,
  ];
  const mag = Math.hypot(...v) || 1;
  return v.map((x) => x / mag);
}
const fakeEmbedder = {
  embed: async (t: string) => fakeVec(t),
  embedBatch: async (ts: string[]) => ts.map(fakeVec),
};
const disabledEmbedder = {
  embed: async () => {
    throw new EmbeddingsDisabledError('test');
  },
  embedBatch: async () => {
    throw new EmbeddingsDisabledError('test');
  },
};

const books = [
  cand('arcade-game', 'Arcade game', 'build a playable arcade game'),
  cand('pull-request-review', 'Pull Request Review', 'review a pull request diff', {
    tags: ['review'],
    triggers: ['review this pr'],
  }),
  cand('index-images', 'Index images', 'index and describe a folder of data'),
];

describe('rankCraftbookSuggestions', () => {
  // dev-craftbook-routing, 2026-10-30: the subject filled most of the message
  // and buried the one sentence that named the procedure.
  it('ranks a book by its best sentence when asked to score passages', async () => {
    const message =
      'Our nightly data export to csv files lost rows in the index folder again. ' +
      'Please get someone to review the pull request diff that caused it.';
    const semantic = (ranked: Awaited<ReturnType<typeof rankCraftbookSuggestions>>) =>
      ranked.find((r) => r.id === 'pull-request-review')?.semantic ?? 0;
    const whole = await rankCraftbookSuggestions(message, books, { embedder: fakeEmbedder });
    expect(semantic(whole)).toBeLessThan(0.75);
    const passages = await rankCraftbookSuggestions(message, books, {
      embedder: fakeEmbedder,
      passages: true,
    });
    expect(semantic(passages)).toBeGreaterThan(0.9);
    expect(passages.find((r) => r.id === 'arcade-game')).toBeUndefined();
  });

  it('scores a one-sentence query the same either way', async () => {
    const query = 'review the pull request diff for the arcade game';
    expect(
      await rankCraftbookSuggestions(query, books, { embedder: fakeEmbedder, passages: true }),
    ).toEqual(await rankCraftbookSuggestions(query, books, { embedder: fakeEmbedder }));
  });

  it('ranks by semantic similarity, surfacing a book that shares no words with the query', async () => {
    const res = await rankCraftbookSuggestions('make a space shooter', books, {
      embedder: fakeEmbedder,
    });
    expect(res[0]?.id).toBe('arcade-game');
    expect(res[0]?.semantic ?? 0).toBeGreaterThan(0.9);
    // Unrelated books score ~0 and fall below the minScore floor.
    expect(res.find((r) => r.id === 'pull-request-review')).toBeUndefined();
  });

  it('returns a top-K shortlist, not the full set', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      cand(`b${i}`, `Book ${i}`, 'build a playable arcade game'),
    );
    const res = await rankCraftbookSuggestions('arcade game', many, {
      embedder: fakeEmbedder,
      topK: 3,
    });
    expect(res).toHaveLength(3);
  });

  it('falls back to lexical ranking when embeddings are disabled', async () => {
    const res = await rankCraftbookSuggestions('review this pr', books, {
      embedder: disabledEmbedder,
    });
    expect(res[0]?.id).toBe('pull-request-review');
    expect(res[0]?.semantic).toBeUndefined();
    expect(res[0]?.lexical ?? 0).toBeGreaterThan(0);
  });

  it('returns nothing for an empty query or an empty candidate set', async () => {
    expect(await rankCraftbookSuggestions('', books, { embedder: fakeEmbedder })).toEqual([]);
    expect(await rankCraftbookSuggestions('anything', [], { embedder: fakeEmbedder })).toEqual([]);
  });

  it('ranks on words rather than wait out a loading embedder, and finishes the load', async () => {
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    let batched = 0;
    const loadingEmbedder = {
      embed: async (t: string) => {
        await loaded;
        return fakeVec(t);
      },
      embedBatch: async (ts: string[]) => {
        batched += ts.length;
        return ts.map(fakeVec);
      },
    };
    const res = await rankCraftbookSuggestions('review this pr', books, {
      embedder: loadingEmbedder,
      coldEmbedderBudgetMs: 20,
      embedderStatus: () => 'warming',
    });
    expect(res[0]?.id).toBe('pull-request-review');
    expect(res[0]?.semantic).toBeUndefined();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(batched).toBe(books.length);
  });

  it('waits for a ready embedder whatever the budget', async () => {
    const slowEmbedder = {
      embed: async (t: string) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return fakeVec(t);
      },
      embedBatch: async (ts: string[]) => ts.map(fakeVec),
    };
    const res = await rankCraftbookSuggestions('make a space shooter', books, {
      embedder: slowEmbedder,
      coldEmbedderBudgetMs: 5,
      embedderStatus: () => 'ready',
    });
    expect(res[0]?.id).toBe('arcade-game');
    expect(res[0]?.semantic).toBeDefined();
  });
});

describe('lexical-only mode (embeddings unavailable)', () => {
  const failingEmbedder = {
    embed: async (): Promise<number[]> => {
      throw new Error('no embeddings');
    },
    embedBatch: async (): Promise<number[][]> => {
      throw new Error('no embeddings');
    },
  };
  const catalogish = [
    {
      id: 'board-game-web',
      name: 'Board Game (Web)',
      description:
        'Build a complete browser board game in a single HTML file: grid board, two players, win detection, restart.',
      tags: ['game', 'html', 'board'],
      source: 'bundled' as const,
      version: '1.0.0',
      stepCount: 4,
    },
    {
      id: 'email-template',
      name: 'Email Template',
      description: 'Design a responsive marketing email template with sections and CTAs.',
      tags: ['email', 'marketing'],
      source: 'bundled' as const,
      version: '1.0.0',
      stepCount: 3,
    },
  ];

  it('returns a non-empty shortlist for an obvious build brief (the silent-empty regression)', async () => {
    // Wild-caught: the flat blended-scale floor (0.15) emptied
    // every embeddings-less shortlist — correct lexical top-1 matches
    // score ~0.10-0.25 — so the meester macros never pinned a craftbook
    // and every kickoff task shipped gate-less.
    const ranked = await rankCraftbookSuggestions(
      'Tic-Tac-Toe Game. Write the complete two-player tic-tac-toe game in index.html with win detection.',
      catalogish,
      { embedder: failingEmbedder },
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.id).toBe('board-game-web');
    expect(ranked[0]!.semantic).toBeUndefined();
  });

  it('still drops fully-irrelevant candidates in lexical mode', async () => {
    const ranked = await rankCraftbookSuggestions(
      'Tic-Tac-Toe Game. Write the complete two-player tic-tac-toe game in index.html with win detection.',
      [catalogish[1]!],
      { embedder: failingEmbedder },
    );
    expect(ranked).toEqual([]);
  });
});

describe('usefulCraftbooksForSearch', () => {
  it('keeps only strong semantic or lexical matches and caps omni-search noise', () => {
    const ranked = [
      {
        ...cand('semantic', 'Physics workflow', 'Improve vehicle dynamics'),
        // Above SEARCH_MIN_BLEND_SCORE (0.32, bge-calibrated) — qualifies.
        score: 0.36,
        semantic: 0.48,
        lexical: 0.02,
      },
      {
        ...cand('lexical', 'Vehicle physics', 'Tune driving physics'),
        score: 0.09,
        lexical: 0.09,
      },
      {
        ...cand('weak', 'Generic workflow', 'A merely best option'),
        score: 0.2,
        semantic: 0.25,
        lexical: 0.02,
      },
      {
        ...cand('third', 'Physics QA', 'Test vehicle dynamics'),
        score: 0.35,
        semantic: 0.45,
        lexical: 0.03,
      },
    ];

    expect(usefulCraftbooksForSearch(ranked).map((item) => item.id)).toEqual([
      'semantic',
      'lexical',
    ]);
  });
});

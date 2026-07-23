import { describe, expect, it } from 'vitest';
import { EmbeddingsDisabledError } from '../memory/embeddings.js';
import { type CraftbookCandidate, rankCraftbookSuggestions } from './suggest.js';

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

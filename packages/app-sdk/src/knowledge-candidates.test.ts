import { describe, expect, it } from 'vitest';
import { interleaveKnowledgeCandidates } from './knowledge-candidates.js';

const catalog = (n: number, text = `catalog ${n}`) => ({
  uri: `knowledge://pub/science/${n}`,
  title: `Doc ${n}`,
  text,
  catalogId: 'science',
  version: '1',
});
const candidate = (n: number, text = `note ${n}`) => ({
  uri: `knowledge://local/ws-1/notes/${n}.md#line=1-3`,
  title: `Note ${n}`,
  text,
});

describe('interleaving candidates', () => {
  it('takes turns, a catalog passage first, within the result limit', () => {
    const merged = interleaveKnowledgeCandidates(
      { reranked: true, passages: [catalog(1), catalog(2), catalog(3)] },
      [candidate(1), candidate(2), candidate(3)],
      { maxResults: 4, maxCharacters: 10_000 },
    );
    expect(merged.reranked).toBe(false);
    expect(merged.passages.map((passage) => passage.title)).toEqual([
      'Doc 1',
      'Note 1',
      'Doc 2',
      'Note 2',
    ]);
    expect(merged.passages[1]).toEqual({ ...candidate(1), catalogId: 'ws-1', version: 'local' });
  });

  it('shortens the passage that reaches the character budget and stops there', () => {
    const merged = interleaveKnowledgeCandidates(
      { reranked: false, passages: [catalog(1, 'x'.repeat(900))] },
      [candidate(1, 'y'.repeat(200)), candidate(2)],
      { maxResults: 4, maxCharacters: 1_000 },
    );
    expect(merged.passages.map((passage) => passage.text.length)).toEqual([900, 100]);
  });

  it('keeps a ranked result ranked when no candidate fits', () => {
    const merged = interleaveKnowledgeCandidates(
      { reranked: true, passages: [catalog(1)] },
      [candidate(1)],
      { maxResults: 1, maxCharacters: 1_000 },
    );
    expect(merged).toEqual({ reranked: true, passages: [catalog(1)] });
  });
});

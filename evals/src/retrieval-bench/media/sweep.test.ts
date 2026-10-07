import { describe, expect, it } from 'vitest';
import {
  type ScoredMediaQuery,
  bestRelevantRank,
  floorGrid,
  meanReciprocalRank,
  pickMediaFloor,
  recallAtK,
  sweepMediaFloor,
} from './sweep.ts';

const turtle: ScoredMediaQuery = {
  id: 'q1',
  modality: 'image',
  abstain: false,
  relevant: ['turtle'],
  scores: [
    { id: 'cat', cosine: 0.6 },
    { id: 'turtle', cosine: 0.74 },
    { id: 'dog', cosine: 0.76 },
  ],
};
const cats: ScoredMediaQuery = {
  id: 'q2',
  modality: 'image',
  abstain: false,
  relevant: ['cat'],
  scores: [
    { id: 'cat', cosine: 0.8 },
    { id: 'turtle', cosine: 0.5 },
    { id: 'dog', cosine: 0.55 },
  ],
};
const math: ScoredMediaQuery = {
  id: 'a1',
  modality: 'image',
  abstain: true,
  relevant: [],
  scores: [
    { id: 'cat', cosine: 0.52 },
    { id: 'turtle', cosine: 0.66 },
    { id: 'dog', cosine: 0.49 },
  ],
};

describe('media bench scoring', () => {
  it('ranks the best relevant item', () => {
    expect(bestRelevantRank(turtle)).toBe(2);
    expect(bestRelevantRank(cats)).toBe(1);
    expect(bestRelevantRank(math)).toBeNull();
  });

  it('computes recall and MRR over answerable queries only', () => {
    const all = [turtle, cats, math];
    expect(recallAtK(all, 1)).toBe(0.5);
    expect(recallAtK(all, 2)).toBe(1);
    expect(meanReciprocalRank(all)).toBeCloseTo(0.75);
  });

  it('replays what a floor admits on both sides', () => {
    const [low, mid, high] = sweepMediaFloor([turtle, cats, math], [0.6, 0.7, 0.78]);
    expect(low).toMatchObject({ answersCleared: 2, offTopicCleared: 1 });
    expect(low?.meanNoiseAbove).toBe(1);
    expect(mid).toMatchObject({ answersCleared: 2, offTopicCleared: 0, meanNoiseAbove: 0.5 });
    expect(high).toMatchObject({ answersCleared: 1, offTopicCleared: 0, meanNoiseAbove: 0 });
  });

  it('picks the lowest floor that keeps off-topic queries out', () => {
    const rows = sweepMediaFloor([turtle, cats, math], floorGrid(0.6, 0.8, 0.02));
    expect(pickMediaFloor(rows)).toBe(0.68);
    expect(pickMediaFloor(rows, 1)).toBe(0.6);
    expect(pickMediaFloor(sweepMediaFloor([math], [0.1]))).toBeNull();
  });
});

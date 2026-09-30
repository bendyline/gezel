import { describe, expect, it } from 'vitest';
import type { KnowledgeCalibrationQuery } from './queries.ts';
import { scoreInjection, sweepKnowledgeKeep, sweepVectorFloor } from './sweep.ts';

const CAT = 'pub/shelf';
const doc = (id: string) => `knowledge://${CAT}/${id}`;
const onTopic: KnowledgeCalibrationQuery = {
  id: 'f1',
  class: 'food',
  text: 'What is umami?',
  answers: [doc('umami')],
  related: [doc('glutamate')],
};
const offTopic: KnowledgeCalibrationQuery = {
  id: 'a1',
  class: 'abstain',
  text: 'What is 17 times 23?',
  answers: [],
  related: [],
};

describe('knowledge calibration sweeps', () => {
  const rows = [
    {
      query: onTopic,
      candidates: [
        { docKey: doc('umami'), similarity: 0.88, modelScore: 0.97 },
        { docKey: doc('glutamate'), similarity: 0.85, modelScore: 0.2 },
      ],
    },
    {
      query: offTopic,
      candidates: [{ docKey: doc('olive-oil-times'), similarity: 0.83, modelScore: 0.001 }],
    },
  ];

  it('replays what a cosine floor admits for one catalog', () => {
    const [low, mid, high] = sweepVectorFloor(rows, CAT, 'food', [0.8, 0.86, 0.9]);
    expect(low).toMatchObject({ offTopicCleared: 1, answered: 1, answersCleared: 1 });
    expect(mid).toMatchObject({ offTopicCleared: 0, answered: 1, answersCleared: 1 });
    expect(high).toMatchObject({ offTopicCleared: 0, answered: 0, answersCleared: 0 });
    expect(high?.answersWithSimilarity).toBe(1);
  });

  it('replays what a knowledge relevance bar admits under the model thresholds', () => {
    const thresholds = { drop: 0.00001, keep: 0.00003, strong: 0.95 };
    const [keep30, keep50] = sweepKnowledgeKeep(rows, thresholds, [0.3, 0.5]);
    expect(keep30).toMatchObject({ falseInjection: 1, answered: 1, answersKept: 1 });
    expect(keep50).toMatchObject({ falseInjection: 0, answered: 1, answersKept: 1 });
  });

  it('scores what per-turn injection kept', () => {
    const score = scoreInjection([
      { query: onTopic, kept: [doc('umami'), doc('glutamate')] },
      { query: offTopic, kept: [doc('olive-oil-times')] },
    ]);
    expect(score).toMatchObject({
      falseInjection: 1,
      abstain: 1,
      answered: 1,
      onTopic: 1,
      keptRelevant: 2,
      kept: 2,
    });
  });
});

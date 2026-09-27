import { describe, expect, it } from 'vitest';
import { holm, pairedEffect, pairsNeeded } from '../ab-stats.ts';
import { type TrialRecord, summarizeAb } from './ab-retrieval.ts';

function record(partial: Partial<TrialRecord>): TrialRecord {
  return {
    scenarioId: 'annotated-chat-policy',
    arm: 'control',
    replicate: 1,
    runDir: '/tmp/x',
    success: false,
    failureClass: 'model',
    durationMs: 60_000,
    proofOk: true,
    proofProblems: [],
    factScore: 0,
    deliverableFound: true,
    forbiddenHits: [],
    injectedTokens: 0,
    referenceItems: 0,
    ...partial,
  };
}

describe('summarizeAb', () => {
  it('pairs by scenario and replicate, and drops unproven and infra trials with their partner', () => {
    const records = [
      record({ replicate: 1, factScore: 0.5 }),
      record({ replicate: 1, arm: 'annotated', factScore: 1, success: true }),
      record({ replicate: 2, factScore: 0 }),
      record({ replicate: 2, arm: 'annotated', factScore: 1, proofOk: false }),
      record({ replicate: 3, factScore: 0.5, failureClass: 'infra' }),
      record({ replicate: 3, arm: 'annotated', factScore: 1 }),
    ];
    const summary = summarizeAb({
      model: 'm',
      provider: 'mlx',
      arms: ['control', 'annotated'],
      records: Object.fromEntries(records.map((r, i) => [String(i), r])),
    });
    expect(summary.scored).toBe(4);
    expect(summary.proofFailures).toBe(1);
    expect(summary.h1FactScore.n).toBe(1);
    expect(summary.h1FactScore.meanDelta).toBeCloseTo(0.5);
    expect(summary.passFlips).toEqual({ aOnly: 0, bOnly: 1 });
  });
});

describe('paired statistics', () => {
  it('reports a paired effect with a sign test', () => {
    const effect = pairedEffect([0.5, 0.25, 0, -0.25, 0.5], { iterations: 500 });
    expect(effect).toMatchObject({ n: 5, wins: 3, ties: 1, losses: 1 });
    expect(effect.meanDelta).toBeCloseTo(0.2);
    expect(effect.signTestP).toBeCloseTo(0.625);
  });

  it('adjusts p-values with Holm and sizes the futility check', () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(pairsNeeded(0.25, 0.2)).toBe(13);
  });
});

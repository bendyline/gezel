import type { RetrievalTraceCandidate } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { JudgedRow } from './metrics.ts';
import { chooseKeep, pairedDelta, replayKept, sweepSurface } from './sweep.ts';

function candidate(
  docKey: string,
  opts: Partial<RetrievalTraceCandidate> & { fusedRank: number },
): RetrievalTraceCandidate {
  return { id: docKey, docKey, kind: 'content', kept: false, reason: 'budget', ...opts };
}

function row(
  queryId: string,
  expect: 'answer' | 'abstain',
  labels: JudgedRow['labels'],
): JudgedRow {
  return {
    queryId,
    class: expect === 'answer' ? 'title' : 'absent',
    split: 'dev',
    surface: 'turn',
    expect,
    kept: [],
    labels,
    decoys: ['decoy'],
    reachableGrades: Object.values(labels),
    latencyMs: 1,
  };
}

describe('replayKept', () => {
  const candidates = [
    candidate('decoy', { fusedRank: 0, modelScore: 0.02, kept: true, reason: 'kept' }),
    candidate('answer', { fusedRank: 1, modelScore: 0.97, reason: 'grounding' }),
    candidate('related', { fusedRank: 2, modelScore: 0.4, reason: 'depth' }),
    candidate('elsewhere', { fusedRank: 3, modelScore: 0.99, reason: 'other-task' }),
    candidate('unscored', { fusedRank: 30, kept: true, reason: 'kept' }),
  ];

  it('keeps judged candidates on score alone, in score order, then the unjudged', () => {
    expect(replayKept(candidates, 0.3, { items: 5 })).toEqual(['answer', 'related', 'unscored']);
  });

  it('never revives a structural rejection, and honors the caps', () => {
    expect(replayKept(candidates, 0.01, { items: 2 })).toEqual(['answer', 'related']);
  });
});

describe('threshold sweep', () => {
  const rows = [
    row('q-answer', 'answer', { answer: 2, related: 1 }),
    row('q-absent', 'abstain', {}),
  ];
  const traces = [
    {
      queryId: 'q-answer',
      surface: 'turn' as const,
      trace: {
        surface: 'turn' as const,
        queryHash: 'h',
        counts: {},
        candidates: [
          candidate('answer', { fusedRank: 0, modelScore: 0.9, kept: true, reason: 'kept' }),
          candidate('related', { fusedRank: 1, modelScore: 0.3, kept: true, reason: 'kept' }),
          candidate('decoy', { fusedRank: 2, modelScore: 0.01, kept: true, reason: 'kept' }),
        ],
      },
    },
    {
      queryId: 'q-absent',
      surface: 'turn' as const,
      trace: {
        surface: 'turn' as const,
        queryHash: 'h',
        counts: {},
        candidates: [
          candidate('decoy', { fusedRank: 0, modelScore: 0.05, kept: true, reason: 'kept' }),
        ],
      },
    },
  ];

  it('finds the threshold that stops false injection without losing the answer', () => {
    const sweep = sweepSurface({
      surface: 'turn',
      split: 'dev',
      rows,
      traces,
      caps: { items: 5 },
      grid: [0.001, 0.1, 0.5],
    });
    expect(sweep.auc).toBe(1);
    expect(sweep.points.map((p) => p.falseInjectionStrict)).toEqual([1, 0, 0]);
    const chosen = chooseKeep(sweep, { strictRecall5: 1, setPrecision: 0.5 });
    expect(chosen?.threshold).toBe(0.1);
  });

  it('pairs arm and baseline rows by query for the delta', () => {
    const base = rows.map((r) => ({ ...r, kept: ['decoy'] }));
    const arm = rows.map((r) => ({ ...r, kept: r.expect === 'answer' ? ['answer'] : [] }));
    const delta = pairedDelta(base, arm, (r) => (r.kept.length > 0 ? 1 : 0), {
      iterations: 50,
    });
    expect(delta?.estimate).toBe(-0.5);
  });
});

import type { UnifiedSearchResult } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RetrievalTraceBuilder,
  retrievalTraceEnabled,
  traceHistoryDetails,
} from './retrieval-trace.js';

function result(id: string, extra: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    kind: 'content',
    id,
    title: id,
    snippet: `secret snippet text for ${id}`,
    retrievalSource: 'workspace',
    projectId: 'p1',
    path: `${id}.md`,
    score: 100,
    relevance: 0.5,
    ...extra,
  };
}

describe('RetrievalTraceBuilder', () => {
  afterEach(() => {
    delete process.env.GEZEL_RETRIEVAL_TRACE;
  });

  it('keeps each candidate’s first decision and closes out the rest', () => {
    const trace = new RetrievalTraceBuilder('turn', 'abc');
    const [a, b, c] = [result('a'), result('b'), result('c')];
    trace.addAll([a, b, c]);
    trace.reject(a, 'floor');
    trace.keep(a);
    trace.keep(b);
    trace.rejectRemaining('budget');
    const finished = trace.finish();
    expect(finished.candidates.map((row) => [row.id, row.kept, row.reason])).toEqual([
      ['a', false, 'floor'],
      ['b', true, 'kept'],
      ['c', false, 'budget'],
    ]);
    expect(finished.counts).toEqual({ floor: 1, kept: 1, budget: 1 });
    expect(finished.candidates[0]).toMatchObject({
      docKey: 'workspace:p1:a.md',
      fusedRank: 0,
      fusedRelevance: 0.5,
    });
  });

  it('writes counts always, per-candidate rows only when tracing is on, and never text', () => {
    const trace = new RetrievalTraceBuilder('turn', 'abc');
    trace.addAll([result('a'), result('b')]);
    trace.keep({ id: 'a' });
    trace.rejectRemaining('grounding');
    const finished = trace.finish();

    const brief = traceHistoryDetails(finished, false);
    expect(brief).toEqual({ surface: 'turn', rejected: { grounding: 1 } });

    const full = traceHistoryDetails(finished, true);
    expect(full.candidates).toHaveLength(2);
    expect(JSON.stringify(full)).not.toContain('secret snippet');

    expect(retrievalTraceEnabled({})).toBe(false);
    expect(retrievalTraceEnabled({ debugMode: true })).toBe(true);
    process.env.GEZEL_RETRIEVAL_TRACE = '1';
    expect(retrievalTraceEnabled(null)).toBe(true);
  });
});

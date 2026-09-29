import { EvalHarnessEventSchema, parseEvalHarnessEventLine } from '@bendyline/gezel/eval';
import { describe, expect, it } from 'vitest';
import { createEvalEventSink } from './eval-events.ts';

describe('createEvalEventSink', () => {
  it('writes one parseable line per event and numbers trials across the matrix', () => {
    const lines: string[] = [];
    const sink = createEvalEventSink((line) => lines.push(line));
    sink.setTotalTrials(2);
    const first = sink.nextTrialIndex();
    const second = sink.nextTrialIndex();
    sink.emit({
      type: 'trial-start',
      scenarioId: 'tictactoe',
      trialId: 't1',
      runDir: '/runs/t1',
      trialIndex: first,
      totalTrials: sink.totalTrials(),
      startedAt: '2026-09-29T00:00:00.000Z',
    });
    sink.emit({ type: 'matrix-end', status: 'complete', totalTrials: 2, totalSuccesses: 1 });
    expect([first, second]).toEqual([1, 2]);
    expect(lines).toHaveLength(2);
    const parsed = lines.map(parseEvalHarnessEventLine);
    expect(parsed[0]).toMatchObject({ type: 'trial-start', trialIndex: 1, totalTrials: 2 });
    for (const event of parsed) expect(EvalHarnessEventSchema.safeParse(event).success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { buildEvalMatrix, evalTargetKey, isNonModelFailure } from './results.js';
import { EvalJobSpecSchema, type EvalTrialSummary, parseEvalHarnessEventLine } from './schemas.js';

let seq = 0;
function trial(overrides: Partial<EvalTrialSummary>): EvalTrialSummary {
  seq += 1;
  return {
    trialId: `t-${seq}`,
    scenarioId: 'tictactoe',
    modelId: 'qwen3.5-4b-q4',
    provider: 'mlx',
    startedAt: `2026-09-29T10:${String(seq).padStart(2, '0')}:00.000Z`,
    running: false,
    success: true,
    runDir: `/runs/t-${seq}`,
    ...overrides,
  };
}

describe('buildEvalMatrix', () => {
  it('drops non-model failures from both sides of the fraction', () => {
    const matrix = buildEvalMatrix([
      trial({ success: true, failureClass: 'pass' }),
      trial({ success: false, failureClass: 'model' }),
      trial({ success: false, failureClass: 'infra' }),
      trial({ success: true, failureClass: 'pass' }),
    ]);
    const cell = matrix.cell('tictactoe', 'mlx:qwen3.5-4b-q4');
    expect(cell?.trials).toBe(4);
    expect(cell?.nonModelFailures).toBe(1);
    expect(cell?.claim).toBe('2/3 (67%)');
    const column = matrix.columns[0];
    expect(column?.attributableTrials).toBe(3);
    expect(column?.discardedTrials).toBe(1);
    expect(column?.passRate).toBeCloseTo(2 / 3);
  });

  it('refuses to quote a rate below three trials', () => {
    const matrix = buildEvalMatrix([trial({ success: true }), trial({ success: false })]);
    expect(matrix.cell('tictactoe', 'mlx:qwen3.5-4b-q4')?.claim).toBe('1/2 (n<3, count not rate)');
    expect(matrix.columns[0]?.passRate).toBeNull();
  });

  it('keeps running trials out of the counts', () => {
    const matrix = buildEvalMatrix([
      trial({ success: true }),
      trial({ running: true, success: undefined }),
    ]);
    const cell = matrix.cell('tictactoe', 'mlx:qwen3.5-4b-q4');
    expect(cell?.trials).toBe(1);
    expect(cell?.running).toBe(1);
  });

  it('ignores trials that stopped without a verdict', () => {
    const matrix = buildEvalMatrix([
      trial({ success: true }),
      trial({ running: false, success: undefined, reason: 'Stopped before it finished' }),
    ]);
    expect(matrix.cell('tictactoe', 'mlx:qwen3.5-4b-q4')).toMatchObject({ trials: 1, running: 0 });
  });

  it('separates the same model on different providers', () => {
    const matrix = buildEvalMatrix([trial({ provider: 'mlx' }), trial({ provider: 'llama-cpp' })]);
    expect(matrix.columns.map((c) => c.key)).toEqual([
      'llama-cpp:qwen3.5-4b-q4',
      'mlx:qwen3.5-4b-q4',
    ]);
  });

  it('keeps generalist-mode arms of the same model in separate columns', () => {
    const matrix = buildEvalMatrix([
      trial({ generalistMode: 'on' }),
      trial({ generalistMode: 'off', success: false, failureClass: 'model' }),
      trial({}),
    ]);
    expect(matrix.columns.map((c) => c.key)).toEqual([
      'mlx:qwen3.5-4b-q4',
      'mlx:qwen3.5-4b-q4:generalist-off',
      'mlx:qwen3.5-4b-q4:generalist-on',
    ]);
    expect(matrix.columns[2]?.generalistMode).toBe('on');
  });

  it('orders rows by the suite, then everything else alphabetically', () => {
    const matrix = buildEvalMatrix(
      [
        trial({ scenarioId: 'zeta' }),
        trial({ scenarioId: 'petshop' }),
        trial({ scenarioId: 'alpha' }),
        trial({ scenarioId: 'tictactoe' }),
      ],
      { scenarioOrder: ['tictactoe', 'petshop', 'not-run'] },
    );
    expect(matrix.scenarioIds).toEqual(['tictactoe', 'petshop', 'alpha', 'zeta']);
  });

  it('reports the median composite and the newest trial', () => {
    const matrix = buildEvalMatrix([
      trial({ composite: 4 }),
      trial({ composite: 9 }),
      trial({ composite: 7, trialId: 'newest' }),
    ]);
    const cell = matrix.cell('tictactoe', 'mlx:qwen3.5-4b-q4');
    expect(cell?.medianComposite).toBe(7);
    expect(cell?.latest?.trialId).toBe('newest');
  });
});

describe('eval helpers', () => {
  it('only treats infra, operator, and grader failures as non-model', () => {
    expect(isNonModelFailure({ success: false, failureClass: 'grader' })).toBe(true);
    expect(isNonModelFailure({ success: false, failureClass: 'model' })).toBe(false);
    expect(isNonModelFailure({ success: false })).toBe(false);
    expect(isNonModelFailure({ success: true, failureClass: 'infra' })).toBe(false);
  });

  it('keys targets by provider and model', () => {
    expect(evalTargetKey({ modelId: 'm' })).toBe('unknown:m');
  });

  it('parses progress lines and ignores ordinary log output', () => {
    expect(parseEvalHarnessEventLine('[matrix] === tictactoe (1/3) ===')).toBeNull();
    expect(parseEvalHarnessEventLine('[eval-event] {not json')).toBeNull();
    expect(parseEvalHarnessEventLine('[eval-event] {"type":"unknown"}')).toBeNull();
    expect(
      parseEvalHarnessEventLine(
        '[eval-event] {"type":"matrix-end","status":"complete","totalTrials":3,"totalSuccesses":2}',
      ),
    ).toEqual({ type: 'matrix-end', status: 'complete', totalTrials: 3, totalSuccesses: 2 });
  });

  it('requires a suite or a scenario list in a job spec', () => {
    const target = { provider: 'mlx', modelId: 'qwen3.5-4b-q4' };
    expect(EvalJobSpecSchema.safeParse({ count: 1, targets: [target] }).success).toBe(false);
    expect(
      EvalJobSpecSchema.safeParse({ count: 1, targets: [target], suiteId: 'smoke' }).success,
    ).toBe(true);
    expect(
      EvalJobSpecSchema.safeParse({ count: 1, targets: [target], scenarioIds: ['tictactoe'] })
        .success,
    ).toBe(true);
  });
});

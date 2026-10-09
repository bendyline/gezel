import { describe, expect, it } from 'vitest';
import {
  type TrialRow,
  regressionFlags,
  renderRegressionFlags,
  summarizeByScenario,
} from './regression-flags.ts';

const rows = (scenarioId: string, success: boolean[], minutes: number, input: number): TrialRow[] =>
  success.map((s) => ({
    scenarioId,
    success: s,
    durationMs: minutes * 60_000,
    inputTokens: input,
    outputTokens: 4_000,
  }));

describe('regressionFlags', () => {
  it('flags a scenario that got several times slower and costlier while still passing', () => {
    const baseline = summarizeByScenario([
      ...rows('conflict-synthesis', [true], 3.5, 20_000),
      ...rows('tictactoe', [true], 2, 10_000),
    ]);
    const current = summarizeByScenario([
      ...rows('conflict-synthesis', [true], 19, 300_000),
      ...rows('tictactoe', [true], 2.2, 11_000),
    ]);
    const flags = regressionFlags(current, baseline);
    expect(flags.map((f) => `${f.scenarioId}:${f.kind}`)).toEqual([
      'conflict-synthesis:duration',
      'conflict-synthesis:input-tokens',
    ]);
    expect(renderRegressionFlags(flags)).toContain('| conflict-synthesis | duration |');
  });

  it('ignores small absolute growth even at a high ratio', () => {
    const baseline = summarizeByScenario(rows('symptom-debug', [true], 0.5, 5_000));
    const current = summarizeByScenario(rows('symptom-debug', [true], 1.5, 12_000));
    expect(regressionFlags(current, baseline)).toEqual([]);
  });

  it('flags a pass-rate drop of half or more, and skips scenarios missing from the baseline', () => {
    const baseline = summarizeByScenario(rows('data-wrangle', [true, true, true], 3, 10_000));
    const current = summarizeByScenario([
      ...rows('data-wrangle', [false, false, true], 3, 10_000),
      ...rows('brand-new', [false], 3, 10_000),
    ]);
    const flags = regressionFlags(current, baseline);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ scenarioId: 'data-wrangle', kind: 'pass-rate' });
  });

  it('says so plainly when nothing regressed', () => {
    expect(renderRegressionFlags([])).toBe('No per-scenario regressions against the baseline.');
  });
});

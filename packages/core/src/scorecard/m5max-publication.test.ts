import { describe, expect, it } from 'vitest';
import { SCORECARD } from './index.js';

const id = '2026-10-27-m5max-native-0-1-54';
const results = SCORECARD.results.filter((result) => result.runId === id);

describe('published M5 Max dual-engine comparison', () => {
  it('keeps all 172 treatments and original exclusions across both engines', () => {
    expect(results).toHaveLength(16);
    expect(new Set(results.map((result) => result.label)).size).toBe(4);
    expect(
      results.every((result) =>
        result.label.endsWith(result.engine === 'mlx' ? 'MLX' : 'llama.cpp'),
      ),
    ).toBe(true);
    const cells = results.flatMap((result) => result.cells);
    expect(cells).toHaveLength(172);
    expect(cells.every((cell) => cell.trials === 3)).toBe(true);
    expect(cells.reduce((n, cell) => n + cell.successes, 0)).toBe(349);
    expect(cells.reduce((n, cell) => n + cell.nonModelFailures, 0)).toBe(2);
    const passes = new Map<string, number>();
    for (const result of results) {
      const key = `${result.modelId}/${result.engine}`;
      passes.set(
        key,
        (passes.get(key) ?? 0) + result.cells.reduce((n, cell) => n + cell.successes, 0),
      );
    }
    expect(Object.fromEntries(passes)).toEqual({
      'qwen3.8-27b-q4/mlx': 92,
      'qwen3.8-27b-q4/llama-cpp': 104,
      'gemma4-12b-q4/mlx': 67,
      'gemma4-12b-q4/llama-cpp': 86,
    });
  });

  it('accounts for every review while keeping incompatible rubrics unscored', () => {
    const groups = results.flatMap((result) => result.taskMeasurements ?? []);
    expect(groups.reduce((n, group) => n + group.trials, 0)).toBe(516);
    expect(
      groups.reduce(
        (n, group) => n + group.judgments.reduce((s, judge) => s + judge.artifacts, 0),
        0,
      ),
    ).toBe(215);
    expect(groups.reduce((n, group) => n + group.excludedReviews, 0)).toBe(12);
    expect(groups.reduce((n, group) => n + group.noArtifact, 0)).toBe(1);
    expect(groups.reduce((n, group) => n + (group.notApplicableReviews ?? 0), 0)).toBe(288);
    expect(
      groups.every((group) =>
        group.judgments.every((judge) => judge.rubricId !== 'craftbook-ab-test-readout'),
      ),
    ).toBe(true);
    expect(results.every((result) => !result.judge && !result.performance)).toBe(true);
  });

  it('retains telemetry coverage and never invents MLX prefill or GPU measurements', () => {
    const mlx = results.filter((result) => result.engine === 'mlx');
    const llama = results.filter((result) => result.engine === 'llama-cpp');
    expect(mlx.every((result) => !result.runtime)).toBe(true);
    expect(llama.every((result) => result.runtime?.kvCacheType === 'f16')).toBe(true);
    expect(mlx.every((result) => !result.taskMeasurements?.[0]?.prefillTokensPerSec)).toBe(true);
    expect(
      llama.reduce((n, result) => n + result.taskMeasurements![0]!.prefillTokensPerSec!.samples, 0),
    ).toBe(258);
    const groups = results.flatMap((result) => result.taskMeasurements ?? []);
    expect(groups.reduce((n, group) => n + (group.outputTokensPerSec?.samples ?? 0), 0)).toBe(514);
    expect(
      groups.every(
        (group) =>
          !group.peakGpuMemMb &&
          group.peakRssMb?.samples === group.trials &&
          group.durationMs?.samples === group.trials,
      ),
    ).toBe(true);
    const run = SCORECARD.runs.find((run) => run.id === id)!;
    expect(run.provenance.engineBuilds?.['llama-cpp']).toContain(
      '620d2225cc436ab0b001e3200e590e3b286ef9ab',
    );
    expect(run.provenance.engineBuilds?.mlx).toContain('MLX 0.32.2');
  });
});

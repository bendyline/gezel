import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scorecardCsvRows } from './csv.js';
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

  it('keeps recovered MLX observations separate from aggregate prefill and GPU measurements', () => {
    const mlx = results.filter((result) => result.engine === 'mlx');
    const llama = results.filter((result) => result.engine === 'llama-cpp');
    expect(mlx.every((result) => !result.runtime)).toBe(true);
    expect(llama.every((result) => result.runtime?.kvCacheType === 'f16')).toBe(true);
    expect(mlx.every((result) => !result.taskMeasurements?.[0]?.prefillTokensPerSec)).toBe(true);
    expect(
      mlx.reduce(
        (n, result) => n + result.taskMeasurements![0]!.observedPrefillTokensPerSec!.samples,
        0,
      ),
    ).toBe(258);
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

  it('publishes all recovered observations with hashes without changing raw metrics', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const assets = resolve(root, 'docs/handboek/assets/scorecards', id);
    const read = (name: string) => JSON.parse(readFileSync(resolve(assets, name), 'utf8'));
    const recovery = read('mlx-prefill-recovery.json');
    expect(recovery.campaignSha256).toBe(
      'a64051dadd9e07e96cee37afd4314febcfc8f43c069701ab0e3fa5cb1cc98dc1',
    );
    expect(recovery.coverage).toMatchObject({
      recordedMlxTrials: 258,
      recoveredMlxTrials: 258,
      observations: 2175,
      structuredObservations: 0,
      malformedLines: 0,
      exactDuplicates: 0,
      capabilityExcludedTrials: 1,
    });
    expect(
      recovery.groups
        .filter((group: { suite: string }) => group.suite === 'all')
        .map(
          (group: { observedPrefillTokensPerSec: { median: number } }) =>
            group.observedPrefillTokensPerSec.median,
        ),
    ).toEqual([547, 1084]);
    const performance = read('performance.json');
    for (const trial of performance.trials.filter(
      (trial: { cell: { provider: string } }) => trial.cell.provider === 'mlx',
    )) {
      expect(trial.metrics.derived.promptTokensPerSec).toBeNull();
      expect(trial.observedMlxPrefill.sampleCount).toBeGreaterThan(0);
    }
    expect(read('completion-audit.json').performanceCoverage.prefillThroughput.available).toBe(258);
    const csv = scorecardCsvRows(SCORECARD).filter(
      (row) => row.run_id === id && row.engine === 'mlx',
    );
    expect(csv).toHaveLength(8);
    expect(csv.every((row) => row.prefill_tok_s && row.perf_source.includes('partial'))).toBe(true);
    for (const file of read('manifest.json').files) {
      const content = readFileSync(resolve(root, file.path));
      expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(file.sha256);
      if (!file.path.endsWith('.md')) continue;
      for (const [, href] of content.toString().matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(https?:|#)/.test(href!)) continue;
        expect(existsSync(resolve(assets, href!)), `${file.path}: ${href}`).toBe(true);
      }
    }
    const report = readFileSync(resolve(assets, 'report.md'), 'utf8');
    expect(report).toContain('Recovered MLX observed prefill');
    expect(report).not.toContain('all MLX prefill rates are unknown');
    expect(readFileSync(resolve(assets, 'original-report.md'), 'utf8')).toContain(
      'all MLX prefill rates are unknown',
    );
  });
});

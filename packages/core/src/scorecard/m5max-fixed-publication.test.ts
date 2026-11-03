import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scorecardCsvRows } from './csv.js';
import { SCORECARD } from './index.js';
import { scoreModel } from './report.js';

const id = '2026-11-03-m5max-fixed-paired';
const results = SCORECARD.results.filter((result) => result.runId === id);
const run = SCORECARD.runs.find((run) => run.id === id)!;
const groups = results.flatMap((result) => result.taskMeasurements ?? []);

describe('published condensed M5 Max comparison', () => {
  it('retains the matched scope, raw failures and one-repetition caveat', () => {
    expect(run.scope).toBe('subset');
    expect(run.provenance.count).toBe(1);
    expect(run.suites).toEqual(['core', 'productivity']);
    expect(results).toHaveLength(8);
    const cells = results.flatMap((result) => result.cells);
    expect(cells).toHaveLength(72);
    expect(cells.every((cell) => cell.trials === 1 && cell.nonModelFailures === 0)).toBe(true);
    expect(cells.reduce((n, cell) => n + cell.successes, 0)).toBe(68);
    expect(results.every((result) => scoreModel(result, 1).passRate === null)).toBe(true);
    expect(run.note).toContain('equivalence within ±5 percentage points is not established');
  });

  it('keeps partial MLX prefill separate from aggregate rates and admission probes', () => {
    const mlx = results.filter((result) => result.engine === 'mlx');
    const llama = results.filter((result) => result.engine === 'llama-cpp');
    expect(
      mlx.every((result) => !result.runtime && !result.taskMeasurements![0]!.prefillTokensPerSec),
    ).toBe(true);
    expect(
      mlx.reduce(
        (n, result) => n + result.taskMeasurements![0]!.observedPrefillTokensPerSec!.samples,
        0,
      ),
    ).toBe(36);
    expect(
      llama.every(
        (result) =>
          result.runtime?.contextTokens === 262144 && result.runtime.kvCacheType === 'f16',
      ),
    ).toBe(true);
    expect(
      llama.reduce((n, result) => n + result.taskMeasurements![0]!.prefillTokensPerSec!.samples, 0),
    ).toBe(36);
    expect(groups.reduce((n, group) => n + (group.outputTokensPerSec?.samples ?? 0), 0)).toBe(71);
    expect(
      groups.every((group) => !group.peakGpuMemMb && group.peakRssMb?.samples === group.trials),
    ).toBe(true);
    expect(results.every((result) => !result.performance)).toBe(true);
    const csv = scorecardCsvRows({ schemaVersion: 1, runs: [run], results });
    expect(
      csv
        .filter((row) => row.engine === 'mlx')
        .map((row) => row.prefill_tok_s)
        .sort(),
    ).toEqual(['1222.0', '1341.5', '574.0', '743.0']);
    expect(
      csv.filter((row) => row.engine === 'mlx').every((row) => row.perf_source.includes('partial')),
    ).toBe(true);
  });

  it('accounts for reviews and retains the excluded passing trial in the downloads', () => {
    expect(
      groups.reduce(
        (n, group) => n + group.judgments.reduce((s, judge) => s + judge.artifacts, 0),
        0,
      ),
    ).toBe(24);
    expect(groups.reduce((n, group) => n + (group.notApplicableReviews ?? 0), 0)).toBe(48);
    const details = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../docs/handboek/assets/scorecards',
          id,
          'scorecard-details.json',
        ),
        'utf8',
      ),
    );
    expect(details.trials).toHaveLength(73);
    const excluded = details.trials.filter(
      (trial: { comparisonIncluded: boolean }) => !trial.comparisonIncluded,
    );
    expect(excluded).toHaveLength(1);
    expect(excluded[0].result.success).toBe(true);
    expect(excluded[0].comparisonIssue).toContain('Frozen comparison changed');
    expect(excluded[0].review.status).toBe('judged');
    expect(details.counts.numericReviews).toBe(25);
  });

  it('ships matching download data, verified asset hashes and working report links', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const assets = resolve(root, 'docs/handboek/assets/scorecards', id);
    const read = (name: string) => JSON.parse(readFileSync(resolve(assets, name), 'utf8'));
    const published = read('scorecard.json');
    expect(published.schemaVersion).toBe(1);
    expect(published.runs).toEqual([run]);
    // The shared dataset sorts model rows; downloads retain campaign target order.
    expect(published.results).toHaveLength(results.length);
    expect(published.results).toEqual(expect.arrayContaining(results));
    for (const file of read('manifest.json').files) {
      const content = readFileSync(resolve(root, file.path));
      expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(file.sha256);
      expect(content.byteLength).toBe(file.bytes);
      if (!file.path.endsWith('.md')) continue;
      for (const [, link] of content.toString().matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(https?:|#)/.test(link!)) continue;
        expect(existsSync(resolve(assets, link!)), `${file.path}: ${link}`).toBe(true);
      }
    }
    const recovered = read('mlx-prefill-recovery.json');
    expect(recovered.coverage.observations).toBe(126);
    expect(recovered.coverage.includedMlxTrials).toBe(36);
  });
});

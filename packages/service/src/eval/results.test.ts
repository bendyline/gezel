import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalResultsIndex, INTERRUPTED_REASON } from './results.js';

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('EvalResultsIndex', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'gezel-eval-results-'));
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  function finishedTrial(dir: string, overrides: Record<string, unknown> = {}): void {
    write(join(dir, 'result.json'), {
      trialId: overrides.trialId ?? 'tictactoe-mlx-a',
      scenarioId: 'tictactoe',
      modelId: 'qwen3.5-4b-q4',
      engine: 'mlx',
      startedAt: '2026-09-29T10:00:00.000Z',
      finishedAt: '2026-09-29T10:12:00.000Z',
      durationMs: 720_000,
      success: false,
      reason: 'hard ceiling',
      failureMode: 'timeout',
      failureClass: 'model',
      failureClassEvidence: 'no winner detected',
      modelTier: 'small',
      ...overrides,
    });
  }

  it('indexes in-app job trials and legacy flat runs, newest first, with scores and speed', async () => {
    const jobTrial = join(runsDir, 'jobs', 'job-1', '01-mlx-q', 'tictactoe', 'tictactoe-mlx-a');
    finishedTrial(jobTrial);
    write(join(jobTrial, 'score.json'), {
      composite: 4.2,
      band: 'framework-gap',
      eligibility: { includedInModelAggregate: true },
      axes: {
        completion: { score: 3, summary: 'timed out' },
        quality: { score: 5, summary: 'half the gate' },
        efficiency: { score: 5, summary: 'moderate' },
        behavior: { score: 10, summary: 'clean' },
      },
    });
    write(join(jobTrial, 'metrics.json'), { derived: { genTokensPerSec: 31.4 } });
    const legacy = join(runsDir, 'petshop-old');
    write(join(legacy, 'result.json'), {
      trialId: 'petshop-old',
      scenarioId: 'petshop',
      modelId: 'gemma4-e4b-q4',
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T00:10:00.000Z',
      durationMs: 600_000,
      success: true,
      reason: 'ok',
    });
    // The preflight probe cache is never a result.
    finishedTrial(join(runsDir, '.preflight', 'probe'), { trialId: 'probe' });

    const index = new EvalResultsIndex(runsDir);
    const trials = (await index.list()).map((entry) => entry.summary);
    expect(trials.map((t) => t.trialId)).toEqual(['tictactoe-mlx-a', 'petshop-old']);
    expect(trials[0]).toMatchObject({
      jobId: 'job-1',
      provider: 'mlx',
      success: false,
      failureClass: 'model',
      composite: 4.2,
      band: 'framework-gap',
      decodeTokensPerSec: 31.4,
      running: false,
    });
    expect(trials[1]?.jobId).toBeUndefined();
  });

  it('reports a started trial as running only while a live job owns it', async () => {
    const dir = join(runsDir, 'jobs', 'job-2', '01', 'tictactoe', 't-live');
    write(join(dir, 'status.json'), {
      trialId: 't-live',
      scenarioId: 'tictactoe',
      modelId: 'm',
      engine: 'mlx',
      startedAt: '2026-09-29T11:00:00.000Z',
      status: 'running',
    });
    let live = new Set(['t-live']);
    const index = new EvalResultsIndex(runsDir, () => live);
    expect((await index.list())[0]?.summary).toMatchObject({ running: true });
    live = new Set();
    const stopped = (await index.list())[0]?.summary;
    expect(stopped).toMatchObject({ running: false, reason: INTERRUPTED_REASON });
    expect(stopped?.success).toBeUndefined();
  });

  it('picks up a result written after the first read', async () => {
    const dir = join(runsDir, 'jobs', 'job-3', '01', 'tictactoe', 't-3');
    finishedTrial(dir, { trialId: 't-3', success: false });
    const index = new EvalResultsIndex(runsDir);
    expect((await index.list())[0]?.summary.success).toBe(false);
    // A fresh mtime is what the cache keys on.
    await new Promise((r) => setTimeout(r, 20));
    finishedTrial(dir, { trialId: 't-3', success: true, reason: 'retried' });
    expect((await index.list())[0]?.summary).toMatchObject({ success: true, reason: 'retried' });
  });

  it('assembles a trial detail from the files the harness wrote', async () => {
    const dir = join(runsDir, 'jobs', 'job-4', '01', 'tictactoe', 't-4');
    finishedTrial(dir, { trialId: 't-4' });
    write(join(dir, 'score.json'), {
      composite: 6,
      band: 'needs-tuning',
      eligibility: { includedInModelAggregate: false },
      axes: {
        completion: { score: 6, summary: 'gate failed late' },
        quality: { score: 7, summary: 'mostly there' },
        efficiency: { score: 5, summary: 'ok' },
        behavior: { score: 7.5, summary: 'two nudges' },
      },
    });
    write(join(dir, 'postmortem.md'), '# Postmortem\n\nComposite 6.0');
    write(join(dir, 'log.txt'), Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n'));
    write(join(dir, 'artifacts', 'p1', 'index.html'), '<html></html>');
    write(join(dir, 'workspace', 'p1', 'node_modules', 'x', 'big.js'), 'skipped');

    const detail = await new EvalResultsIndex(runsDir).detail('t-4');
    expect(detail?.rubric).toMatchObject({
      completion: { score: 6, summary: 'gate failed late' },
      includedInModelAggregate: false,
    });
    expect(detail?.failureClassEvidence).toBe('no winner detected');
    expect(detail?.postmortemMarkdown).toContain('Composite 6.0');
    expect(detail?.logTail).toHaveLength(200);
    expect(detail?.logTail.at(-1)).toBe('line 249');
    expect(detail?.artifacts).toEqual([{ path: join('artifacts', 'p1', 'index.html'), bytes: 13 }]);
    expect(await new EvalResultsIndex(runsDir).detail('missing')).toBeNull();
  });
});

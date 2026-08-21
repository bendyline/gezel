import { describe, expect, it } from 'vitest';
import {
  REVIEW_BUDGET,
  SUMMARIZE_BUDGET,
  enrichTimeoutMs,
  resolveEnrichThroughput,
} from './enrich-budget.js';

/** A minimally-valid fitness record; callers override the rate fields. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: 'mlx',
    modelId: 'qwen3.8-27b-q4',
    status: 'probed',
    admitted: true,
    genTokensPerSec: 13.6,
    createdAt: '2026-08-01T00:00:00.000Z',
    durationMs: 1000,
    trigger: 'install',
    host: { totalRamBytes: 128e9, gpuVramBytes: null, source: 'sysctl' },
    checks: {
      spawn: { ok: true, detail: '' },
      toolRoundTrip: { ok: true, detail: '' },
      throughput: { ok: true, detail: '' },
      reasoningBudget: { ok: true, detail: '' },
      contextFit: { ok: true, detail: '' },
    },
    ...over,
  };
}

describe('resolveEnrichThroughput', () => {
  it('falls back to the pessimistic floors with no fitness record at all', () => {
    const t = resolveEnrichThroughput({}, 'ds4', 'deepseek-v4-flash-284b-q4');
    expect(t.measured).toBe(false);
    expect(t.genTokensPerSec).toBe(3);
  });

  // The case that motivated the whole module: the biggest model on the
  // machine is exactly the one whose probe gets deferred for capacity, so
  // it has a record and no numbers in it.
  it('falls back to the floors for a deferred probe (record present, rates null)', () => {
    const config = {
      modelFitness: {
        'ds4:deepseek-v4-flash-284b-q4': record({
          provider: 'ds4',
          modelId: 'deepseek-v4-flash-284b-q4',
          status: 'deferred',
          admitted: false,
          genTokensPerSec: null,
        }),
      },
    };
    const t = resolveEnrichThroughput(config, 'ds4', 'deepseek-v4-flash-284b-q4');
    expect(t.measured).toBe(false);
    expect(t.genTokensPerSec).toBe(3);
  });

  it('uses the representative-context rates when the probe recorded them', () => {
    const config = {
      modelFitness: {
        'mlx:qwen3.8-27b-q4': record({
          genTokensPerSec: 13.6,
          representativeContext: {
            targetPromptTokens: 20_000,
            promptTokens: 19_500,
            cachedPromptTokens: 0,
            completionTokens: 200,
            durationMs: 40_000,
            ttftMs: 39_875,
            promptTokensPerSec: 497.9,
            genTokensPerSec: 13.6,
          },
        }),
      },
    };
    const t = resolveEnrichThroughput(config, 'mlx', 'qwen3.8-27b-q4');
    expect(t).toEqual({ promptTokensPerSec: 497.9, genTokensPerSec: 13.6, measured: true });
  });

  it('keeps a decode-only record and stands the prefill floor in', () => {
    const config = { modelFitness: { 'mlx:qwen3.8-27b-q4': record() } };
    const t = resolveEnrichThroughput(config, 'mlx', 'qwen3.8-27b-q4');
    expect(t.genTokensPerSec).toBe(13.6);
    expect(t.promptTokensPerSec).toBe(25);
    expect(t.measured).toBe(true);
  });

  it('ignores a malformed record rather than throwing', () => {
    const config = { modelFitness: { 'mlx:x': { schemaVersion: 9, nonsense: true } } };
    expect(resolveEnrichThroughput(config, 'mlx', 'x').measured).toBe(false);
  });
});

describe('enrichTimeoutMs', () => {
  const fast = { promptTokensPerSec: 497.9, genTokensPerSec: 13.6, measured: true };
  const slow = { promptTokensPerSec: 25, genTokensPerSec: 3, measured: false };

  it('keeps an ordinary local model close to the historical wall', () => {
    // A 27B dense model at 13.6 tok/s earns a modest raise over the old flat
    // 120s — not the multiple a big MoE needs. Nothing shortens.
    const ms = enrichTimeoutMs(6000, fast, SUMMARIZE_BUDGET);
    expect(ms).toBeGreaterThanOrEqual(SUMMARIZE_BUDGET.floorMs);
    expect(ms).toBeLessThan(180_000);
  });

  // 120s against ~28 tok/s prefill and ~3 tok/s decode is arithmetically
  // unreachable for a full-size file — the timeout the sweep hit every time.
  it('gives a ds4-class target minutes, not the 120s wall', () => {
    const ms = enrichTimeoutMs(6000, slow, SUMMARIZE_BUDGET);
    expect(ms).toBeGreaterThan(300_000);
    expect(ms).toBeLessThanOrEqual(SUMMARIZE_BUDGET.ceilingMs);
  });

  it('scales with the prompt — a short file gets a shorter deadline', () => {
    expect(enrichTimeoutMs(500, slow, SUMMARIZE_BUDGET)).toBeLessThan(
      enrichTimeoutMs(6000, slow, SUMMARIZE_BUDGET),
    );
  });

  it('never exceeds the ceiling, however slow the estimate says the model is', () => {
    const glacial = { promptTokensPerSec: 0.5, genTokensPerSec: 0.1, measured: true };
    expect(enrichTimeoutMs(6000, glacial, REVIEW_BUDGET)).toBe(REVIEW_BUDGET.ceilingMs);
  });

  it('never drops below the floor, however fast', () => {
    const blazing = { promptTokensPerSec: 5000, genTokensPerSec: 500, measured: true };
    expect(enrichTimeoutMs(0, blazing, REVIEW_BUDGET)).toBe(REVIEW_BUDGET.floorMs);
  });

  it('budgets reviews above summaries for the same target and prompt', () => {
    expect(enrichTimeoutMs(6000, slow, REVIEW_BUDGET)).toBeGreaterThan(
      enrichTimeoutMs(6000, slow, SUMMARIZE_BUDGET),
    );
  });
});

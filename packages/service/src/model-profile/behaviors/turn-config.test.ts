/**
 * Tests for the parameterized turn-budget / num-predict behaviors.
 * Validates that the config-bearing flow works end-to-end: schema
 * accepts valid configs, rejects invalid ones, defaults apply when
 * the manifest opts in without a `config`, and the hooks return the
 * configured numbers.
 */

import type { ProviderName } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { ModelCtx } from '../types.js';
import { TurnContinuationBudget } from './turn-continuation-budget.js';
import { TurnOllamaNumPredictBumped } from './turn-ollama-num-predict-bumped.js';

function modelCtx(overrides: Partial<ModelCtx>): ModelCtx {
  return {
    catalogId: 'qwen3.5-9b',
    tier: 'small',
    family: 'qwen',
    modelId: 'qwen3.5-9b',
    providerName: 'ollama' satisfies ProviderName,
    ...overrides,
  };
}

describe('TurnContinuationBudget', () => {
  it('returns the configured count from the hook', () => {
    const out = TurnContinuationBudget.continuationBudget!(modelCtx({}), { count: 4 });
    expect(out).toBe(4);
  });

  it('parses a valid config via configSchema', () => {
    const parsed = TurnContinuationBudget.configSchema!.safeParse({ count: 4 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.count).toBe(4);
  });

  it('rejects a count outside the [0, 10] range', () => {
    expect(TurnContinuationBudget.configSchema!.safeParse({ count: 50 }).success).toBe(false);
    expect(TurnContinuationBudget.configSchema!.safeParse({ count: -1 }).success).toBe(false);
  });

  it('rejects a non-integer count', () => {
    expect(TurnContinuationBudget.configSchema!.safeParse({ count: 2.5 }).success).toBe(false);
  });

  it('exposes a defaultConfig of count: 2 (matches legacy non-tiny behavior)', () => {
    expect(TurnContinuationBudget.defaultConfig).toEqual({ count: 2 });
  });
});

describe('TurnOllamaNumPredictBumped', () => {
  it('returns the configured numPredict from the hook', () => {
    const out = TurnOllamaNumPredictBumped.numPredict!(modelCtx({}), { numPredict: 24576 });
    expect(out).toBe(24576);
  });

  it('parses a valid config', () => {
    const parsed = TurnOllamaNumPredictBumped.configSchema!.safeParse({ numPredict: 16384 });
    expect(parsed.success).toBe(true);
  });

  it('rejects a numPredict outside [256, 131072]', () => {
    expect(TurnOllamaNumPredictBumped.configSchema!.safeParse({ numPredict: 100 }).success).toBe(
      false,
    );
    expect(TurnOllamaNumPredictBumped.configSchema!.safeParse({ numPredict: 200000 }).success).toBe(
      false,
    );
  });

  it('exposes a defaultConfig matching legacy verbose-family value (16384)', () => {
    expect(TurnOllamaNumPredictBumped.defaultConfig).toEqual({ numPredict: 16384 });
  });
});

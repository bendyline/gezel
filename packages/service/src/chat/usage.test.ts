import { describe, expect, it } from 'vitest';
import type { TurnUsage } from '../providers/types.js';
import { UsageTracker, medianOf } from './usage.js';

const turn = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  model: 'test-model',
  inputTokens: 100,
  outputTokens: 50,
  durationMs: 1000,
  at: new Date().toISOString(),
  ...over,
});

describe('medianOf', () => {
  it('returns null for an empty list so "unmeasured" stays distinct from zero', () => {
    expect(medianOf([])).toBeNull();
  });

  it('takes the middle value for odd counts and the mean of the middle two for even', () => {
    expect(medianOf([10, 30, 20])).toBe(20);
    expect(medianOf([10, 20, 30, 40])).toBe(25);
  });

  it('rounds to one decimal', () => {
    expect(medianOf([21.17, 21.34, 21.29])).toBe(21.3);
  });
});

describe('UsageTracker decode-rate aggregation', () => {
  it('reports null when no turn carried a rate (the cloud-provider case)', () => {
    const t = new UsageTracker();
    t.recordTurn('openai', turn());
    expect(t.summary().providers.openai?.medianOutputTokensPerSec).toBeNull();
  });

  // Median, not mean: a cold first turn on a big local model reads far below
  // steady state and would drag a mean down.
  it('medians the engine-reported rates across turns', () => {
    const t = new UsageTracker();
    t.recordTurn('mlx', turn({ outputTokensPerSec: 8 }));
    t.recordTurn('mlx', turn({ outputTokensPerSec: 85 }));
    t.recordTurn('mlx', turn({ outputTokensPerSec: 79 }));
    expect(t.summary().providers.mlx?.medianOutputTokensPerSec).toBe(79);
  });

  it('ignores turns with no rate rather than counting them as zero', () => {
    const t = new UsageTracker();
    t.recordTurn('llama-cpp', turn({ outputTokensPerSec: 20 }));
    t.recordTurn('llama-cpp', turn());
    t.recordTurn('llama-cpp', turn({ outputTokensPerSec: 22 }));
    expect(t.summary().providers['llama-cpp']?.medianOutputTokensPerSec).toBe(21);
  });

  it('keeps token totals independent of the rate field', () => {
    const t = new UsageTracker();
    t.recordTurn('mlx', turn({ inputTokens: 50_500, outputTokens: 158 }));
    const p = t.summary().providers.mlx;
    expect(p?.totalTokensIn).toBe(50_500);
    expect(p?.totalTokensOut).toBe(158);
  });
});

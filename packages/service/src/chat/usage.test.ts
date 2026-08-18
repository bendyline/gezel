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

  it('retains the most recently completed turn independently of rolling UI state', () => {
    const t = new UsageTracker();
    t.recordTurn(
      'mlx',
      turn({
        model: 'qwen-27b',
        inputTokens: 12_345,
        cachedInputTokens: 12_000,
        outputTokens: 87,
        outputTokensPerSec: 24.5,
        durationMs: 4_200,
        at: '2026-08-18T10:00:00.000Z',
      }),
    );

    expect(t.summary().providers.mlx?.lastTurn).toEqual({
      model: 'qwen-27b',
      inputTokens: 12_345,
      cachedInputTokens: 12_000,
      outputTokens: 87,
      cost: 0,
      durationMs: 4_200,
      outputTokensPerSec: 24.5,
      at: '2026-08-18T10:00:00.000Z',
    });
  });
});

/**
 * The per-model split answers "how fast is this model on my machine", which a
 * single provider-wide figure cannot: blending a 27B and a 4B describes
 * neither. It also has to outlive a page reload, which is why it is computed
 * here rather than tallied in the engine pill.
 */
describe('UsageTracker per-model speeds', () => {
  it('never blends two models into one figure', () => {
    const t = new UsageTracker();
    t.recordTurn(
      'llama-cpp',
      turn({ model: 'qwen-27b', outputTokens: 300, outputTokensPerSec: 30 }),
    );
    t.recordTurn(
      'llama-cpp',
      turn({ model: 'gemma-4b', outputTokens: 90, outputTokensPerSec: 90 }),
    );
    const rows = t.summary().providers['llama-cpp']?.modelSpeeds ?? [];
    expect(rows.map((r) => r.model)).toEqual(['qwen-27b', 'gemma-4b']);
    expect(rows[0]!.medianOutputTokensPerSec).toBe(30);
    expect(rows[1]!.medianOutputTokensPerSec).toBe(90);
  });

  it('medians each model rather than letting a cold first turn set the figure', () => {
    const t = new UsageTracker();
    for (const rate of [7, 34, 36, 35]) {
      t.recordTurn('mlx', turn({ model: 'qwen-27b', outputTokensPerSec: rate }));
    }
    const rows = t.summary().providers.mlx?.modelSpeeds ?? [];
    expect(rows[0]!.medianOutputTokensPerSec).toBe(34.5);
    expect(rows[0]!.turns).toBe(4);
  });

  it('ranks by generation seconds, so the model doing the work leads', () => {
    // The 4B racked up three quick turns; the 27B owned the machine.
    const t = new UsageTracker();
    t.recordTurn('llama-cpp', turn({ model: 'big', outputTokens: 600, outputTokensPerSec: 20 }));
    for (let i = 0; i < 3; i++) {
      t.recordTurn('llama-cpp', turn({ model: 'small', outputTokens: 90, outputTokensPerSec: 90 }));
    }
    const rows = t.summary().providers['llama-cpp']?.modelSpeeds ?? [];
    expect(rows[0]!.model).toBe('big');
    expect(rows[1]!.turns).toBe(3);
  });

  it('omits turns with no rate rather than counting them as zero', () => {
    const t = new UsageTracker();
    t.recordTurn('llama-cpp', turn({ model: 'qwen-27b' }));
    expect(t.summary().providers['llama-cpp']?.modelSpeeds).toEqual([]);
  });
});

describe('UsageTracker standalone quota snapshots', () => {
  it('surfaces quota windows without inventing a chat turn', () => {
    const t = new UsageTracker();
    const at = '2026-08-07T12:00:00.000Z';
    t.recordQuotaBuckets(
      'codex-cli',
      [
        {
          name: 'five_hour',
          isUnlimited: false,
          limit: 100,
          used: 42,
          remaining: 58,
          remainingPercent: 58,
          overage: 0,
          resetDate: '2026-08-07T15:00:00.000Z',
        },
      ],
      at,
    );

    expect(t.summary()).toMatchObject({
      lastUpdated: at,
      providers: {
        'codex-cli': {
          quotaBuckets: [{ name: 'five_hour', used: 42 }],
          todayTurns: 0,
          totalTurns: 0,
          lastTurn: null,
          lastUpdated: at,
        },
      },
    });
  });

  it('keeps the later of the quota and turn timestamps', () => {
    const t = new UsageTracker();
    t.recordQuotaBuckets(
      'anthropic-cli',
      [
        {
          name: 'seven_day',
          isUnlimited: false,
          limit: 100,
          used: 10,
          remaining: 90,
          remainingPercent: 90,
          overage: 0,
        },
      ],
      '2026-08-07T13:00:00.000Z',
    );
    t.recordTurn('anthropic-cli', turn({ at: '2026-08-07T12:00:00.000Z' }));

    expect(t.summary().providers['anthropic-cli']?.lastUpdated).toBe('2026-08-07T13:00:00.000Z');
  });

  it('clears a stale quota when a later authoritative snapshot is empty', () => {
    const t = new UsageTracker();
    t.recordQuotaBuckets('codex-cli', [
      {
        name: 'five_hour',
        isUnlimited: false,
        limit: 100,
        used: 10,
        remaining: 90,
        remainingPercent: 90,
        overage: 0,
      },
    ]);
    t.recordQuotaBuckets('codex-cli', []);
    expect(t.summary().providers['codex-cli']?.quotaBuckets).toEqual([]);
  });
});

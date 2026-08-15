import type { GezelConfig } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { type QuotaBucket, UsageTracker } from '../chat/usage.js';
import {
  NightShiftQuotaGate,
  type QuotaReserveConfig,
  evaluateQuotaReserve,
  quotaReserveEnabled,
} from './night-quota-gate.js';

const NOW = new Date('2026-08-15T02:00:00.000Z');

function bucket(overrides: Partial<QuotaBucket> & { name: string }): QuotaBucket {
  return {
    isUnlimited: false,
    limit: 100,
    used: 0,
    remaining: 100,
    remainingPercent: 100,
    overage: 0,
    ...overrides,
  };
}

/** A percentage-style bucket the CLI providers produce (limit 100 = percent). */
function pctBucket(name: string, used: number, resetDate?: string): QuotaBucket {
  return bucket({
    name,
    used,
    remaining: 100 - used,
    remainingPercent: 100 - used,
    ...(resetDate ? { resetDate } : {}),
  });
}

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

describe('quotaReserveEnabled', () => {
  it('is on by default (absent config enables the overall rule)', () => {
    expect(quotaReserveEnabled(undefined)).toBe(true);
    expect(quotaReserveEnabled({})).toBe(true);
  });

  it('is off only when overall is explicitly disabled and perDay is not enabled', () => {
    expect(quotaReserveEnabled({ overall: { enabled: false } })).toBe(false);
    expect(quotaReserveEnabled({ overall: { enabled: false }, perDay: { enabled: true } })).toBe(
      true,
    );
  });
});

describe('evaluateQuotaReserve', () => {
  it('applies the overall rule at the default 20% when config is absent', () => {
    expect(evaluateQuotaReserve([pctBucket('seven_day', 85)], undefined, NOW)).toMatchObject({
      bucket: 'seven_day',
      remainingPercent: 15,
      floorPercent: 20,
      rule: 'overall',
    });
    expect(evaluateQuotaReserve([pctBucket('seven_day', 70)], undefined, NOW)).toBeNull();
  });

  it('returns null when no rule is enabled', () => {
    const reserve: QuotaReserveConfig = { overall: { enabled: false } };
    expect(evaluateQuotaReserve([pctBucket('seven_day', 99)], reserve, NOW)).toBeNull();
  });

  it('returns null for empty buckets', () => {
    expect(evaluateQuotaReserve([], undefined, NOW)).toBeNull();
  });

  it('skips unlimited buckets', () => {
    const buckets = [bucket({ name: 'chat', isUnlimited: true, used: 100, remainingPercent: 0 })];
    expect(evaluateQuotaReserve(buckets, undefined, NOW)).toBeNull();
  });

  it('skips no-signal buckets (limit 0, used 0) despite a defaulted remainingPercent', () => {
    const buckets = [bucket({ name: 'mystery', limit: 0, used: 0, remainingPercent: 1 })];
    expect(evaluateQuotaReserve(buckets, undefined, NOW)).toBeNull();
  });

  it('derives remaining from counts when a real limit exists (Copilot shape)', () => {
    // 250/300 used -> 16.7% remaining; the reported remainingPercent lies.
    const buckets = [
      bucket({ name: 'premium_interactions', limit: 300, used: 250, remainingPercent: 90 }),
    ];
    expect(evaluateQuotaReserve(buckets, undefined, NOW)).toMatchObject({
      remainingPercent: 16.7,
      floorPercent: 20,
    });
  });

  it('trusts remainingPercent when there is no limit but real usage', () => {
    const buckets = [bucket({ name: 'window', limit: 0, used: 42, remainingPercent: 15 })];
    expect(evaluateQuotaReserve(buckets, undefined, NOW)).toMatchObject({
      remainingPercent: 15,
      rule: 'overall',
    });
  });

  it('holds inclusively at the boundary (remaining == floor)', () => {
    expect(evaluateQuotaReserve([pctBucket('seven_day', 80)], undefined, NOW)).toMatchObject({
      remainingPercent: 20,
      floorPercent: 20,
    });
  });

  it('per-day: reserves percent x fractional days until reset', () => {
    const reserve: QuotaReserveConfig = {
      overall: { enabled: false },
      perDay: { enabled: true, percent: 10 },
    };
    // Reset 4 days away -> floor 40: run until 60% consumed.
    const heldAt39 = [pctBucket('seven_day', 61, daysFromNow(4))];
    expect(evaluateQuotaReserve(heldAt39, reserve, NOW)).toMatchObject({
      floorPercent: 40,
      rule: 'per-day',
    });
    const allowedAt41 = [pctBucket('seven_day', 59, daysFromNow(4))];
    expect(evaluateQuotaReserve(allowedAt41, reserve, NOW)).toBeNull();
  });

  it('per-day: fractional sub-day windows scale down (36h -> floor 15)', () => {
    const reserve: QuotaReserveConfig = {
      overall: { enabled: false },
      perDay: { enabled: true, percent: 10 },
    };
    const buckets = [pctBucket('five_hour', 90, daysFromNow(1.5))];
    expect(evaluateQuotaReserve(buckets, reserve, NOW)).toMatchObject({
      floorPercent: 15,
      remainingPercent: 10,
    });
  });

  it('per-day: skips buckets without a future resetDate; overall still applies', () => {
    const reserve: QuotaReserveConfig = { perDay: { enabled: true, percent: 10 } };
    const noReset = [pctBucket('seven_day', 85)];
    expect(evaluateQuotaReserve(noReset, reserve, NOW)).toMatchObject({ rule: 'overall' });
    const pastReset = [pctBucket('seven_day', 85, daysFromNow(-1))];
    expect(evaluateQuotaReserve(pastReset, reserve, NOW)).toMatchObject({ rule: 'overall' });
    const onlyPerDay: QuotaReserveConfig = {
      overall: { enabled: false },
      perDay: { enabled: true, percent: 10 },
    };
    expect(evaluateQuotaReserve(noReset, onlyPerDay, NOW)).toBeNull();
  });

  it('both rules: the strictest floor wins and rule names the winner', () => {
    const reserve: QuotaReserveConfig = {
      overall: { enabled: true, percent: 20 },
      perDay: { enabled: true, percent: 10 },
    };
    const perDayWins = [pctBucket('seven_day', 65, daysFromNow(4))];
    expect(evaluateQuotaReserve(perDayWins, reserve, NOW)).toMatchObject({
      floorPercent: 40,
      rule: 'per-day',
    });
    const overallWins = [pctBucket('seven_day', 85, daysFromNow(1))];
    expect(evaluateQuotaReserve(overallWins, reserve, NOW)).toMatchObject({
      floorPercent: 20,
      rule: 'overall',
    });
  });

  it('clamps an over-100 per-day reserve to 100 (always holds)', () => {
    const reserve: QuotaReserveConfig = {
      overall: { enabled: false },
      perDay: { enabled: true, percent: 10 },
    };
    const buckets = [pctBucket('monthly', 1, daysFromNow(20))];
    expect(evaluateQuotaReserve(buckets, reserve, NOW)).toMatchObject({ floorPercent: 100 });
  });

  it('reports the most severe violation across buckets', () => {
    const buckets = [pctBucket('chat', 81), pctBucket('premium_interactions', 95)];
    expect(evaluateQuotaReserve(buckets, undefined, NOW)).toMatchObject({
      bucket: 'premium_interactions',
      remainingPercent: 5,
    });
  });
});

describe('NightShiftQuotaGate', () => {
  function makeGate(opts: {
    config?: GezelConfig;
    usage?: UsageTracker;
    claude?: NonNullable<NonNullable<ConstructorParameters<typeof NightShiftQuotaGate>[0]['probes']>['claude']>;
    codex?: NonNullable<NonNullable<ConstructorParameters<typeof NightShiftQuotaGate>[0]['probes']>['codex']>;
  }) {
    const usage = opts.usage ?? new UsageTracker();
    const gate = new NightShiftQuotaGate({
      store: { readConfig: async () => opts.config ?? ({} as GezelConfig) },
      usage,
      home: '/tmp/gezel-test-home',
      now: () => NOW,
      probes: {
        claude: opts.claude ?? (async () => null),
        codex: opts.codex ?? (async () => []),
      },
    });
    return { gate, usage };
  }

  it('returns null for providers that do not report quota', async () => {
    const claude = vi.fn(async () => null);
    const { gate } = makeGate({ claude });
    expect(await gate.holdFor('llama-cpp')).toBeNull();
    expect(await gate.holdFor('openai')).toBeNull();
    expect(claude).not.toHaveBeenCalled();
  });

  it('invokes no probe when every rule is explicitly disabled', async () => {
    const claude = vi.fn(async () => null);
    const { gate } = makeGate({
      config: { nightShift: { quotaReserve: { overall: { enabled: false } } } } as GezelConfig,
      claude,
    });
    expect(await gate.holdFor('anthropic-cli')).toBeNull();
    expect(claude).not.toHaveBeenCalled();
  });

  it('allows copilot optimistically while the tracker has no buckets', async () => {
    const { gate } = makeGate({});
    expect(await gate.holdFor('copilot')).toBeNull();
  });

  it('holds copilot from tracker buckets once a turn reported them', async () => {
    const usage = new UsageTracker();
    usage.recordQuotaBuckets('copilot', [
      bucket({ name: 'premium_interactions', limit: 300, used: 290, remainingPercent: 3.3 }),
    ]);
    const { gate } = makeGate({ usage });
    expect(await gate.holdFor('copilot')).toMatchObject({
      provider: 'copilot',
      bucket: 'premium_interactions',
      rule: 'overall',
    });
  });

  it('reads the claude snapshot, records it to the tracker, and holds on it', async () => {
    const { gate, usage } = makeGate({
      claude: async () => ({
        buckets: [pctBucket('five_hour', 85, daysFromNow(0.1))],
        capturedAt: NOW.toISOString(),
      }),
    });
    expect(await gate.holdFor('anthropic-cli')).toMatchObject({
      provider: 'anthropic-cli',
      bucket: 'five_hour',
      remainingPercent: 15,
    });
    expect(usage.quotaBucketsFor('anthropic-cli')).toHaveLength(1);
  });

  it('treats a zero-bucket claude snapshot as an authoritative allow', async () => {
    const usage = new UsageTracker();
    usage.recordQuotaBuckets('anthropic-cli', [pctBucket('five_hour', 99)]);
    const { gate } = makeGate({
      usage,
      claude: async () => ({ buckets: [], capturedAt: NOW.toISOString() }),
    });
    expect(await gate.holdFor('anthropic-cli')).toBeNull();
    expect(usage.quotaBucketsFor('anthropic-cli')).toHaveLength(0);
  });

  it('falls back to tracker buckets when the claude snapshot is absent', async () => {
    const usage = new UsageTracker();
    usage.recordQuotaBuckets('anthropic-cli', [pctBucket('seven_day', 90)]);
    const { gate } = makeGate({ usage, claude: async () => null });
    expect(await gate.holdFor('anthropic-cli')).toMatchObject({ bucket: 'seven_day' });
  });

  it('falls back to tracker buckets when the codex probe fails', async () => {
    const usage = new UsageTracker();
    usage.recordQuotaBuckets('codex-cli', [pctBucket('primary', 95)]);
    const { gate } = makeGate({
      usage,
      config: { codexCli: { binaryPath: process.execPath } } as GezelConfig,
      codex: async () => {
        throw new Error('probe failed');
      },
    });
    expect(await gate.holdFor('codex-cli')).toMatchObject({ bucket: 'primary' });
  });

  it('never throws: a store read failure allows', async () => {
    const gate = new NightShiftQuotaGate({
      store: {
        readConfig: async () => {
          throw new Error('disk');
        },
      },
      usage: new UsageTracker(),
      home: '/tmp/gezel-test-home',
      now: () => NOW,
    });
    expect(await gate.holdFor('copilot')).toBeNull();
  });
});

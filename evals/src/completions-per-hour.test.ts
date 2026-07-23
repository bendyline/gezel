import { describe, expect, it } from 'vitest';
import {
  type CompletionsRateInput,
  completionsPerTierPerHour,
  formatCompletionsTable,
} from './completions-per-hour.ts';

const H = 3_600_000; // 1 hour in ms

describe('completionsPerTierPerHour', () => {
  it('computes completions / summed-wall-clock-hours per tier', () => {
    const trials: CompletionsRateInput[] = [
      { modelTier: 'small', success: true, durationMs: 0.5 * H },
      { modelTier: 'small', success: true, durationMs: 0.5 * H },
      { modelTier: 'small', success: false, durationMs: 1 * H },
    ];
    const { byTier, overall } = completionsPerTierPerHour(trials);
    const small = byTier.find((t) => t.tier === 'small');
    // 2 completions over 2h total wall-clock = 1.0 completions/hr.
    expect(small?.completions).toBe(2);
    expect(small?.trials).toBe(3);
    expect(small?.wallClockHours).toBe(2);
    expect(small?.completionsPerHour).toBe(1);
    expect(small?.failShare).toBe(0.33);
    expect(overall.completionsPerHour).toBe(1);
  });

  it('rewards cutting the fail tax: same completions, less wasted wall-clock → higher rate', () => {
    const before = completionsPerTierPerHour([
      { modelTier: 'medium', success: true, durationMs: 1 * H },
      { modelTier: 'medium', success: false, durationMs: 3 * H }, // fail burns 3× — the tax
    ]);
    const after = completionsPerTierPerHour([
      { modelTier: 'medium', success: true, durationMs: 1 * H },
      { modelTier: 'medium', success: false, durationMs: 0.5 * H }, // fail-fast paused it early
    ]);
    // No extra pass, yet the rate rose because the doomed trial wasted less time.
    expect(before.overall.completionsPerHour).toBe(0.25); // 1 / 4h
    expect(after.overall.completionsPerHour).toBeCloseTo(0.67, 1); // 1 / 1.5h
    expect(after.overall.completionsPerHour!).toBeGreaterThan(before.overall.completionsPerHour!);
  });

  it('groups tier-less trials under "unknown" and orders tiers canonically', () => {
    const { byTier } = completionsPerTierPerHour([
      { success: true, durationMs: H },
      { modelTier: 'tiny', success: true, durationMs: H },
      { modelTier: 'large', success: false, durationMs: H },
    ]);
    expect(byTier.map((t) => t.tier)).toEqual(['tiny', 'large', 'unknown']);
  });

  it('returns null rate (not a divide-by-zero) when no trial carried a duration', () => {
    const { overall } = completionsPerTierPerHour([
      { modelTier: 'small', success: true },
      { modelTier: 'small', success: false },
    ]);
    expect(overall.wallClockHours).toBe(0);
    expect(overall.completionsPerHour).toBeNull();
    expect(overall.completions).toBe(1);
  });

  it('renders a table with a header and an overall row', () => {
    const table = formatCompletionsTable(
      completionsPerTierPerHour([{ modelTier: 'small', success: true, durationMs: H }]),
    );
    expect(table).toContain('compl/hr');
    expect(table).toContain('small');
    expect(table).toContain('all');
  });
});

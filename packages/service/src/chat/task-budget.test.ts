import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_BUDGET_LIMITS,
  TaskBudgetTracker,
  resolveTaskBudgetLimits,
} from './task-budget.js';

const REF = 'p1#3';
const noUsage = { outputTokens: 0, inputTokens: 0 };

/** Drive N turns of a fixed per-turn delta, returning the last trip. */
function driveTurns(
  t: TaskBudgetTracker,
  n: number,
  tier: Parameters<TaskBudgetTracker['account']>[1],
  delta = noUsage,
) {
  let last = t.account(REF, tier, delta);
  for (let i = 1; i < n; i++) last = t.account(REF, tier, delta);
  return last;
}

describe('resolveTaskBudgetLimits', () => {
  it('gives tiny more TURN headroom than large (tiny needs more steps for the same work)', () => {
    // Turn caps are monotone by tier — a tiny model takes more round-trips.
    expect(DEFAULT_TASK_BUDGET_LIMITS.tiny.hardTurns).toBeGreaterThan(
      DEFAULT_TASK_BUDGET_LIMITS.small.hardTurns,
    );
    expect(DEFAULT_TASK_BUDGET_LIMITS.small.hardTurns).toBeGreaterThan(
      DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns,
    );
  });

  it('does NOT force token caps monotone — calibration found tiny terse, mid-size verbose', () => {
    // The F4 calibration showed output-token spend does not scale monotone
    // with tier: tiny models emit few tokens (terse per step), 27B-class
    // mediums are the most verbose. So the token budget is per-tier measured,
    // and medium's cap is the highest of the local tiers.
    expect(DEFAULT_TASK_BUDGET_LIMITS.medium.hardOutputTokens).toBeGreaterThan(
      DEFAULT_TASK_BUDGET_LIMITS.tiny.hardOutputTokens,
    );
    // Every cap is a sane positive number and soft < hard.
    for (const t of ['tiny', 'small', 'medium', 'large', 'cloud'] as const) {
      const l = DEFAULT_TASK_BUDGET_LIMITS[t];
      expect(l.softTurns).toBeLessThan(l.hardTurns);
      expect(l.softOutputTokens).toBeLessThan(l.hardOutputTokens);
    }
  });

  it('applies the scale dial and per-tier overrides', () => {
    const scaled = resolveTaskBudgetLimits('large', { scale: 2 });
    expect(scaled.hardTurns).toBe(DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns * 2);
    const overridden = resolveTaskBudgetLimits('large', { limits: { large: { hardTurns: 7 } } });
    expect(overridden.hardTurns).toBe(7);
    // Override wins over scale for the overridden field only.
    const both = resolveTaskBudgetLimits('large', {
      scale: 2,
      limits: { large: { hardTurns: 7 } },
    });
    expect(both.hardTurns).toBe(7);
    expect(both.softTurns).toBe(DEFAULT_TASK_BUDGET_LIMITS.large.softTurns * 2);
  });
});

describe('TaskBudgetTracker', () => {
  it('accumulates turns + tokens and snapshots them', () => {
    const t = new TaskBudgetTracker();
    t.account(REF, 'large', { outputTokens: 10, inputTokens: 5 });
    t.account(REF, 'large', { outputTokens: 20, inputTokens: 5 });
    expect(t.snapshot(REF)).toEqual({ turns: 2, outputTokens: 30, inputTokens: 10 });
  });

  it('fires soft once at the soft turn threshold, then stays quiet', () => {
    const t = new TaskBudgetTracker();
    const soft = DEFAULT_TASK_BUDGET_LIMITS.large.softTurns;
    // Below threshold: no trip.
    expect(driveTurns(t, soft - 1, 'large').kind).toBe('none');
    // Crossing turn: soft.
    const trip = t.account(REF, 'large', noUsage);
    expect(trip.kind).toBe('soft');
    expect(trip.kind !== 'none' && trip.reason).toBe('turns');
    // Next turn: no re-fire (one-shot).
    expect(t.account(REF, 'large', noUsage).kind).toBe('none');
  });

  it('fires hard once at the hard turn threshold', () => {
    const t = new TaskBudgetTracker();
    const hard = DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns;
    const trip = driveTurns(t, hard, 'large');
    expect(trip.kind).toBe('hard');
    expect(t.account(REF, 'large', noUsage).kind).toBe('none');
  });

  it('fires on output tokens when they cross before turns', () => {
    const t = new TaskBudgetTracker();
    const trip = t.account(REF, 'large', {
      outputTokens: DEFAULT_TASK_BUDGET_LIMITS.large.softOutputTokens,
      inputTokens: 0,
    });
    expect(trip.kind).toBe('soft');
    expect(trip.kind !== 'none' && trip.reason).toBe('outputTokens');
  });

  it('a single huge turn vaults straight to hard (hard subsumes soft)', () => {
    const t = new TaskBudgetTracker();
    const trip = t.account(REF, 'large', {
      outputTokens: DEFAULT_TASK_BUDGET_LIMITS.large.hardOutputTokens + 1,
      inputTokens: 0,
    });
    expect(trip.kind).toBe('hard');
    // Soft never fires afterward — it was subsumed.
    expect(t.account(REF, 'large', noUsage).kind).toBe('none');
  });

  it('reset clears the accumulator so a re-engaged task starts fresh', () => {
    const t = new TaskBudgetTracker();
    driveTurns(t, DEFAULT_TASK_BUDGET_LIMITS.large.softTurns, 'large');
    expect(t.snapshot(REF)?.turns).toBe(DEFAULT_TASK_BUDGET_LIMITS.large.softTurns);
    t.reset(REF);
    expect(t.snapshot(REF)).toBeUndefined();
    // After reset, soft must fire again (not stay latched).
    expect(driveTurns(t, DEFAULT_TASK_BUDGET_LIMITS.large.softTurns, 'large').kind).toBe('soft');
  });

  it('tiny tier survives past the large hard cap (tier scaling)', () => {
    const t = new TaskBudgetTracker();
    const trip = driveTurns(t, DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns, 'tiny');
    // At large's hard cap, tiny (higher cap) has not yet tripped hard.
    expect(trip.kind).not.toBe('hard');
  });

  it('honors enabled:false (never trips, never accumulates a trip)', () => {
    const t = new TaskBudgetTracker({ enabled: false });
    expect(driveTurns(t, DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns * 2, 'large').kind).toBe(
      'none',
    );
    expect(t.enabled).toBe(false);
  });

  it('honors hardPause:false (soft still fires, hard never does)', () => {
    const t = new TaskBudgetTracker({ hardPause: false });
    expect(driveTurns(t, DEFAULT_TASK_BUDGET_LIMITS.large.softTurns, 'large').kind).toBe('soft');
    // Way past the hard cap, still never 'hard'.
    expect(driveTurns(t, DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns, 'large').kind).not.toBe(
      'hard',
    );
  });

  it('honors softNudge:false (no soft, hard still trips at the hard turn)', () => {
    const t = new TaskBudgetTracker({ softNudge: false });
    const hard = DEFAULT_TASK_BUDGET_LIMITS.large.hardTurns;
    // Drive to one below hard — soft would have fired here but is disabled.
    expect(driveTurns(t, hard - 1, 'large').kind).toBe('none');
    // The crossing turn trips hard.
    expect(t.account(REF, 'large', noUsage).kind).toBe('hard');
  });

  it('keeps separate accumulators per task ref', () => {
    const t = new TaskBudgetTracker();
    t.account('p1#1', 'large', { outputTokens: 100, inputTokens: 0 });
    t.account('p1#2', 'large', { outputTokens: 5, inputTokens: 0 });
    expect(t.snapshot('p1#1')?.outputTokens).toBe(100);
    expect(t.snapshot('p1#2')?.outputTokens).toBe(5);
  });
});

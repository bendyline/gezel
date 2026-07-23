/**
 * Fail-fast per-task token/request budget (Theme F, F3.1).
 *
 * The failure tax this attacks: a doomed task SPINS — re-driven steps,
 * handoff loops, a model that keeps "making progress" without converging —
 * burning 3–7× the wall-clock and 2.3–3.6× the tokens of a passing run, with
 * NO cumulative per-task ceiling anywhere in the runtime today. The existing
 * budgets are all count-based and local: the tool-loop cap (`MAX_TOOL_LOOP_TURNS`)
 * bounds ONE send, the gate `maxAttempts` / scheduler re-drive budgets bound a
 * step's convergence. None of them bound a task's TOTAL spend across the many
 * sessions and sends that serve it. This tracker is that cumulative backstop.
 *
 * Two thresholds, tier-scaled (a tiny model legitimately needs more turns to
 * do the same work, so it gets more headroom):
 *   - soft → a one-shot nudge telling the model to wrap up / narrow scope /
 *     surface the blocker (`ask_user_question`) before it burns the rest.
 *   - hard → trip the existing pause-for-help path (note + `setStatus('paused')`),
 *     which is RESUMABLE — a false positive costs the user one "resume", never
 *     lost work. This is the product mirror of Theme E's batch auto-triage.
 *
 * Scope discipline (the false-positive guard): the accumulator counts UNATTENDED
 * spend. A genuine user message resets it (the human is engaged — a long
 * interactive session is not a runaway), so only sustained autonomous spend
 * (scheduler re-drives, handoffs, continuation loops with no human in the loop —
 * exactly the eval fail-tax, which is fully autonomous after kickoff) climbs
 * toward the cap. The caller resets via {@link TaskBudgetTracker.reset} on a
 * user-initiated send.
 *
 * This module is pure + framework-free so it unit-tests in isolation; the
 * ChatManager owns one instance, accounts each turn's usage, resets on user
 * sends, and routes a hard trip to an injected pause handler.
 */
import type { ModelTier } from './local-model-tier.js';

export interface TaskBudgetLimits {
  /** Cumulative provider round-trips (turns) before the threshold. */
  softTurns: number;
  hardTurns: number;
  /** Cumulative generated (output) tokens before the threshold. */
  softOutputTokens: number;
  hardOutputTokens: number;
}

export interface TaskBudgetConfig {
  /** Master switch. Default on. */
  enabled?: boolean;
  /** Emit soft nudges. Default on. */
  softNudge?: boolean;
  /** Trip pause-for-help on the hard threshold. Default on. */
  hardPause?: boolean;
  /** Uniform multiplier on every default limit (operator dial). Default 1. */
  scale?: number;
  /** Per-tier limit overrides (partial — unset fields fall back to defaults × scale). */
  limits?: Partial<Record<ModelTier, Partial<TaskBudgetLimits>>>;
}

/**
 * Tier-scaled defaults CALIBRATED against 389 scored trials (F4 —
 * `evals/src/bin/analyze-task-spend.ts`, notes in
 * `evals/runs/task-budget-calibration-2026-07-08.md`). The pre-calibration
 * values erred 6–14× high and were effectively inert.
 *
 * Output tokens is the primary, budget-aligned signal (the fail tax is ~3.6×
 * OUTPUT tokens, and unlike turns it isn't inflated by background klerk
 * sessions): `soft` sits just above the p95–p99 of PASSING trials so
 * legitimate work rarely trips, `hard` reaches into the FAILING tail where the
 * 3–7× wasted wall-clock concentrates (median fails are short give-ups and are
 * left to the timeout / gate budgets). Turns is a generous backstop for
 * many-tiny-output spinning; it's derived from the daemon-log round-trip count
 * which OVER-counts vs. the budget's task-scoped-only tally, so it's set
 * loose on purpose.
 *
 * The two signals scale OPPOSITELY with tier — a tiny model needs more TURNS
 * (more steps for the same work) but fewer TOKENS (terse per step), while
 * mid-size 27B models are the most verbose. So the turn caps are monotone
 * (tiny > large) but the token caps are not (medium is highest). Tunable
 * per-tier via config; re-run the analyzer after a model-set change.
 */
export const DEFAULT_TASK_BUDGET_LIMITS: Record<ModelTier, TaskBudgetLimits> = {
  tiny: { softTurns: 70, hardTurns: 150, softOutputTokens: 8_000, hardOutputTokens: 25_000 },
  small: { softTurns: 50, hardTurns: 100, softOutputTokens: 18_000, hardOutputTokens: 40_000 },
  medium: { softTurns: 40, hardTurns: 90, softOutputTokens: 30_000, hardOutputTokens: 60_000 },
  large: { softTurns: 35, hardTurns: 75, softOutputTokens: 15_000, hardOutputTokens: 35_000 },
  cloud: { softTurns: 35, hardTurns: 75, softOutputTokens: 40_000, hardOutputTokens: 80_000 },
};

export function resolveTaskBudgetLimits(
  tier: ModelTier,
  config: TaskBudgetConfig = {},
): TaskBudgetLimits {
  const base = DEFAULT_TASK_BUDGET_LIMITS[tier] ?? DEFAULT_TASK_BUDGET_LIMITS.large;
  const scale = config.scale && config.scale > 0 ? config.scale : 1;
  const override = config.limits?.[tier] ?? {};
  const pick = (k: keyof TaskBudgetLimits): number => override[k] ?? Math.round(base[k] * scale);
  return {
    softTurns: pick('softTurns'),
    hardTurns: pick('hardTurns'),
    softOutputTokens: pick('softOutputTokens'),
    hardOutputTokens: pick('hardOutputTokens'),
  };
}

export interface TaskBudgetSnapshot {
  turns: number;
  outputTokens: number;
  inputTokens: number;
}

interface TaskBudgetState extends TaskBudgetSnapshot {
  /** One-shot latches so a threshold fires exactly once per accumulation run. */
  softEmitted: boolean;
  hardEmitted: boolean;
}

export type TaskBudgetTrip =
  | { kind: 'none' }
  | {
      kind: 'soft' | 'hard';
      /** Which limit tripped first. */
      reason: 'turns' | 'outputTokens';
      snapshot: TaskBudgetSnapshot;
      limits: TaskBudgetLimits;
    };

export interface TaskUsageDelta {
  outputTokens: number;
  inputTokens: number;
}

/**
 * Per-task cumulative accumulator. Keyed by task ref; one instance is shared
 * across every session that serves a task, so the counts aggregate across
 * handoffs. Not persisted — a daemon restart resets it, which is acceptable:
 * a runaway burns in a burst, not across restarts, and the count-based
 * scheduler/gate budgets persist the convergence side separately.
 */
export class TaskBudgetTracker {
  private readonly states = new Map<string, TaskBudgetState>();
  private config: TaskBudgetConfig;

  constructor(config: TaskBudgetConfig = {}) {
    this.config = config;
  }

  /**
   * Replace the live config (thresholds are tunable via `updateConfig`).
   * Existing accumulators are untouched — a threshold change takes effect on
   * the next {@link account}; already-latched trips stay latched.
   */
  setConfig(config: TaskBudgetConfig): void {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled !== false;
  }

  /** Drop a task's accumulator — called on a user-initiated send and on task terminal status. */
  reset(taskRef: string): void {
    this.states.delete(taskRef);
  }

  snapshot(taskRef: string): TaskBudgetSnapshot | undefined {
    const s = this.states.get(taskRef);
    return s
      ? { turns: s.turns, outputTokens: s.outputTokens, inputTokens: s.inputTokens }
      : undefined;
  }

  /**
   * Account one turn's usage against a task and report a NEWLY-crossed
   * threshold (one-shot per run). Hard is checked before soft so a huge
   * single turn that vaults past both reports `hard` directly. Returns
   * `{kind:'none'}` when disabled, below thresholds, or already-emitted.
   */
  account(taskRef: string, tier: ModelTier, delta: TaskUsageDelta): TaskBudgetTrip {
    if (!this.enabled) return { kind: 'none' };
    const s = this.states.get(taskRef) ?? {
      turns: 0,
      outputTokens: 0,
      inputTokens: 0,
      softEmitted: false,
      hardEmitted: false,
    };
    s.turns += 1;
    s.outputTokens += Math.max(0, delta.outputTokens);
    s.inputTokens += Math.max(0, delta.inputTokens);
    this.states.set(taskRef, s);

    const limits = resolveTaskBudgetLimits(tier, this.config);
    const snapshot: TaskBudgetSnapshot = {
      turns: s.turns,
      outputTokens: s.outputTokens,
      inputTokens: s.inputTokens,
    };

    if (!s.hardEmitted && this.config.hardPause !== false) {
      const overTokens = s.outputTokens >= limits.hardOutputTokens;
      const overTurns = s.turns >= limits.hardTurns;
      if (overTokens || overTurns) {
        s.hardEmitted = true;
        s.softEmitted = true; // hard subsumes soft — never nudge after pausing
        return { kind: 'hard', reason: overTokens ? 'outputTokens' : 'turns', snapshot, limits };
      }
    }
    if (!s.softEmitted && this.config.softNudge !== false) {
      const overTokens = s.outputTokens >= limits.softOutputTokens;
      const overTurns = s.turns >= limits.softTurns;
      if (overTokens || overTurns) {
        s.softEmitted = true;
        return { kind: 'soft', reason: overTokens ? 'outputTokens' : 'turns', snapshot, limits };
      }
    }
    return { kind: 'none' };
  }
}

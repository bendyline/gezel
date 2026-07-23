/**
 * The governing metric for Theme F (F4.3): **gate-verified completions per
 * model-tier per hour**. Every performance lever — spec decoding, the
 * fail-fast budget, the tool diet — is judged in THIS unit, not raw t/s.
 *
 * Why this unit and not tokens/sec: raw decode t/s can rise while the product
 * gets no faster (a model that decodes 20% quicker but spins on a doomed task
 * still ships nothing). The north-star is verified WORK per unit of wall-clock.
 * Crucially the denominator is the wall-clock of ALL trials in the tier —
 * successes AND failures — so a lever that cuts the 41% fail tax (fails burn
 * 3–7× the wall-clock) raises completions/hour even without a single extra
 * pass, just by shrinking wasted time. That is exactly the alignment we want:
 * the metric rewards "stop wasting time on doomed work" the same as "finish
 * more work."
 *
 * Pure + framework-free so it unit-tests in isolation and any report can call
 * it over Theme-E `facts.json` trials (which now carry `modelTier` + duration).
 */
export interface CompletionsRateInput {
  /** Model capability tier; trials without one are grouped under `unknown`. */
  modelTier?: string;
  /** Gate-verified success (the scenario passed). */
  success: boolean;
  /** Trial wall-clock in ms; trials without a duration don't count toward hours. */
  durationMs?: number;
}

export interface TierCompletionsRate {
  tier: string;
  /** Gate-verified completions (successful trials). */
  completions: number;
  /** Total trials in the tier (successes + failures). */
  trials: number;
  /** Trials that carried a usable wall-clock (the hours denominator's support). */
  timedTrials: number;
  /** Summed wall-clock of ALL timed trials in the tier, in hours. */
  wallClockHours: number;
  /** completions / wallClockHours; null when no timed wall-clock exists. */
  completionsPerHour: number | null;
  /** Fraction of trials that failed (the tax this metric is sensitive to). */
  failShare: number;
}

const MS_PER_HOUR = 3_600_000;
const TIER_ORDER = ['tiny', 'small', 'medium', 'large', 'cloud', 'unknown'];

function rollUp(tier: string, rows: CompletionsRateInput[]): TierCompletionsRate {
  const trials = rows.length;
  const completions = rows.filter((r) => r.success).length;
  const timed = rows.filter((r) => typeof r.durationMs === 'number' && r.durationMs >= 0);
  const wallClockHours = timed.reduce((s, r) => s + (r.durationMs ?? 0), 0) / MS_PER_HOUR;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    tier,
    completions,
    trials,
    timedTrials: timed.length,
    wallClockHours: round2(wallClockHours),
    completionsPerHour: wallClockHours > 0 ? round2(completions / wallClockHours) : null,
    failShare: trials > 0 ? round2((trials - completions) / trials) : 0,
  };
}

export function completionsPerTierPerHour(trials: CompletionsRateInput[]): {
  byTier: TierCompletionsRate[];
  overall: TierCompletionsRate;
} {
  const groups = new Map<string, CompletionsRateInput[]>();
  for (const t of trials) {
    const tier = t.modelTier ?? 'unknown';
    const bucket = groups.get(tier);
    if (bucket) bucket.push(t);
    else groups.set(tier, [t]);
  }
  const byTier = [...groups.entries()]
    .map(([tier, rows]) => rollUp(tier, rows))
    .sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a.tier);
      const bi = TIER_ORDER.indexOf(b.tier);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  return { byTier, overall: rollUp('all', trials) };
}

/** Render the metric as a fixed-width table for an operator readout. */
export function formatCompletionsTable(result: {
  byTier: TierCompletionsRate[];
  overall: TierCompletionsRate;
}): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  const header = `${pad('tier', 9)}${padL('compl', 7)}${padL('trials', 8)}${padL('hours', 8)}${padL('compl/hr', 10)}${padL('fail%', 8)}`;
  const row = (r: TierCompletionsRate) =>
    `${pad(r.tier, 9)}${padL(String(r.completions), 7)}${padL(String(r.trials), 8)}${padL(r.wallClockHours.toFixed(2), 8)}${padL(r.completionsPerHour === null ? 'n/a' : r.completionsPerHour.toFixed(2), 10)}${padL(`${Math.round(r.failShare * 100)}%`, 8)}`;
  return [
    header,
    '─'.repeat(header.length),
    ...result.byTier.map(row),
    '─'.repeat(header.length),
    row(result.overall),
  ].join('\n');
}

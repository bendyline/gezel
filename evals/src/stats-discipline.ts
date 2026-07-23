/**
 * Statistical-discipline rendering for pass claims (Theme E / E1).
 *
 * Single-trial noise is ±7pp and at tiny tier (~50% base rate) n=1 is a
 * coin flip — so the harness must never *present* a pass fraction as a
 * rate ("100.0%") when the sample can't support it. This changes only the
 * human-facing rendering; the numeric `successRate` field on
 * `BatchSummary`/`MatrixSummary` is untouched for machine consumers. The
 * harness still runs whatever `--count` it was given — it just refuses to
 * *claim a rate* it can't stand behind.
 */

/** Below this many trials, a pass fraction is rendered as a raw count, not a rate. */
export const MIN_TRIALS_FOR_RATE = 3;

/**
 * Render a pass fraction. When `trials < MIN_TRIALS_FOR_RATE` (or
 * `forceCount` — used for tiny-tier cells where even n≥3 is too noisy to
 * quote as a rate), return a count form that names *why* it isn't a
 * percentage. Otherwise the familiar `s/t (P%)`.
 */
export function formatPassClaim(
  successes: number,
  trials: number,
  opts: { forceCount?: boolean } = {},
): string {
  if (trials <= 0) return '0/0 (no trials)';
  if (opts.forceCount) {
    return `${successes}/${trials} pass (count not rate — tiny tier)`;
  }
  if (trials < MIN_TRIALS_FOR_RATE) {
    return `${successes}/${trials} pass (n<${MIN_TRIALS_FOR_RATE} — count not rate)`;
  }
  return `${successes}/${trials} (${((100 * successes) / trials).toFixed(1)}%)`;
}

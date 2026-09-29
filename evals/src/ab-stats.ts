/**
 * Statistics shared by the retrieval bench and the A/B bins. Everything is
 * seeded, so a report reproduces exactly from the same rows.
 */

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/**
 * Percentile bootstrap of a statistic over rows, resampling within strata so
 * every query class keeps its weight in every resample. `stat` returns null
 * when a resample has nothing to measure; those resamples are skipped.
 */
export function stratifiedBootstrap<T>(
  rows: readonly T[],
  stat: (sample: readonly T[]) => number | null,
  opts: { strata?: (row: T) => string; iterations?: number; seed?: number } = {},
): Interval | null {
  const estimate = stat(rows);
  if (estimate === null) return null;
  const iterations = opts.iterations ?? 10_000;
  const random = seededRandom(opts.seed ?? 20_260_926);
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = opts.strata?.(row) ?? '';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const draws: number[] = [];
  const sample: T[] = [];
  for (let i = 0; i < iterations; i++) {
    sample.length = 0;
    for (const group of groups.values()) {
      for (let j = 0; j < group.length; j++) {
        sample.push(group[Math.floor(random() * group.length)]!);
      }
    }
    const value = stat(sample);
    if (value !== null) draws.push(value);
  }
  if (draws.length === 0) return { estimate, low: estimate, high: estimate };
  draws.sort((a, b) => a - b);
  return {
    estimate,
    low: quantile(draws, 0.025),
    high: quantile(draws, 0.975),
  };
}

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Exact two-sided McNemar test on the discordant pairs of a paired binary
 * outcome: `b` = arm A yes / arm B no, `c` = arm A no / arm B yes.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomial(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** Mean of the non-null values, or null when there are none. */
export function meanOf(values: ReadonlyArray<number | null | undefined>): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    sum += value;
    count++;
  }
  return count === 0 ? null : sum / count;
}

export interface PairedEffect {
  n: number;
  meanDelta: number | null;
  medianDelta: number | null;
  /** Normal-approximation 95% interval (the ab-reasoning-effort convention). */
  ci95: [number, number] | null;
  /** Percentile bootstrap of the mean delta, stratified when strata are given. */
  bootstrap: Interval | null;
  wins: number;
  ties: number;
  losses: number;
  /** Exact two-sided sign test on wins vs losses. */
  signTestP: number;
}

/** Effect of B over A from paired deltas (B − A), optionally stratified by scenario. */
export function pairedEffect(
  deltas: readonly number[],
  opts: { strata?: readonly string[]; iterations?: number; seed?: number } = {},
): PairedEffect {
  const n = deltas.length;
  const mean = meanOf(deltas);
  const variance =
    n > 1 && mean !== null ? deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1) : null;
  const margin = variance !== null ? 1.96 * Math.sqrt(variance / n) : null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const rows = deltas.map((delta, i) => ({ delta, stratum: opts.strata?.[i] ?? '' }));
  const wins = deltas.filter((d) => d > 0).length;
  const losses = deltas.filter((d) => d < 0).length;
  return {
    n,
    meanDelta: mean,
    medianDelta: n === 0 ? null : quantile(sorted, 0.5),
    ci95: mean !== null && margin !== null ? [mean - margin, mean + margin] : null,
    bootstrap:
      n === 0
        ? null
        : stratifiedBootstrap(rows, (sample) => meanOf(sample.map((row) => row.delta)), {
            strata: (row) => row.stratum,
            iterations: opts.iterations ?? 10_000,
            seed: opts.seed ?? 20_260_926,
          }),
    wins,
    ties: n - wins - losses,
    losses,
    signTestP: mcnemarExact(wins, losses),
  };
}

/** Holm step-down adjustment of p-values, in input order. */
export function holm(pValues: readonly number[]): number[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, p * (pValues.length - rank)));
    adjusted[i] = running;
  });
  return adjusted;
}

/**
 * Pairs needed to detect `effect` at α = 0.05 (two-sided) with 80% power,
 * given the standard deviation of the paired deltas. The futility rule: when
 * this is out of reach, report "no detectable effect at feasible n" instead of
 * spending days of device time.
 */
export function pairsNeeded(deltaSd: number, effect: number): number {
  if (effect <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil((((1.96 + 0.8416) * deltaSd) / effect) ** 2);
}

/**
 * Embedding-threshold calibration harness.
 *
 * Measures cosine-similarity distributions for the shipped embedder over
 * labeled memory-shaped pairs, in both comparison modes the product uses:
 *
 * - passage↔passage (`embed` both sides) — what the memory DEDUP gate
 *   compares (`MEMORY_DEDUP_THRESHOLD`, memory/manager.ts).
 * - query→passage (`embedQuery` vs `embed`) — what every search/recall floor
 *   compares (`MEMORY_MIN_SIMILARITY` in search-service.ts, the recall floors
 *   in memory/recall.ts, the craftbook blend floors in craftbook/suggest.ts).
 *
 * The two modes differ whenever the embedder has a query-side instruction
 * prefix (bge-*), which is exactly why floors calibrated on a symmetric model
 * (MiniLM) cannot be trusted after an asymmetric one ships. Run:
 *
 *   pnpm --filter @bendyline/gezel-evals run embed-calibration
 *   GEZEL_EMBED_MODEL=Xenova/all-MiniLM-L6-v2 pnpm --filter @bendyline/gezel-evals run embed-calibration
 *
 * This is a tsx bin, NOT a vitest test: the service vitest config pins
 * GEZEL_EMBED_MODEL to MiniLM for plumbing tests, so a test here would
 * measure the wrong model. Record results in evals/runs/ (LEVERS.md
 * discipline) whenever a threshold constant is changed from them.
 */

import {
  distinctFactPairs,
  paraphrasePairs,
  relevantQueryPairs,
  unrelatedPairs,
  unrelatedQueryPairs,
  type Pair,
} from '../embed-calibration/pairs.js';

import { embed, embedBatch, embedModelId, embedQuery } from '@bendyline/gezel-service';

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s; // vectors are L2-normalized by the pipeline, so dot == cosine
}

interface BandStats {
  n: number;
  min: number;
  p25: number;
  median: number;
  p95: number;
  max: number;
}

function stats(scores: number[]): BandStats {
  const s = [...scores].sort((x, y) => x - y);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, min: s[0]!, p25: at(0.25), median: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
}

function fmt(v: number): string {
  return v.toFixed(3);
}

function row(label: string, b: BandStats): string {
  return `  ${label.padEnd(28)} n=${String(b.n).padStart(2)}  min=${fmt(b.min)}  p25=${fmt(b.p25)}  med=${fmt(b.median)}  p95=${fmt(b.p95)}  max=${fmt(b.max)}`;
}

async function passageScores(pairs: Pair[]): Promise<number[]> {
  const vecs = await embedBatch(pairs.flatMap(([a, b]) => [a, b]));
  const out: number[] = [];
  for (let i = 0; i < pairs.length; i++) out.push(dot(vecs[i * 2]!, vecs[i * 2 + 1]!));
  return out;
}

async function queryScores(pairs: Pair[]): Promise<number[]> {
  const passages = await embedBatch(pairs.map(([, p]) => p));
  const out: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const q = await embedQuery(pairs[i]![0]);
    out.push(dot(q, passages[i]!));
  }
  return out;
}

async function main(): Promise<void> {
  // The embeddings worker is unref()'d (it must never hold the daemon open),
  // so in a standalone bin the event loop can empty while awaiting the first
  // response and node exits silently. Hold a handle for the duration.
  const keepalive = setInterval(() => {}, 60_000);
  try {
    await run();
  } finally {
    clearInterval(keepalive);
  }
}

async function run(): Promise<void> {
  await embed('warmup');
  console.log(`embedder: ${embedModelId()}\n`);

  const [paraphrase, distinct, unrelated] = await Promise.all([
    passageScores(paraphrasePairs),
    passageScores(distinctFactPairs),
    passageScores(unrelatedPairs),
  ]);
  const relevantQ = await queryScores(relevantQueryPairs);
  const unrelatedQ = await queryScores(unrelatedQueryPairs);

  const p = stats(paraphrase);
  const d = stats(distinct);
  const u = stats(unrelated);
  const rq = stats(relevantQ);
  const uq = stats(unrelatedQ);

  console.log('passage↔passage (dedup gate: MEMORY_DEDUP_THRESHOLD)');
  console.log(row('paraphrase (must dedup)', p));
  console.log(row('distinct fact (must keep)', d));
  console.log(row('unrelated (noise anchor)', u));
  console.log(
    `  → dedup gap: distinct max=${fmt(d.max)} … paraphrase min=${fmt(p.min)}` +
      (p.min > d.max
        ? `  (candidate threshold ~${fmt((d.max + p.min) / 2)})`
        : '  (BANDS OVERLAP — inspect pairs before trusting any threshold)'),
  );

  console.log('\nquery→passage (search/recall floors: MEMORY_MIN_SIMILARITY, recall.ts floors)');
  console.log(row('relevant (must surface)', rq));
  console.log(row('unrelated (must not)', uq));
  console.log(
    `  → floor gap: unrelated max=${fmt(uq.max)} … relevant min=${fmt(rq.min)}` +
      (rq.min > uq.max
        ? `  (candidate floor ~${fmt((uq.max + rq.min) / 2)})`
        : '  (BANDS OVERLAP — inspect pairs before trusting any floor)'),
  );
  console.log(
    '\nNote: floors sit inside the gap, biased toward the unrelated band ' +
      '(recall losses are visible and recoverable; noise admissions are silent). ' +
      'The dedup threshold sits inside its gap biased toward the paraphrase band ' +
      '(a dropped distinct memory is silent data loss; a kept restatement is clutter).',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});

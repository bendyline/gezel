/**
 * Operator readout for the Theme F governing metric — gate-verified
 * completions per model-tier per hour (F4.3). Discovers scored trials under a
 * runs dir (reusing compare-scores' `facts.json`/`result.json` reader) and
 * prints the completions/hour table.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx src/bin/completions-per-hour.ts [runsDir]
 *      (defaults to <repo>/evals/runs)
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completionsPerTierPerHour, formatCompletionsTable } from '../completions-per-hour.ts';
import { discoverScoredTrials } from './compare-scores.ts';

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const runsDir = resolve(process.argv[2] ?? join(here, '..', '..', 'runs'));
  const trials = discoverScoredTrials(runsDir);
  if (trials.length === 0) {
    console.error(`[completions/hr] no scored trials found under ${runsDir}`);
    process.exit(1);
  }
  const result = completionsPerTierPerHour(
    trials.map((t) => ({
      ...(t.modelTier ? { modelTier: t.modelTier } : {}),
      success: t.success,
      ...(typeof t.durationMs === 'number' ? { durationMs: t.durationMs } : {}),
    })),
  );
  console.log(`\nGate-verified completions per tier per hour — ${runsDir}`);
  console.log(
    `(${trials.length} trials; the /hr denominator includes failed trials' wall-clock)\n`,
  );
  console.log(formatCompletionsTable(result));
  const untimed = result.overall.trials - result.overall.timedTrials;
  if (untimed > 0) {
    console.log(
      `\nnote: ${untimed}/${result.overall.trials} trials had no recorded duration and don't count toward hours.`,
    );
  }
}

main();

/**
 * Flag per-scenario regressions between two eval run roots.
 *
 *   pnpm --filter @bendyline/gezel-evals run regression-flags <current-root> <baseline-root> [--ratio 2]
 *
 * Prints a Markdown table and exits 1 when anything is flagged, so a sweep
 * script can stop or annotate its report. See src/regression-flags.ts.
 */
import { existsSync } from 'node:fs';
import {
  collectTrials,
  regressionFlags,
  renderRegressionFlags,
  summarizeByScenario,
} from '../regression-flags.ts';

const args = process.argv.slice(2);
const ratioIndex = args.indexOf('--ratio');
const ratio = ratioIndex >= 0 ? Number(args[ratioIndex + 1]) : 2;
const roots = args.filter(
  (a, i) => !a.startsWith('--') && !(ratioIndex >= 0 && i === ratioIndex + 1),
);
const [current, baseline] = roots;

if (!current || !baseline || !existsSync(current) || !existsSync(baseline)) {
  console.error('usage: regression-flags <current-root> <baseline-root> [--ratio 2]');
  process.exit(2);
}
if (!Number.isFinite(ratio) || ratio <= 1) {
  console.error('--ratio must be a number greater than 1');
  process.exit(2);
}

const flags = regressionFlags(
  summarizeByScenario(collectTrials(current)),
  summarizeByScenario(collectTrials(baseline)),
  { ratio },
);
console.log(renderRegressionFlags(flags));
process.exitCode = flags.length > 0 ? 1 : 0;

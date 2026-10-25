import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { CRAFTBOOK_EVAL_SPECS } from '../craftbooks/specs.ts';
import { repoRoot } from '../native-bin.ts';
import { slugifyForDirName } from '../runner.ts';
import { STRATEGY_BENCHMARK_BOOKS } from '../strategy/books.ts';
import { LIVE_ONLY_FAILURE, recheckTrialFiles } from '../strategy/recheck.ts';
import { assertKnownFlags, parseArgs } from './args.ts';

/**
 * Re-judge finished strategy trials against their books' current test
 * checks, from the files each trial left on disk (strategy/recheck.ts).
 *
 *   GEZEL_GILDE_DATA_DIR=../gilde/data pnpm exec tsx evals/src/bin/strategy-recheck.ts \
 *     --runs-dir evals/runs/strategy-pilot-2026-10-23 --model qwen3.8-27b-q4 --books market-scan
 *
 * Per trial it prints the live verdict, the file-check failures under the
 * current tests, and the corrected P1: the task finished, the contract's
 * acceptance criteria passed, no file check fails, and no live failure the
 * re-check cannot reproduce (`LIVE_ONLY_FAILURE`) stood at the end.
 */

/** The final poll's failure list, from the trial log's last scenario line. */
async function liveFailures(trialDir: string, book: string): Promise<string[]> {
  const log = await readFile(join(trialDir, 'log.txt'), 'utf8').catch(() => '');
  const marker = `[scenario] craftbook-${book} `;
  const last = log
    .split('\n')
    .filter((line) => line.includes(marker))
    .at(-1);
  const failures = last?.split(' failures=')[1];
  return failures ? failures.split(' | ') : [];
}

const ARMS = ['stepwise', 'generalist', 'outcome', 'outcome-solo', 'outcome-bare'];

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, ['runs-dir', 'model', 'books']);
  const rootFlag = String(args.flags['runs-dir'] ?? '');
  if (!rootFlag) throw new Error('--runs-dir is required');
  const root = isAbsolute(rootFlag) ? rootFlag : join(repoRoot(), rootFlag);
  const models = String(args.flags.model ?? '')
    .split(',')
    .filter(Boolean);
  const books = args.flags.books
    ? String(args.flags.books).split(',').filter(Boolean)
    : [...STRATEGY_BENCHMARK_BOOKS];
  for (const modelId of models) {
    for (const book of books) {
      const spec = CRAFTBOOK_EVAL_SPECS.find((s) => s.craftbookId === book);
      if (!spec) throw new Error(`no eval spec for ${book}`);
      for (const arm of ARMS) {
        const scenarioDir = join(root, slugifyForDirName(modelId), arm, `craftbook-${book}`);
        const trials = await readdir(scenarioDir).catch(() => [] as string[]);
        for (const name of trials.filter((n) => !n.endsWith('.json'))) {
          const trialDir = join(scenarioDir, name);
          const result = await readJson<{ success?: boolean; reason?: string }>(
            join(trialDir, 'result.json'),
          );
          if (!result) continue;
          const contract = await readJson<{ status?: string; acceptancePassed?: boolean }>(
            join(trialDir, 'contract-grade.json'),
          );
          const failures = await recheckTrialFiles(trialDir, spec);
          const standing = result.success
            ? []
            : (await liveFailures(trialDir, book)).filter((f) => LIVE_ONLY_FAILURE.test(f));
          const corrected =
            contract?.status === 'complete' &&
            contract.acceptancePassed === true &&
            failures?.length === 0 &&
            standing.length === 0;
          console.log(
            [
              modelId,
              book,
              arm,
              `live=${result.success ? 'pass' : 'fail'}`,
              `corrected=${corrected ? 'pass' : 'fail'}`,
              `task=${contract?.status ?? '?'}`,
              failures === null ? 'recheck=n/a' : `fileFailures=${failures.length}`,
              ...(failures?.length ? [`first: ${failures[0]!.slice(0, 140)}`] : []),
              ...(standing.length ? [`live: ${standing[0]!.slice(0, 100)}`] : []),
            ].join('\t'),
          );
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

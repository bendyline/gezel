#!/usr/bin/env node
/**
 * Regenerate the all-results scorecard CSV from the shard directory.
 *
 *   pnpm scorecard:csv            # write it
 *   pnpm scorecard:csv --check    # fail if stale
 *
 * One row per run × suite × model × engine — pass rate, judge score, and
 * decode/prefill speed — written to docs/handboek/assets/scorecards/, where
 * the Handboek export publishes it beside the per-round downloads and the
 * model-scorecard article renders it as its all-results table. What each
 * column means, and why, lives with the formatter in
 * packages/core/src/scorecard/csv.ts.
 *
 * You rarely run this by hand: gen-scorecard-barrel.mjs calls it after every
 * write, and every new sweep already passes through the barrel (the eval
 * ingest regenerates it itself; the campaign importers end with
 * `pnpm scorecard:barrel`). core's csv.test.ts fails when the committed file
 * drifts from the shards, the same contract as the barrel's own check.
 *
 * It imports core's TypeScript, so it runs under tsx — `pnpm scorecard:csv`
 * goes through the dependency lease like the other scorecard scripts.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCORECARD_CSV_FILE, scorecardResultsCsv } from '../packages/core/src/scorecard/csv.ts';
import { ScorecardDatasetSchema } from '../packages/core/src/scorecard/schema.ts';
import { mergeShards } from '../packages/core/src/scorecard/shards.ts';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const scorecardCsvPath = (root = defaultRoot) =>
  join(root, 'docs', 'handboek', 'assets', 'scorecards', SCORECARD_CSV_FILE);

/** The CSV the shards on disk produce — the barrel is never consulted. */
export function renderScorecardCsv(root = defaultRoot) {
  const runsDir = join(root, 'packages', 'core', 'src', 'scorecard', 'data', 'runs');
  const shards = readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      ScorecardDatasetSchema.parse(JSON.parse(readFileSync(join(runsDir, name), 'utf8'))),
    );
  return scorecardResultsCsv(mergeShards(shards));
}

/** Write (or with `check`, compare) the CSV. Returns whether it was out of date. */
export function writeScorecardCsv({ root = defaultRoot, check = false } = {}) {
  const path = scorecardCsvPath(root);
  const next = renderScorecardCsv(root);
  const current = (() => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  })();
  const stale = current !== next;
  if (stale && !check) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }
  return { path, stale, rows: next.split('\n').length - 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  const { path, stale, rows } = writeScorecardCsv({ check });
  const where = relative(defaultRoot, path);
  if (check && stale) {
    console.error(`[scorecard-csv] ${where} is out of date — run \`pnpm scorecard:csv\`.`);
    process.exit(1);
  }
  console.log(
    check
      ? `[scorecard-csv] up to date (${rows} results)`
      : stale
        ? `[scorecard-csv] wrote ${where} (${rows} results)`
        : `[scorecard-csv] unchanged (${rows} results)`,
  );
}

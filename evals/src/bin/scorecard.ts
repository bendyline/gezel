#!/usr/bin/env -S npx tsx
/**
 * `pnpm eval:scorecard` — the standardized model scorecard sweep.
 *
 *   pnpm eval:scorecard --count 3
 *   pnpm eval:scorecard --count 3 --models gemma4-e4b-q4,qwen3.6-27b-q8
 *   pnpm eval:scorecard --ingest-only          # rebuild the dataset from disk
 *   pnpm eval:scorecard --list                 # what would run, and for how long
 *
 * The point of this script — as opposed to running `eval:all` twice by
 * hand — is that a published number has to be reproducible. It therefore
 * owns five things a manual run leaves to memory:
 *
 *  1. **One run identity.** Every model in an invocation is stamped with
 *     the same device, git sha, catalog pin, and trial count, so the
 *     resulting table is an apples-to-apples comparison by construction
 *     rather than by good intentions.
 *  2. **The full suite set, always.** Core and productivity, never a
 *     subset, so no model is ever ranked on an easier slice.
 *  3. **A fixed trial count** across every model. `--count 3` is the floor
 *     for quoting a rate at all (see MIN_TRIALS_FOR_RATE).
 *  4. **Failure attribution.** Infra/operator/grader failures are recorded
 *     and excluded, so a wedged engine never books as a model weakness.
 *  5. **Ingestion into the shipped dataset**, which the handboek articles
 *     render. Nothing is retyped between measuring and publishing.
 *
 * Adding a model later: run this again with `--models <new-id>` and the
 * SAME `--run-id`. It joins the existing table. Omit `--run-id` and it
 * starts a new sweep, which is the honest thing to do when the device or
 * the build has moved on.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema, buildSuiteScoreboard, describeProvenance } from '@bendyline/gezel';
import type { ScorecardDataset, ScorecardModelResult, ScorecardRun } from '@bendyline/gezel';
import { classifyEvalModelTier } from '../model-tier.ts';
import { defaultProvider } from '../providers.ts';
import {
  captureDevice,
  currentHarnessCommit,
  mergeScorecard,
  modelResultFromMatrix,
  resolvedGildeVersion,
  runIdFor,
} from '../scorecard.ts';
import { suiteScenarios } from '../suites.ts';
import type { MatrixSummary } from '../types.ts';
import { parseArgs } from './args.ts';
import { defaultModelRoots, discoverCachedModelInventory } from './model-coverage.ts';

/** The suites a scorecard always covers. Not configurable on purpose. */
const SCORECARD_SUITES = ['core', 'productivity'] as const;

/**
 * `--verify`: the shortest run that exercises every code path a published
 * sweep depends on, so the pipeline can be proven before committing a
 * device to hours of measuring.
 *
 * The set is chosen for COVERAGE OF UNPROVEN CODE, not for breadth:
 *   - `craftbook-research-to-document` — the DocBlocks mock, the DOCX
 *     fixture materialized into the artifacts drawer, and the
 *     `binaryDocument` container gate.
 *   - `craftbook-ab-test-readout` — the harness-owned arithmetic oracle
 *     over a locked-schema JSON.
 *   - `meeting-followup` — a hand-authored grader with per-row credit and
 *     two-deliverable repair routing.
 *
 * A verify run is NOT a scorecard: one trial per scenario, a scenario
 * subset, and it writes to a scratch dataset. It answers "does the
 * machinery work", never "how good is this model".
 */
const VERIFY_SCENARIOS = [
  'craftbook-research-to-document',
  'craftbook-ab-test-readout',
  'meeting-followup',
] as const;
const VERIFY_SUITE = 'productivity';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const publishedDatasetPath = join(repoRoot, 'packages/core/src/scorecard/data/scorecard.json');

function readDataset(path: string): ScorecardDataset {
  if (!existsSync(path)) {
    return ScorecardDatasetSchema.parse({ schemaVersion: 1, runs: [], results: [] });
  }
  return ScorecardDatasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function suiteBudgetMinutes(suiteId: string): number {
  return Math.round(
    suiteScenarios(suiteId).reduce((sum, scenario) => sum + (scenario.timeoutMs ?? 0), 0) / 60_000,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const verify = Boolean(args.flags.verify);
  // A verify run is pinned to one trial: it proves plumbing, and letting
  // it take a count would invite treating its output as a score.
  const count = verify ? 1 : Number(args.flags.count ?? 3);
  if (!Number.isInteger(count) || count < 1) {
    console.error('--count must be a positive integer (3 is the floor for quoting a rate)');
    process.exit(2);
  }

  const inventory = discoverCachedModelInventory(defaultModelRoots());
  const requested =
    typeof args.flags.models === 'string'
      ? args.flags.models
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : null;
  const models = requested
    ? inventory.cachedModels.filter((model) => requested.includes(model.id))
    : inventory.cachedModels;

  if (requested) {
    const missing = requested.filter((id) => !models.some((model) => model.id === id));
    if (missing.length > 0) {
      console.error(
        `[scorecard] not cached on this device: ${missing.join(', ')}\n` +
          `            cached: ${inventory.cachedModels.map((m) => m.id).join(', ') || '(none)'}`,
      );
      process.exit(2);
    }
  }

  // Pin the engine rather than inferring it. The cached-model inventory
  // only scans llama-cpp/ds4 roots, so it labelled an MLX run "llama-cpp" —
  // and on this harness MLX is the Apple Silicon default. Publishing the
  // wrong engine is not cosmetic: the two diverge materially on tool-loop
  // work, so a mislabelled table invites the wrong conclusion. Pinning it
  // also makes the sweep reproducible instead of platform-dependent.
  const provider =
    typeof args.flags.provider === 'string' ? args.flags.provider : defaultProvider();
  const device = captureDevice();
  const startedAt = args.flags['started-at']
    ? String(args.flags['started-at'])
    : new Date().toISOString();
  const runId = args.flags['run-id'] ? String(args.flags['run-id']) : runIdFor(startedAt, device);

  const suites = verify ? [VERIFY_SUITE] : [...SCORECARD_SUITES];
  const datasetPath = verify
    ? join(repoRoot, 'evals/runs/scorecard-verify/dataset.json')
    : publishedDatasetPath;
  const perModelMinutes = verify
    ? VERIFY_SCENARIOS.reduce((sum, id) => {
        const scenario = suiteScenarios(VERIFY_SUITE).find((entry) => entry.id === id);
        return sum + Math.round((scenario?.timeoutMs ?? 0) / 60_000);
      }, 0)
    : suites.reduce((sum, suite) => sum + suiteBudgetMinutes(suite) * count, 0);

  if (args.flags.list) {
    console.log(`Run id:      ${runId}`);
    console.log(`Device:      ${device.label} (${device.memoryGb} GB)`);
    console.log(`Engine:      ${provider}`);
    console.log(`Suites:      ${suites.join(', ')}`);
    console.log(`Trials:      ${count} per scenario`);
    if (verify) {
      console.log('Mode:        VERIFY — pipeline check, not a scorecard');
      console.log(`Dataset:     ${datasetPath}`);
      console.log(`Scenarios:   ${VERIFY_SCENARIOS.join(', ')}`);
    }
    for (const suite of verify ? [] : suites) {
      console.log(
        `  ${suite.padEnd(14)} ${suiteScenarios(suite).length} scenarios, <=${suiteBudgetMinutes(suite) * count} min/model`,
      );
    }
    console.log(`Models (${models.length}):`);
    for (const model of models) console.log(`  ${model.id}  [${model.engine}]`);
    // Report the ceiling honestly AND make it actionable. The number is
    // large because it sums authored timeouts, and core's is dominated by
    // the two-hour game anchors; a healthy model finishes far inside them.
    // The operational answer is not to shrink the suite but to accumulate
    // the sweep across sittings under one --run-id.
    const ceilingHours = Math.round((perModelMinutes * models.length) / 60);
    console.log(`\nWorst-case ceiling: ~${ceilingHours}h for all ${models.length} models.`);
    console.log(
      [
        'That is the sum of authored timeouts, not an estimate — healthy models finish well',
        'inside them. Run it in sittings and keep the SAME run id so every model lands in one',
        'comparable table:',
        '',
        `  pnpm eval:scorecard --count ${count} --run-id ${runId} --models ${models[0]?.id ?? '<id>'}`,
      ].join('\n'),
    );
    if (inventory.excludedCachedModels.length > 0) {
      console.log('\nExcluded (unsupported runtime):');
      for (const model of inventory.excludedCachedModels) {
        console.log(`  ${model.id} — ${model.reason}`);
      }
    }
    return;
  }

  if (models.length === 0) {
    console.error('[scorecard] no cached local models found — nothing to measure');
    process.exit(2);
  }

  const sweepRoot = join(repoRoot, 'evals/runs', `scorecard-${runId}`);
  mkdirSync(sweepRoot, { recursive: true });

  const results: ScorecardModelResult[] = [];
  const ingestOnly = Boolean(args.flags['ingest-only']);

  for (const model of models) {
    for (const suiteId of suites) {
      const matrixRoot = join(sweepRoot, model.id, suiteId);
      if (!ingestOnly) {
        console.log(`\n[scorecard] ${model.id} × ${suiteId} (${count} trials/scenario)`);
        const run = spawnSync(
          'pnpm',
          [
            'eval:all',
            '--suite',
            suiteId,
            ...(verify ? ['--scenarios', VERIFY_SCENARIOS.join(',')] : []),
            '--count',
            String(count),
            '--model',
            model.id,
            '--provider',
            provider,
            '--llm-judge',
            '--runs-dir',
            matrixRoot,
          ],
          { cwd: repoRoot, stdio: 'inherit' },
        );
        // `eval:all` exits 1 whenever the matrix is not 100% clean, which is
        // the NORMAL outcome for a real model — the whole point of measuring.
        // Gating ingestion on the exit code meant only a flawless model was
        // ever recorded, silently emptying the scorecard of everyone else.
        // The matrix summary's own `status` is the honest signal: `complete`
        // means it measured what it set out to, whatever the pass rate.
        // Exit 2 is an argument/setup error and has no summary to read.
        if (run.status === 2) {
          console.error(
            `[scorecard] ${model.id} × ${suiteId} failed to start (exit 2); skipping this cell`,
          );
          continue;
        }
      }

      const summaryPath = join(matrixRoot, 'summary.json');
      if (!existsSync(summaryPath)) {
        console.error(`[scorecard] no summary at ${summaryPath}; skipping`);
        continue;
      }
      const matrix = JSON.parse(readFileSync(summaryPath, 'utf8')) as MatrixSummary;
      if (matrix.status !== 'complete') {
        // Interrupted or short runs are an incomplete experiment, not a low
        // score. Recording them would understate the model.
        console.error(
          `[scorecard] ${model.id} × ${suiteId} finished ${matrix.status}; not ingesting a partial measurement`,
        );
        continue;
      }
      console.log(
        `[scorecard] ${model.id} × ${suiteId}: ${matrix.totalSuccesses}/${matrix.totalTrials} trials passed`,
      );
      results.push(
        modelResultFromMatrix(
          {
            modelId: model.id,
            label: model.id,
            engine: provider,
            tier: classifyEvalModelTier({ engine: provider as never, modelId: model.id }),
            suiteId,
            matrix,
            matrixRoot,
          },
          runId,
        ),
      );
    }
  }

  if (results.length === 0) {
    console.error('[scorecard] nothing ingested — dataset unchanged');
    process.exit(1);
  }

  const run: ScorecardRun = {
    id: runId,
    provenance: {
      startedAt,
      device,
      harnessCommit: currentHarnessCommit(repoRoot),
      gildeVersion: resolvedGildeVersion(repoRoot),
      count,
      // The judge model is recorded but never used for the headline pass
      // rate — see the scorecard schema header on judge drift.
      judgeModelId:
        typeof args.flags['judge-model'] === 'string' ? args.flags['judge-model'] : null,
    },
    suites,
    scenariosBySuite: Object.fromEntries(
      suites.map((suite) => [
        suite,
        verify ? [...VERIFY_SCENARIOS] : suiteScenarios(suite).map((s) => s.id),
      ]),
    ),
    ...(typeof args.flags.note === 'string' ? { note: args.flags.note } : {}),
  };

  const merged = mergeScorecard(readDataset(datasetPath), run, results);
  mkdirSync(dirname(datasetPath), { recursive: true });
  writeFileSync(datasetPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`\n[scorecard] wrote ${datasetPath}`);
  console.log(`[scorecard] ${describeProvenance(run)}`);

  for (const suiteId of suites) {
    const board = buildSuiteScoreboard(merged, suiteId);
    if (!board) continue;
    console.log(`\n${suiteId}`);
    for (const score of board.scores) {
      console.log(`  ${score.result.label.padEnd(28)} ${score.claim}`);
    }
  }
  if (verify) {
    console.log(
      '\nVERIFY run — the published dataset and the handboek articles are untouched.\n' +
        'What this proves: the runner spawns and ingests, failure attribution reads off disk,\n' +
        'and the new DocBlocks + arithmetic gates are winnable by a real model.',
    );
  } else {
    console.log('\nThe handboek articles render this dataset — no further edits needed.');
  }
}

main();

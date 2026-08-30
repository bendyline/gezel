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
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScorecardDatasetSchema, buildSuiteScoreboard, describeProvenance } from '@bendyline/gezel';
import type { ScorecardDataset, ScorecardModelResult, ScorecardRun } from '@bendyline/gezel';
import { classifyEvalModelTier, modelBillionsForEval } from '../model-tier.ts';
import { defaultProvider } from '../providers.ts';
import {
  captureDevice,
  currentHarnessCommit,
  discoverScorecardModels,
  mergeScorecard,
  modelResultFromMatrix,
  nodeScorecardFs,
  readJudgeSummary,
  readModelPerformance,
  resolveModelEngine,
  resolveScorecardStartedAt,
  resolvedGildeVersion,
  runIdFor,
} from '../scorecard.ts';
import { suiteScenarios } from '../suites.ts';
import type { MatrixSummary } from '../types.ts';
import { assertKnownFlags, parseArgs } from './args.ts';

/**
 * The suites a scorecard always covers. Not configurable on purpose.
 *
 * Four, not two, since `developer` and `complex-work` landed. The two new
 * suites are deliberately hard — they exist because the 27b/31b/35b class
 * saturates `core` (qwen3.8-27b at 33/33) and a wall of 32/33 cannot rank
 * the models we actually choose between. Expect low absolute numbers there
 * and read them as headroom, not as regressions.
 *
 * Two consequences for whoever runs the sweep, and the first is worse than
 * it looks. The ceiling this function sums is the AUTHORED one, but the
 * runner extends a deadline in 15-minute steps whenever hard progress moved
 * within the last 10 minutes, capped at 2x (`hardCeilingCapMs` in
 * runner.ts). That rule rarely fires on core — trials there pass early or
 * stall outright — and reliably fires on a hard suite, where a model grinds
 * without converging and looks like progress every ten minutes. Budget 2x
 * what `--list` prints for `developer` and `complex-work`.
 *
 * And a model far below the new suites' floor will book a long run of zeros
 * — probe with `--suite developer-smoke --count 1` first and skip the full
 * suite for models that score 0/3, recording that as unmeasured rather than
 * paying six hours (or twelve) to confirm it.
 */
const SCORECARD_SUITES = ['core', 'productivity', 'developer', 'complex-work'] as const;

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

function writeDataset(path: string, dataset: ScorecardDataset): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(dataset, null, 2)}\n`);

  // The published dataset is committed, so its generator must leave it in
  // the same shape enforced by `pnpm lint`. JSON.stringify expands every
  // array, while Biome keeps short arrays such as `suites` on one line.
  // Scratch verify datasets live under ignored run output and need no pass.
  if (path !== publishedDatasetPath) return;

  const biomeCli = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
  const formatted = spawnSync(
    process.execPath,
    [biomeCli, 'format', '--write', '--config-path', repoRoot, path],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (formatted.error) {
    throw new Error(`[scorecard] failed to run Biome for ${path}: ${formatted.error.message}`);
  }
  if (formatted.status !== 0) {
    const detail = formatted.stderr.trim() || formatted.stdout.trim();
    throw new Error(`[scorecard] Biome could not format ${path}${detail ? `:\n${detail}` : ''}`);
  }
}

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
  assertKnownFlags(args.flags, [
    'count',
    'gilde-version',
    'harness-commit',
    'ingest-only',
    'judge-model',
    'list',
    'models',
    'note',
    'run-id',
    'started-at',
    'verify',
  ]);
  const verify = Boolean(args.flags.verify);
  // A verify run is pinned to one trial: it proves plumbing, and letting
  // it take a count would invite treating its output as a score.
  const count = verify ? 1 : Number(args.flags.count ?? 3);
  if (!Number.isInteger(count) || count < 1) {
    console.error('--count must be a positive integer (3 is the floor for quoting a rate)');
    process.exit(2);
  }

  const forced = typeof args.flags.provider === 'string' ? args.flags.provider : undefined;
  const preferred = defaultProvider();
  const candidates = discoverScorecardModels(homedir(), nodeScorecardFs());
  const requested =
    typeof args.flags.models === 'string'
      ? args.flags.models
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : null;

  const uniqueIds = [...new Set(candidates.map((entry) => entry.id))].sort();
  const models: Array<{ id: string; engine: string }> = [];
  const skipped: string[] = [];
  for (const id of requested ?? uniqueIds) {
    const resolved = resolveModelEngine(candidates, id, {
      ...(forced ? { forced } : {}),
      preferred,
    });
    if (!resolved) {
      // Never silently switch engines. The engine is part of what a
      // published number MEANS, so an unavailable pairing is reported
      // rather than papered over — pinning one provider for every model
      // would have handed `--provider mlx` to a ds4-only model.
      skipped.push(forced ? `${id} (no ${forced} install)` : `${id} (no known engine install)`);
      continue;
    }
    models.push({ id, engine: resolved.engine });
  }

  if (requested && skipped.length > 0) {
    console.error(`[scorecard] cannot measure: ${skipped.join(', ')}`);
    console.error(`            available: ${uniqueIds.join(', ') || '(none)'}`);
    process.exit(2);
  }

  const device = captureDevice();
  const suites = verify ? [VERIFY_SUITE] : [...SCORECARD_SUITES];
  const datasetPath = verify
    ? join(repoRoot, 'evals/runs/scorecard-verify/dataset.json')
    : publishedDatasetPath;

  const explicitRunId = args.flags['run-id'] ? String(args.flags['run-id']) : undefined;
  const { startedAt, reusedFromRun } = resolveScorecardStartedAt({
    dataset: readDataset(datasetPath),
    runId: explicitRunId,
    explicitStartedAt: args.flags['started-at'] ? String(args.flags['started-at']) : undefined,
    now: new Date().toISOString(),
  });
  if (reusedFromRun) {
    console.log(`[scorecard] reusing recorded start ${startedAt} for run ${explicitRunId}`);
  }
  const runId = explicitRunId ?? runIdFor(startedAt, device);
  const perModelMinutes = verify
    ? VERIFY_SCENARIOS.reduce((sum, id) => {
        const scenario = suiteScenarios(VERIFY_SUITE).find((entry) => entry.id === id);
        return sum + Math.round((scenario?.timeoutMs ?? 0) / 60_000);
      }, 0)
    : suites.reduce((sum, suite) => sum + suiteBudgetMinutes(suite) * count, 0);

  if (args.flags.list) {
    console.log(`Run id:      ${runId}`);
    console.log(`Device:      ${device.label} (${device.memoryGb} GB)`);
    console.log(`Engine:      ${forced ?? `${preferred} preferred, per-model fallback`}`);
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
    for (const model of models) console.log(`  ${model.id.padEnd(30)} [${model.engine}]`);
    if (skipped.length > 0) {
      console.log(`\nSkipped (${skipped.length}):`);
      for (const entry of skipped) console.log(`  ${entry}`);
    }
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
    return;
  }

  if (models.length === 0) {
    console.error('[scorecard] no cached local models found — nothing to measure');
    process.exit(2);
  }

  const sweepRoot = join(repoRoot, 'evals/runs', `scorecard-${runId}`);
  mkdirSync(sweepRoot, { recursive: true });

  const results: ScorecardModelResult[] = [];
  /**
   * Cells that produced no measurement, with why.
   *
   * A skipped cell used to vanish into scrollback: the row simply had no
   * entry for that suite, which reads as "not measured yet" rather than
   * "we tried and could not". `mistral-7b-q4` lost its whole core cell to
   * a flaky probe in the 2026-08-22 sweep and the gap was only caught by
   * hand. Collected here and reprinted at the end, where the operator is
   * actually looking.
   */
  const unmeasured: Array<{ modelId: string; suiteId: string; reason: string }> = [];
  const ingestOnly = Boolean(args.flags['ingest-only']);

  /**
   * Persist after EVERY finished cell, not once at the end.
   *
   * A four-model sweep is ~22 hours; accumulating in memory and writing
   * once meant a crash at hour 20 discarded every completed measurement.
   * `mergeScorecard` replaces same (run, suite, model) entries, so
   * rewriting the growing set each time is idempotent and cheap.
   */
  const persist = (): void => {
    if (results.length === 0) return;
    const merged = mergeScorecard(readDataset(datasetPath), buildRun(), results);
    writeDataset(datasetPath, merged);
  };

  for (const model of models) {
    for (const suiteId of suites) {
      const matrixRoot = join(sweepRoot, model.id, suiteId);
      if (!ingestOnly) {
        console.log(`\n[scorecard] ${model.id} × ${suiteId} (${count} trials/scenario)`);
        // Spawn the cell through node + the lease runner, not the `pnpm`
        // shim: on Windows `spawnSync('pnpm', …)` cannot launch `pnpm.cmd`
        // without a shell, fails with a swallowed ENOENT, and every cell
        // books as "no summary.json was written" (wild-caught: the
        // 2026-08-27 win32 sweep lost all 8 cells this way).
        const runCell = (): ReturnType<typeof spawnSync> =>
          spawnSync(
            process.execPath,
            [
              join(repoRoot, 'scripts/run-with-dependency-lease.mjs'),
              '--direct-node',
              join(repoRoot, 'evals/src/bin/all.ts'),
              '--suite',
              suiteId,
              ...(verify ? ['--scenarios', VERIFY_SCENARIOS.join(',')] : []),
              '--count',
              String(count),
              // Honor the count for EVERY scenario. Without this the matrix
              // caps per-scenario trials at `suggestedTrials`, which is 1 for
              // every craftbook scenario — so a `--count 3` sweep quietly
              // measured six of thirteen productivity tasks exactly once and
              // the suite could not support a published rate.
              '--count-strict',
              '--model',
              model.id,
              '--provider',
              model.engine,
              // No inline --llm-judge: `eval:all` never read it (only bin/run.ts
              // does), so it rode along dead on every sweep while looking like
              // judging was wired. Judging is a post-hoc pass — see
              // `pnpm eval:judge-sweep --run-id <id>` — which is also what makes
              // one judge score the whole sweep instead of whatever the backend
              // resolved to at each cell's completion time.
              '--runs-dir',
              matrixRoot,
            ],
            { cwd: repoRoot, stdio: 'inherit' },
          );
        const run = runCell();
        // `eval:all` exits 1 whenever the matrix is not 100% clean, which is
        // the NORMAL outcome for a real model — the whole point of measuring.
        // Gating ingestion on the exit code meant only a flawless model was
        // ever recorded, silently emptying the scorecard of everyone else.
        // The matrix summary's own `status` is the honest signal: `complete`
        // means it measured what it set out to, whatever the pass rate.
        // Exit 2 is an argument/setup error and has no summary to read.
        // Exit 3 is a preflight exclusion, which can be transient: a model
        // with shaky tool-call adherence admits on one attempt and fails the
        // next. One retry costs a probe (~10s) and is the difference between
        // measuring the model and silently dropping it. A second exclusion is
        // treated as real and recorded, not swallowed.
        let attempt = run;
        if (attempt.status === 3) {
          console.error(
            `[scorecard] ${model.id} × ${suiteId} excluded by preflight; retrying once`,
          );
          attempt = runCell();
        }
        if (attempt.status === 3) {
          const reason = 'preflight excluded it twice (probe refused the model)';
          console.error(`[scorecard] ${model.id} × ${suiteId} ${reason}; not measured`);
          unmeasured.push({ modelId: model.id, suiteId, reason });
          continue;
        }
        if (attempt.status === 2) {
          const reason = 'failed to start (exit 2 — operator/setup error)';
          console.error(`[scorecard] ${model.id} × ${suiteId} ${reason}; not measured`);
          unmeasured.push({ modelId: model.id, suiteId, reason });
          continue;
        }
      }

      const summaryPath = join(matrixRoot, 'summary.json');
      if (!existsSync(summaryPath)) {
        console.error(`[scorecard] no summary at ${summaryPath}; skipping`);
        unmeasured.push({ modelId: model.id, suiteId, reason: 'no summary.json was written' });
        continue;
      }
      const matrix = JSON.parse(readFileSync(summaryPath, 'utf8')) as MatrixSummary;
      if (matrix.status !== 'complete') {
        // Interrupted or short runs are an incomplete experiment, not a low
        // score. Recording them would understate the model.
        console.error(
          `[scorecard] ${model.id} × ${suiteId} finished ${matrix.status}; not ingesting a partial measurement`,
        );
        unmeasured.push({
          modelId: model.id,
          suiteId,
          reason: `matrix finished ${matrix.status}, not complete`,
        });
        continue;
      }
      console.log(
        `[scorecard] ${model.id} × ${suiteId}: ${matrix.totalSuccesses}/${matrix.totalTrials} trials passed`,
      );
      // Preflight probes are CACHED per model+binary+host and reused across
      // cells, so a cell's probe routinely predates it by hours — an
      // anchored-on-the-cell window found nothing at all. The honest bound
      // is the sweep itself plus a lead margin: same machine, same binary,
      // same model, therefore the same measurement. Probes from an older
      // session (a different binary) stay excluded.
      const performance = readModelPerformance(
        join(repoRoot, 'evals/runs/preflight'),
        model.id,
        {
          fromIso: new Date(Date.parse(startedAt) - 6 * 60 * 60_000).toISOString(),
          toIso: matrix.finishedAt,
        },
        model.engine,
      );
      const judge = readJudgeSummary(sweepRoot, model.id, suiteId);
      results.push(
        modelResultFromMatrix(
          {
            modelId: model.id,
            ...(performance ? { performance } : {}),
            ...(judge ? { judge } : {}),
            label: model.id,
            engine: model.engine,
            tier: classifyEvalModelTier({ engine: model.engine as never, modelId: model.id }),
            // Real parameter count, not just the tier. The published table's
            // whole point is size-vs-family, and a Size column reading
            // "small" for both a 4B and a 9B hides the comparison it exists
            // to make.
            ...(() => {
              const billions = modelBillionsForEval(model.id);
              return billions ? { parameterSize: `${billions}B` } : {};
            })(),
            suiteId,
            matrix,
            matrixRoot,
          },
          runId,
        ),
      );
      persist();
    }
  }

  if (unmeasured.length > 0) {
    // Loud and last, because a missing cell is indistinguishable from an
    // un-run one once the sweep scrolls past. Naming the resume command
    // matters as much as naming the gap: the same --run-id merges the
    // recovered cell into the existing table rather than starting a
    // second, incomparable sweep.
    console.error(`\n[scorecard] ${unmeasured.length} cell(s) NOT MEASURED:`);
    for (const cell of unmeasured) {
      console.error(`  ${cell.modelId} × ${cell.suiteId} — ${cell.reason}`);
    }
    const ids = [...new Set(unmeasured.map((cell) => cell.modelId))].join(',');
    console.error(
      `  retry: pnpm eval:scorecard --count ${count} --run-id ${runId} --models ${ids}\n`,
    );
  }

  if (results.length === 0) {
    console.error('[scorecard] nothing ingested — dataset unchanged');
    process.exit(1);
  }

  function buildRun(): ScorecardRun {
    return {
      id: runId,
      provenance: {
        startedAt,
        device,
        // Overridable so a finished sweep can be re-ingested carrying the
        // code and content that actually produced it, rather than whatever
        // HEAD and the catalog pin happen to be at re-ingest time.
        harnessCommit:
          typeof args.flags['harness-commit'] === 'string'
            ? args.flags['harness-commit']
            : currentHarnessCommit(repoRoot),
        gildeVersion:
          typeof args.flags['gilde-version'] === 'string'
            ? args.flags['gilde-version']
            : resolvedGildeVersion(repoRoot),
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
  }

  const run = buildRun();
  persist();
  const merged = mergeScorecard(readDataset(datasetPath), run, results);
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

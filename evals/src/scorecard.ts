import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type {
  ScorecardCell,
  ScorecardDataset,
  ScorecardDevice,
  ScorecardModelResult,
  ScorecardRun,
} from '@bendyline/gezel';
import { ScorecardDatasetSchema } from '@bendyline/gezel';
import type { BatchSummary, FailureClass, MatrixSummary, TrialResult } from './types.ts';

/**
 * Turning finished matrix runs into the shippable scorecard dataset.
 *
 * Kept separate from the CLI so the interesting decisions — what counts
 * against a model, what may be merged with what — are unit-testable
 * without a six-hour sweep behind them.
 */

/** Failure classes that are NOT evidence about the model's capability. */
const NON_MODEL_CLASSES: ReadonlySet<FailureClass> = new Set(['infra', 'operator', 'grader']);

/**
 * Failure-mode fallback for trials whose `result.json` is unreadable.
 *
 * Deliberately conservative: only modes that are unambiguously not the
 * model's doing map to a non-model class. Anything else counts against the
 * model, because silently discarding a trial we cannot explain would
 * inflate every pass rate.
 */
const NON_MODEL_MODES = new Set([
  'interrupted',
  'crash',
  'engine-crash',
  'spawn-error',
  'engine-hung',
]);

export function readTrialFailureClass(
  matrixRoot: string,
  scenarioId: string,
  trialId: string,
): FailureClass | null {
  const path = join(matrixRoot, scenarioId, trialId, 'result.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrialResult>;
    return parsed.failureClass ?? null;
  } catch {
    return null;
  }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Build one model × scenario cell.
 *
 * `nonModelFailures` counts only FAILED trials with a non-model class — a
 * passing trial is never discarded, however it was classified.
 */
export function cellFromBatch(
  batch: Pick<BatchSummary, 'scenarioId' | 'trials' | 'successes' | 'perTrial'>,
  classify: (trialId: string) => FailureClass | null,
): ScorecardCell {
  let nonModelFailures = 0;
  for (const trial of batch.perTrial) {
    if (trial.success) continue;
    const explicit = classify(trial.trialId);
    const isNonModel = explicit
      ? NON_MODEL_CLASSES.has(explicit)
      : NON_MODEL_MODES.has(String(trial.failureMode ?? ''));
    if (isNonModel) nonModelFailures += 1;
  }
  const durations = batch.perTrial
    .map((trial) => trial.durationMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const medianDurationMs = median(durations);
  return {
    scenarioId: batch.scenarioId,
    trials: batch.trials,
    successes: batch.successes,
    nonModelFailures,
    ...(medianDurationMs !== undefined ? { medianDurationMs } : {}),
  };
}

export interface ModelIngestInput {
  modelId: string;
  label: string;
  engine: string;
  tier: string;
  suiteId: string;
  matrix: MatrixSummary;
  matrixRoot: string;
  parameterSize?: string;
  quantization?: string;
  grantedContextTokens?: number;
}

export function modelResultFromMatrix(
  input: ModelIngestInput,
  runId: string,
): ScorecardModelResult {
  const cells: ScorecardCell[] = [];
  for (const scenario of input.matrix.scenarios) {
    const batchPath = join(input.matrixRoot, scenario.summaryPath);
    let batch: BatchSummary | null = null;
    if (existsSync(batchPath)) {
      try {
        batch = JSON.parse(readFileSync(batchPath, 'utf8')) as BatchSummary;
      } catch {
        batch = null;
      }
    }
    if (!batch) {
      // No per-trial detail: record the cell from the matrix roll-up and
      // attribute nothing away. Better a slightly harsh number than a
      // silently forgiving one.
      cells.push({
        scenarioId: scenario.scenarioId,
        trials: scenario.trials,
        successes: scenario.successes,
        nonModelFailures: 0,
      });
      continue;
    }
    cells.push(
      cellFromBatch(batch, (trialId) =>
        readTrialFailureClass(input.matrixRoot, scenario.scenarioId, trialId),
      ),
    );
  }

  return {
    modelId: input.modelId,
    label: input.label,
    engine: input.engine,
    tier: input.tier,
    runId,
    suiteId: input.suiteId,
    cells,
    ...(input.parameterSize ? { parameterSize: input.parameterSize } : {}),
    ...(input.quantization ? { quantization: input.quantization } : {}),
    ...(input.grantedContextTokens ? { grantedContextTokens: input.grantedContextTokens } : {}),
  };
}

/** Capture the device identity a published number has to carry. */
export function captureDevice(): ScorecardDevice {
  const cpu = cpus()[0]?.model?.trim();
  const memoryGb = Math.round(totalmem() / 1024 ** 3);
  const label = cpu
    ? `${process.platform === 'darwin' ? 'Mac' : process.platform} · ${cpu}`
    : process.platform;
  return {
    label,
    platform: process.platform,
    arch: process.arch,
    memoryGb,
    osRelease: `${process.platform} ${release()}`,
    ...(cpu ? { cpuModel: cpu } : {}),
  };
}

export function currentHarnessCommit(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function resolvedGildeVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'packages/catalog/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    return pkg.dependencies?.['@bendyline/gilde'] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Merge a finished sweep into the dataset.
 *
 * Replaces any result for the same (run, suite, model) so a re-run of one
 * cell corrects the record rather than duplicating it, and keeps `runs`
 * newest-first. Never merges results ACROSS runs — that separation is the
 * whole comparability guarantee, and it is enforced here rather than left
 * to the caller's discipline.
 */
export function mergeScorecard(
  existing: ScorecardDataset,
  run: ScorecardRun,
  results: ScorecardModelResult[],
): ScorecardDataset {
  const runs = [run, ...existing.runs.filter((entry) => entry.id !== run.id)].sort((a, b) =>
    b.provenance.startedAt.localeCompare(a.provenance.startedAt),
  );
  const key = (r: ScorecardModelResult) => `${r.runId}::${r.suiteId}::${r.modelId}`;
  const incoming = new Set(results.map(key));
  const merged = [...existing.results.filter((r) => !incoming.has(key(r))), ...results];
  return ScorecardDatasetSchema.parse({
    schemaVersion: 1,
    runs,
    results: merged.sort(
      (a, b) =>
        b.runId.localeCompare(a.runId) ||
        a.suiteId.localeCompare(b.suiteId) ||
        a.modelId.localeCompare(b.modelId),
    ),
  });
}

/** Stable, human-readable run id: date + a device slug. */
export function runIdFor(startedAt: string, device: ScorecardDevice): string {
  const slug = device.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${startedAt.slice(0, 10)}-${slug}`;
}

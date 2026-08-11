import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  // A run's start time is immutable once recorded. Re-ingesting a finished
  // sweep (to pick up a reporting fix, say) must not restamp it with the
  // re-ingest time — that would silently redate a published measurement and
  // could reorder which run counts as the headline.
  const prior = existing.runs.find((entry) => entry.id === run.id);
  const preserved: ScorecardRun = prior
    ? { ...run, provenance: { ...run.provenance, startedAt: prior.provenance.startedAt } }
    : run;
  const runs = [preserved, ...existing.runs.filter((entry) => entry.id !== run.id)].sort((a, b) =>
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

/** A model this device can actually run, and the engine it would run on. */
export interface ScorecardModelCandidate {
  id: string;
  engine: string;
  root: string;
}

/** Filesystem seam so discovery is testable without a populated cache. */
export interface ScorecardFs {
  exists: (path: string) => boolean;
  listDirs: (path: string) => string[];
  listFiles: (path: string) => string[];
  readJson: (path: string) => Record<string, unknown> | null;
}

/**
 * Every local root a scorecard may draw models from.
 *
 * `model-coverage`'s `defaultModelRoots()` deliberately covers only the
 * llama-cpp and ds4 caches — the right denominator for ITS report. A
 * scorecard needs more: on Apple Silicon the harness defaults to MLX, so a
 * sweep built from the llama-cpp inventory alone both misses MLX-only
 * models and hands MLX-forced runs to models with no MLX weights.
 */
export function scorecardModelRoots(home: string): Array<{ root: string; engine: string }> {
  const roots: Array<{ root: string; engine: string }> = [];
  for (const base of ['.gezel-eval-cache', '.gezel-dev']) {
    for (const engine of ['llama-cpp', 'mlx', 'ds4']) {
      roots.push({ root: join(home, base, 'engines', engine, 'models'), engine });
    }
  }
  return roots;
}

/**
 * Discover installed models across every engine cache.
 *
 * Completeness is judged PER ENGINE because the layouts differ: llama.cpp
 * and ds4 name a single weights file in the manifest, while MLX ships
 * sharded safetensors with an index and no `weightsFilename` at all —
 * which is exactly why a llama-cpp-shaped probe skipped the entire MLX
 * cache and the sweep could not see 5 installed models.
 */
export function discoverScorecardModels(home: string, fs: ScorecardFs): ScorecardModelCandidate[] {
  const found = new Map<string, ScorecardModelCandidate>();
  for (const { root, engine } of scorecardModelRoots(home)) {
    if (!fs.exists(root)) continue;
    for (const id of fs.listDirs(root)) {
      const dir = join(root, id);
      const manifest = fs.readJson(join(dir, 'manifest.json'));
      if (!manifest) continue;
      // A manifest may name its own engine (ds4 entries do); otherwise the
      // cache root it sits in is authoritative.
      const declaredEngine = typeof manifest.engine === 'string' ? manifest.engine : engine;
      const weights = (manifest.weightsFilename ?? manifest.filename) as string | undefined;
      const complete =
        engine === 'mlx'
          ? fs.listFiles(dir).some((file) => file.endsWith('.safetensors'))
          : !!weights && fs.exists(join(dir, weights));
      if (!complete) continue;
      const key = `${declaredEngine} ${id}`;
      if (!found.has(key)) found.set(key, { id, engine: declaredEngine, root: dir });
    }
  }
  return [...found.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.engine.localeCompare(b.engine),
  );
}

/**
 * Choose the engine a model is measured on.
 *
 * The order is explicit rather than incidental, because the engine is part
 * of what a published number MEANS: a forced `--provider` wins, then the
 * platform default, then whatever the model is actually installed for. A
 * model that cannot run on a FORCED provider is skipped loudly — never
 * silently switched. Pinning one provider for every model was the bug this
 * replaces: it would have handed `--provider mlx` to a ds4-only model.
 */
export function resolveModelEngine(
  candidates: readonly ScorecardModelCandidate[],
  modelId: string,
  opts: { forced?: string; preferred: string },
): { engine: string; root: string } | null {
  const forModel = candidates.filter((entry) => entry.id === modelId);
  if (forModel.length === 0) return null;
  if (opts.forced) {
    const match = forModel.find((entry) => entry.engine === opts.forced);
    return match ? { engine: match.engine, root: match.root } : null;
  }
  const chosen = forModel.find((entry) => entry.engine === opts.preferred) ?? forModel[0]!;
  return { engine: chosen.engine, root: chosen.root };
}

/** Default filesystem implementation. */
export function nodeScorecardFs(): ScorecardFs {
  return {
    exists: (path) => existsSync(path),
    listDirs: (path) =>
      readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    listFiles: (path) =>
      readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    readJson: (path) => {
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };
}

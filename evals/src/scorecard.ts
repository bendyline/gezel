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
import { ScorecardDatasetSchema, inferredScorecardDeviceClass } from '@bendyline/gezel';
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

/** Context window + peak memory + KV precision a single trial actually used. */
function readTrialRuntime(
  matrixRoot: string,
  scenarioId: string,
  trialId: string,
): { contextTokens?: number; peakMemoryMb?: number; kvCacheType?: string } {
  const dir = join(matrixRoot, scenarioId, trialId);
  const out: { contextTokens?: number; peakMemoryMb?: number; kvCacheType?: string } = {};
  try {
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
      engineContext?: { grantedPerSlotTokens?: number; kvCacheType?: string };
    };
    const ctx = result.engineContext?.grantedPerSlotTokens;
    if (typeof ctx === 'number' && ctx > 0) out.contextTokens = ctx;
    const kv = result.engineContext?.kvCacheType;
    if (typeof kv === 'string' && kv) out.kvCacheType = kv;
  } catch {
    // absent or malformed — reported as unmeasured rather than guessed
  }
  try {
    const metrics = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8')) as {
      process?: { peakRssMb?: number };
    };
    const rss = metrics.process?.peakRssMb;
    if (typeof rss === 'number' && rss > 0) out.peakMemoryMb = Math.round(rss);
  } catch {
    // same
  }
  return out;
}

/** Most frequent value; ties resolve to the largest. */
/** The single value every sample agreed on, or undefined when they differ. */
function uniform(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const first = values[0]!;
  return values.every((v) => v === first) ? first : undefined;
}

function mode(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
}

/**
 * Read the post-hoc judge roll-up for one model × suite.
 *
 * Returns null when no judge pass has run, so the column simply does not
 * appear rather than showing a blank.
 */
export function readJudgeSummary(
  sweepRoot: string,
  modelId: string,
  suiteId: string,
): { meanScore: number; artifacts: number; judgeModel: string } | null {
  const path = join(sweepRoot, 'judge-report.json');
  if (!existsSync(path)) return null;
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as {
      perTrial?: Array<{ modelId: string; suiteId: string; meanScore: number; judgeModel: string }>;
    };
    const rows = (report.perTrial ?? []).filter(
      (row) => row.modelId === modelId && row.suiteId === suiteId,
    );
    if (rows.length === 0) return null;
    const meanScore = rows.reduce((sum, row) => sum + row.meanScore, 0) / rows.length;
    return {
      meanScore: Math.round(meanScore * 10) / 10,
      artifacts: rows.length,
      judgeModel: rows[0]!.judgeModel,
    };
  } catch {
    return null;
  }
}

export interface ModelIngestInput {
  /** Measured throughput on this device, when a probe was recorded. */
  performance?: { prefillTokensPerSec: number; decodeTokensPerSec: number; samples: number };
  /** Advisory judge roll-up, when a judge pass has run. */
  judge?: { meanScore: number; artifacts: number; judgeModel: string };
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
  const contexts: number[] = [];
  const memories: number[] = [];
  const kvTypes: string[] = [];
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
    for (const trialId of batch.trialIds ?? []) {
      const runtime = readTrialRuntime(input.matrixRoot, scenario.scenarioId, trialId);
      if (runtime.contextTokens) contexts.push(runtime.contextTokens);
      if (runtime.peakMemoryMb) memories.push(runtime.peakMemoryMb);
      if (runtime.kvCacheType) kvTypes.push(runtime.kvCacheType);
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
    ...(input.performance ? { performance: input.performance } : {}),
    ...(input.judge ? { judge: input.judge } : {}),
    // Context is the mode (the engine relaunches with the same grant);
    // memory is the median, so one outlier trial cannot set the figure.
    ...(() => {
      const contextTokens = mode(contexts);
      const peakMemoryMb = median(memories);
      // KV precision is a launch constant, so the mode is the value every
      // trial saw; it is reported only when the trials AGREE, because a
      // split would mean the cell mixed two cache regimes and no single
      // label is honest about it.
      const kvCacheType = uniform(kvTypes);
      return contextTokens && peakMemoryMb
        ? {
            runtime: {
              contextTokens,
              peakMemoryMb: Math.round(peakMemoryMb),
              ...(kvCacheType ? { kvCacheType } : {}),
            },
          }
        : {};
    })(),
  };
}

/** Capture the device identity a published number has to carry. */
export function captureDevice(): ScorecardDevice {
  const cpu = cpus()[0]?.model?.trim();
  const memoryGb = Math.round(totalmem() / 1024 ** 3);
  const detectedLabel = cpu
    ? `${process.platform === 'darwin' ? 'Mac' : process.platform} · ${cpu}`
    : process.platform;
  const device: ScorecardDevice = {
    label: detectedLabel,
    platform: process.platform,
    arch: process.arch,
    memoryGb,
    osRelease: `${process.platform} ${release()}`,
    ...(cpu ? { cpuModel: cpu } : {}),
  };
  return {
    ...device,
    label: inferredScorecardDeviceClass(device) ?? detectedLabel,
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
  // startedAt, the git sha, and the catalog pin all describe the world AS
  // MEASURED. Re-ingesting later — after a gilde bump or new commits — must
  // not restamp them with today's values; that would attribute results to
  // code and content that never produced them.
  const preserved: ScorecardRun = prior
    ? {
        ...run,
        provenance: {
          ...run.provenance,
          startedAt: prior.provenance.startedAt,
          harnessCommit: prior.provenance.harnessCommit,
          gildeVersion: prior.provenance.gildeVersion,
        },
      }
    : run;
  const runs = [preserved, ...existing.runs.filter((entry) => entry.id !== run.id)].sort((a, b) =>
    b.provenance.startedAt.localeCompare(a.provenance.startedAt),
  );
  // Engine is part of the identity: the same catalog model measured on two
  // engines is two measurements, not one. Without it, a llama-cpp + mlx
  // sweep of one model silently REPLACED the first engine's rows with the
  // second's (wild-caught: qwen3.8-27b-q4 in the 2026-08-25 quant-ladder
  // sweep — the mlx leg's ingest erased the llama leg's dataset rows).
  const key = (r: ScorecardModelResult) => `${r.runId}::${r.suiteId}::${r.modelId}::${r.engine}`;
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

/**
 * Average the preflight throughput probes recorded for one model.
 *
 * The harness probes once per cell and writes `preflight-report.json` into
 * a per-probe directory keyed by model and timestamp. Probes for the same
 * model on the same host agree closely (the 31B pair differed by 0.03
 * tok/s), so averaging is safe and reduces single-probe noise.
 *
 * Only probes inside the sweep's own window are used — an older probe from
 * a previous session describes a different machine state and must not be
 * published beside these results.
 */
/**
 * Resolve the `startedAt` a scorecard invocation should measure against.
 *
 * A fresh sweep starts now. But re-running against an EXISTING run id — an
 * `--ingest-only` rebuild, or joining a late model to an earlier table — must
 * reconstruct that run's own window: `readModelPerformance` bounds probes by
 * `startedAt - 6h … finishedAt`, so anchoring on today silently drops
 * throughput from every cell of an older run. Silently is the operative word:
 * a missing measurement doesn't error, the column just stops rendering.
 */
export function resolveScorecardStartedAt(opts: {
  dataset: Pick<ScorecardDataset, 'runs'>;
  runId?: string | undefined;
  explicitStartedAt?: string | undefined;
  now: string;
}): { startedAt: string; reusedFromRun: boolean } {
  if (opts.explicitStartedAt) return { startedAt: opts.explicitStartedAt, reusedFromRun: false };
  const prior = opts.runId
    ? opts.dataset.runs.find((run) => run.id === opts.runId)?.provenance.startedAt
    : undefined;
  return prior
    ? { startedAt: prior, reusedFromRun: true }
    : { startedAt: opts.now, reusedFromRun: false };
}

export function readModelPerformance(
  preflightRoot: string,
  modelId: string,
  window: { fromIso: string; toIso: string },
  engine?: string,
): { prefillTokensPerSec: number; decodeTokensPerSec: number; samples: number } | null {
  if (!existsSync(preflightRoot)) return null;
  const prefills: number[] = [];
  const decodes: number[] = [];
  // The probe directory slugifies the model id — `qwen3.6-27b-q4` lands as
  // `preflight-qwen3-6-27b-q4-...`. Matching the raw id silently yielded no
  // performance for every dotted model id while the probes sat on disk, and
  // a missing measurement is invisible: the column just stops rendering.
  // `makeTrialId` prefixes the provider for every engine EXCEPT the
  // historical llama-cpp default, so a ds4/mlx probe lands as
  // `preflight-ds4-<slug>-…`. Matching only the bare id dropped throughput
  // for every non-llama-cpp model — the same silent-empty-column failure the
  // dotted-id bug caused, one engine deeper.
  const slugs = [modelId, modelId.replace(/\./g, '-')];
  const prefixes = slugs.flatMap((slug) => [
    `preflight-${slug}-`,
    ...(engine && engine !== 'llama-cpp' ? [`preflight-${engine}-${slug}-`] : []),
  ]);
  for (const name of readdirSync(preflightRoot)) {
    // `preflight-<modelId>-<iso>-<suffix>`; the model id may itself contain
    // dashes, so anchor on the prefix rather than splitting.
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    if (!prefix) continue;
    const stamp = name.slice(prefix.length).replace(/-[a-z0-9]+$/, '');
    const iso = stamp.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
    if (iso < window.fromIso || iso > window.toIso) continue;
    const report = join(preflightRoot, name, 'preflight-report.json');
    if (!existsSync(report)) continue;
    try {
      const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
        promptTokensPerSec?: number | null;
        genTokensPerSec?: number | null;
      };
      if (typeof parsed.promptTokensPerSec === 'number' && parsed.promptTokensPerSec > 0) {
        prefills.push(parsed.promptTokensPerSec);
      }
      if (typeof parsed.genTokensPerSec === 'number' && parsed.genTokensPerSec > 0) {
        decodes.push(parsed.genTokensPerSec);
      }
    } catch {
      // A malformed probe is skipped, never guessed at.
    }
  }
  if (prefills.length === 0 || decodes.length === 0) return null;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    prefillTokensPerSec: Math.round(avg(prefills)),
    decodeTokensPerSec: Math.round(avg(decodes) * 10) / 10,
    samples: Math.min(prefills.length, decodes.length),
  };
}

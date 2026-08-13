/**
 * `pnpm --filter @bendyline/gezel-evals run batch <scenario> [<scenario>...] --count N [...flags]`
 *
 * Runs N trials of one or more scenarios. Same flag set as `run`, plus:
 *   --count <N>          number of trials per scenario (required)
 *   --parallel <K>       run trials in parallel chunks of K (default 1).
 *                        Applies WITHIN each scenario; scenarios still run
 *                        sequentially because two large models on the same
 *                        box cross-saturate VRAM and the per-scenario
 *                        success rate would lie.
 *   --skip-preflight     bypass the per-model admission probe (see
 *                        preflight.ts). For deliberate debugging of a
 *                        known-bad model configuration only.
 *   --triage-k <N>       auto-triage threshold: skip the rest of a cell
 *                        once N consecutive trials fail with an identical
 *                        signature (default 3; env GEZEL_EVAL_TRIAGE_K).
 *                        Only fires at --parallel 1.
 *   --no-triage          disable auto-triage (equivalent to --triage-k 0).
 *
 * One positional  → today's behavior. Output at `evals/runs/batch-<ts>/`.
 * Two or more     → matrix mode. Output at `evals/runs/matrix-<ts>/<scenarioId>/`
 *                   per scenario, plus an aggregate `summary.json` at the
 *                   matrix root.
 */
import { isSuccessfulBatch, isSuccessfulMatrix, runBatch, runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { assertLocalEngineSource } from '../model-sources.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import { installEvalSignalHandlers } from '../signal-handler.ts';
import { formatPassClaim } from '../stats-discipline.ts';
import { valueRequiredBatchFlagError } from './all-args.ts';
import {
  assertKnownFlags,
  parseArgs,
  parseDuration,
  printScenarios,
  resolveKeurmeesterFlag,
  resolveProviderFlag,
} from './args.ts';

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  assertKnownFlags(args.flags, [
    'cache-root',
    'count',
    'image-bin',
    'image-model',
    'list',
    'llm-judge',
    'llama-bin',
    'mlx-source-home',
    'model',
    'no-triage',
    'parallel',
    'runs-dir',
    'scenario',
    'skip-preflight',
    'timeout',
    'triage-k',
  ]);

  // parseArgs represents a bare long flag as boolean true. Number(true)
  // is 1, so without this guard `--count` accidentally launches one real
  // trial instead of failing as a missing-value CLI error.
  const valueFlagError = valueRequiredBatchFlagError(args.flags);
  if (valueFlagError) {
    console.error(valueFlagError);
    process.exit(2);
  }

  if (args.flags.list) {
    printScenarios(listScenarios());
    return;
  }

  const scenarioIds = args.positional;
  if (scenarioIds.length === 0) {
    console.error(
      'Usage: eval batch <scenarioId> [<scenarioId>...] --count N [--parallel K] [--model id] [--timeout 20m]',
    );
    printScenarios(listScenarios());
    process.exit(2);
  }

  const scenarios = scenarioIds.map((id) => getScenario(id));

  const count = Number(args.flags.count);
  if (!Number.isInteger(count) || count < 1) {
    console.error('--count must be a positive integer');
    process.exit(2);
  }
  const parallel = args.flags.parallel ? Number(args.flags.parallel) : 1;
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error('--parallel must be a positive integer');
    process.exit(2);
  }
  const triageK = args.flags['no-triage']
    ? 0
    : args.flags['triage-k'] !== undefined
      ? Number(args.flags['triage-k'])
      : undefined;
  if (triageK !== undefined && (!Number.isInteger(triageK) || triageK < 0)) {
    console.error('--triage-k must be a non-negative integer');
    process.exit(2);
  }
  const provider = resolveProviderFlag(args.flags) ?? defaultProvider();
  const modelId = String(args.flags.model ?? defaultModelFor(provider));
  assertLocalEngineSource(provider, modelId);
  const timeoutOverride = args.flags.timeout
    ? parseDuration(String(args.flags.timeout))
    : undefined;

  const deviceLock = acquireEvalDeviceLockIfNeeded({
    provider,
    scenarios,
    ...(args.flags['image-model'] ? { imageModelId: String(args.flags['image-model']) } : {}),
  });
  try {
    const keurmeester = resolveKeurmeesterFlag(args.flags);
    const ac = installEvalSignalHandlers();
    const opts = {
      modelId,
      count,
      parallel,
      engine: provider,
      ...(keurmeester ? { keurmeester } : {}),
      ...(args.flags['mlx-source-home']
        ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
        : {}),
      ...(args.flags['image-model'] ? { imageModelId: String(args.flags['image-model']) } : {}),
      ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {}),
      ...(args.flags['runs-dir'] ? { runsDir: String(args.flags['runs-dir']) } : {}),
      ...(args.flags['cache-root'] ? { cacheRoot: String(args.flags['cache-root']) } : {}),
      ...(args.flags['llama-bin'] ? { llamaBin: String(args.flags['llama-bin']) } : {}),
      ...(args.flags['image-bin'] ? { sdBin: String(args.flags['image-bin']) } : {}),
      ...(args.flags['skip-preflight'] ? { skipPreflight: true } : {}),
      ...(triageK !== undefined ? { triageK } : {}),
      signal: ac.signal,
    };

    if (scenarios.length === 1) {
      const summary = await runBatch(scenarios[0]!, opts);
      console.log('');
      console.log(
        `Batch ${summary.status} — ${formatPassClaim(summary.successes, summary.trials)}${summary.trials === summary.requestedTrials ? '' : `; ${summary.trials}/${summary.requestedTrials} requested trials recorded`}`,
      );
      process.exitCode = isSuccessfulBatch(summary) ? 0 : 1;
      return;
    }

    const matrix = await runMatrix(scenarios, opts);
    console.log('');
    console.log(
      `Matrix ${matrix.status} — ${formatPassClaim(matrix.totalSuccesses, matrix.totalTrials)} across ${matrix.scenarios.length}/${matrix.requestedScenarios.length} requested scenarios`,
    );
    process.exitCode = isSuccessfulMatrix(matrix) ? 0 : 1;
  } finally {
    deviceLock?.release();
  }
}

main().catch((err) => {
  console.error('[evals] fatal:', err);
  process.exit(2);
});

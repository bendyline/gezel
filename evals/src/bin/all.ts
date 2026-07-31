/**
 * `pnpm --filter @bendyline/gezel-evals run all --count N [...flags]`
 *
 * Run every registered scenario × N passes and write a single
 * cross-scenario aggregate. The matrix runner inside writes:
 *
 *   evals/runs/matrix-<ts>/
 *   ├── summary.json                 ← MatrixSummary (overall + per scenario)
 *   ├── tictactoe/
 *   │   ├── summary.json             ← BatchSummary
 *   │   └── tictactoe-<ts>-aaaa/     ← per-trial dir (log.txt, history.jsonl, …)
 *   └── petshop/
 *       ├── summary.json
 *       └── petshop-<ts>-cccc/
 *
 * Flags:
 *   --count <N>          trials per scenario (required)
 *   --parallel <K>       within a scenario, run trials in parallel chunks
 *                        of K (default 1). Scenarios themselves always run
 *                        sequentially.
 *   --scenarios a,b      comma-separated allowlist (default: all registered).
 *                        Useful when one scenario is broken and you want
 *                        the rest of the matrix to still complete.
 *   --suite <id>         run a named suite from src/suites.ts (core,
 *                        smoke, extended-coding, extended-grounding,
 *                        extended-retrieval, headroom). `core` is the
 *                        standard model scorecard. Mutually exclusive
 *                        with --scenarios.
 *   --model <id>         chat model catalog id, default `gemma4-e4b-q8`
 *   --image-model <id>   image model catalog id; falls back to each
 *                        scenario's `defaultImageModelId` when unset.
 *   --timeout <duration> override scenario.timeoutMs, e.g. `20m`, `300000`
 *   --runs-dir <path>    override the matrix root path
 *   --cache-root <path>  override `~/.gezel-eval-cache`
 *   --llama-bin <path>   override the auto-resolved llama-server binary
 *   --image-bin <path>   override the auto-resolved sd-server binary
 *   --list               list scenarios and exit
 *   --ignore-gpu-panic   proceed even if macOS recorded a recent GPU-driver
 *                        kernel panic (MLX engine only). Default: refuse to
 *                        auto-relaunch after a panic (crash-loop prevention).
 *                        Env: GEZEL_EVAL_IGNORE_GPU_PANIC=1.
 */
import { isSuccessfulMatrix, runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { checkGpuPanicGate } from '../gpu-panic-guard.ts';
import { assertLocalEngineSource } from '../model-sources.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import { formatPassClaim } from '../stats-discipline.ts';
import { listSuites, suiteScenarios } from '../suites.ts';
import { valueRequiredAllFlagError } from './all-args.ts';
import {
  parseArgs,
  parseDuration,
  printScenarios,
  resolveKeurmeesterFlag,
  resolveProviderFlag,
  resolveRenderModeFlag,
} from './args.ts';

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(
        `\n[evals] ${sig} received — aborting current trial gracefully (Ctrl+C again to force-exit)`,
      );
      ac.abort();
    } else {
      console.error('[evals] second signal — forcing exit');
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // parseArgs represents a bare long flag as boolean `true`. For flags
  // whose value is required, accepting that sentinel is dangerous:
  // Number(true) is 1, so bare `--count` previously launched a real
  // one-trial matrix, while bare `--scenarios` silently selected every
  // registered scenario.
  const valueFlagError = valueRequiredAllFlagError(args.flags);
  if (valueFlagError) {
    console.error(valueFlagError);
    process.exit(2);
  }

  if (args.flags.list) {
    printScenarios(listScenarios());
    console.log('\nAvailable suites (--suite <id>):');
    for (const suite of listSuites()) {
      console.log(`  ${suite.id.padEnd(20)} [${suite.scenarios.length}] ${suite.description}`);
    }
    return;
  }

  // Scenario selection: `--suite <id>` or `--scenarios a,b`, otherwise all
  // registered. Mutually exclusive — a suite is a curated set; silently
  // intersecting it with an ad-hoc list would misreport what ran.
  if (args.flags.suite !== undefined && args.flags.scenarios !== undefined) {
    console.error('--suite and --scenarios are mutually exclusive');
    process.exit(2);
  }
  if (args.flags.suite === true) {
    console.error('--suite requires a value (run with --list to see suites)');
    process.exit(2);
  }
  const filter =
    typeof args.flags.scenarios === 'string'
      ? args.flags.scenarios
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const scenarios =
    typeof args.flags.suite === 'string'
      ? suiteScenarios(args.flags.suite)
      : filter
        ? filter.map((id) => getScenario(id))
        : listScenarios();
  if (scenarios.length === 0) {
    console.error('[evals] no scenarios registered — nothing to run');
    process.exit(2);
  }

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

  // macOS GPU kernel-panic guard. Heavy MLX Metal sweeps can trip a latent
  // Apple GPU-driver panic (IOGPUMemory underflow). If macOS recorded a recent
  // GPU-driver panic, refuse to auto-relaunch — a re-run risks another panic +
  // reboot loop — unless the operator overrides. Crash-loop prevention; see
  // gpu-panic-guard.ts.
  const panicGate = checkGpuPanicGate({
    engine: provider,
    ignore: Boolean(args.flags['ignore-gpu-panic']),
  });
  if (panicGate.block) {
    console.error(panicGate.message);
    process.exit(2);
  }

  const timeoutOverride = args.flags.timeout
    ? parseDuration(String(args.flags.timeout))
    : undefined;
  const parseCsv = (v: unknown): string[] =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const forceBehaviors = parseCsv(args.flags['force-behaviors']);
  const removeBehaviors = parseCsv(args.flags['remove-behaviors']);
  const renderMode = resolveRenderModeFlag(args.flags);
  const keurmeester = resolveKeurmeesterFlag(args.flags);

  const deviceLock = acquireEvalDeviceLockIfNeeded({
    provider,
    scenarios,
    ...(args.flags['image-model'] ? { imageModelId: String(args.flags['image-model']) } : {}),
  });
  try {
    const ac = installSignalHandlers();
    const matrix = await runMatrix(scenarios, {
      modelId,
      count,
      parallel,
      ...(forceBehaviors.length > 0 ? { forceBehaviors } : {}),
      ...(removeBehaviors.length > 0 ? { removeBehaviors } : {}),
      engine: provider,
      ...(renderMode ? { executionDensity: renderMode } : {}),
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
      // Preflight's own exclusion message tells the operator to "pass
      // --skip-preflight to override", so the flag has to work on the command
      // that printed it — it was only wired into `batch`, making that advice a
      // silent no-op here.
      ...(args.flags['skip-preflight'] ? { skipPreflight: true } : {}),
      ...(triageK !== undefined ? { triageK } : {}),
      signal: ac.signal,
    });

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

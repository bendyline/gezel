/**
 * `pnpm --filter @bendyline/gezel-evals run run <scenario> [...flags]`
 *
 * Runs a single trial. Positional argument is the scenario id (`tictactoe`).
 * Flags:
 *   --model <id>         chat model catalog id, default `gemma4-e4b-q4`
 *   --image-model <id>   image model catalog id (e.g. `sdxl-base-1.0`).
 *                        Default comes from scenario.defaultImageModelId.
 *   --timeout <duration> override scenario.timeoutMs, e.g. `5m`, `30s`, `300000`.
 *                        Absolute — not throughput-scaled.
 *   --decode-rate <n>    measured decode tok/s, scales the scenario's authored
 *                        ceiling for a slow model (batch runs read this from
 *                        preflight; a single trial has no probe to read).
 *   --runs-dir <path>    override `<repo>/evals/runs/`
 *   --cache-root <path>  override `~/.gezel-eval-cache`
 *   --llama-bin <path>   override the auto-resolved llama-server binary
 *   --image-bin <path>   override the auto-resolved sd-server binary
 *   --list               list scenarios and exit
 */
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { assertLocalEngineSource } from '../model-sources.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import { runTrial } from '../runner.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import { installEvalSignalHandlers } from '../signal-handler.ts';
import { maybeJudgeTrial } from '../trial-llm-judge.ts';
import type { EvalScenario } from '../types.ts';
import {
  assertKnownFlags,
  parseArgs,
  parseDuration,
  printScenarios,
  resolveKeurmeesterFlag,
  resolveProviderFlag,
  resolveRenderModeFlag,
} from './args.ts';

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  assertKnownFlags(args.flags, [
    'cache-root',
    'decode-rate',
    'force-behaviors',
    'image-bin',
    'image-model',
    'list',
    'llama-bin',
    'llm-judge',
    'mlx-source-home',
    'model',
    'remove-behaviors',
    'runs-dir',
    'timeout',
  ]);

  if (args.flags.list) {
    printScenarios(listScenarios());
    return;
  }

  const scenarioId = args.positional[0];
  if (!scenarioId) {
    console.error('Usage: eval run <scenarioId> [--model id] [--timeout 20m] [--list]');
    printScenarios(listScenarios());
    process.exit(2);
  }

  const scenario = getScenario(scenarioId);
  const provider = resolveProviderFlag(args.flags) ?? defaultProvider();
  const modelId = String(args.flags.model ?? defaultModelFor(provider));
  // Fail fast when the chosen local engine has no weights for this model
  // (e.g. the Apple-Silicon MLX default against a GGUF-only catalog entry).
  assertLocalEngineSource(provider, modelId);
  const timeoutOverride = args.flags.timeout
    ? parseDuration(String(args.flags.timeout))
    : undefined;
  const decodeRateOverride = args.flags['decode-rate']
    ? Number(args.flags['decode-rate'])
    : undefined;
  if (decodeRateOverride !== undefined && !(decodeRateOverride > 0)) {
    throw new Error(`--decode-rate must be a positive number, got "${args.flags['decode-rate']}"`);
  }
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
    scenarios: [scenario],
    ...(args.flags['image-model'] ? { imageModelId: String(args.flags['image-model']) } : {}),
  });
  try {
    const ac = installEvalSignalHandlers('trial');
    const result = await runTrial(scenario, {
      modelId,
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
      ...(decodeRateOverride !== undefined ? { decodeRateTokensPerSec: decodeRateOverride } : {}),
      ...(args.flags['runs-dir'] ? { runsDir: String(args.flags['runs-dir']) } : {}),
      ...(args.flags['cache-root'] ? { cacheRoot: String(args.flags['cache-root']) } : {}),
      ...(args.flags['llama-bin'] ? { llamaBin: String(args.flags['llama-bin']) } : {}),
      ...(args.flags['image-bin'] ? { sdBin: String(args.flags['image-bin']) } : {}),
      signal: ac.signal,
    });

    // runTrial has shut down its daemon/native children before resolving.
    // The optional judge is cloud-only post-processing, so do not reserve the
    // local device while it runs. release() is idempotent for the finally path.
    deviceLock?.release();

    // Optional advisory LLM-as-judge pass. Runs AFTER the trial so it
    // can read the final artifact from disk; never blocks the harness
    // exit code. Output lands at <runDir>/llm-judge.json and score-trial
    // surfaces it as a parallel qualitative section in the postmortem.
    if (args.flags['llm-judge']) {
      await maybeJudgeTrial({ scenario, runDir: result.runDir });
    }

    console.log('');
    console.log(`Trial ${result.success ? 'PASSED' : 'FAILED'} — ${result.reason}`);
    console.log(`  trialId:  ${result.trialId}`);
    console.log(`  duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  runDir:   ${result.runDir}`);
    process.exitCode = result.success ? 0 : 1;
  } finally {
    deviceLock?.release();
  }
}

main().catch((err) => {
  console.error('[evals] fatal:', err);
  process.exit(2);
});

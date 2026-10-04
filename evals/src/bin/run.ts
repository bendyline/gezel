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
 *   --offline            refuse providers or model setup that could use the network
 *   --llama-bin <path>   override the auto-resolved llama-server binary
 *   --image-bin <path>   override the auto-resolved sd-server binary
 *   --reasoning-budget <n> override llama.cpp thinkingBudget for a controlled tuning trial
 *   --reasoning-effort <v> override llama.cpp chat-template reasoning_effort
 *   --source-home <dir>  read local models from this gezel home; never download
 *   --write-reports      write score.json + postmortem.md when the trial ends
 *   --retrieval <mode>   retrieval arm (off|lean|balanced|deep), with
 *                        --references/--embeddings/--library-recall on|off
 *   --list               list scenarios and exit
 */
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { assertLocalEngineSource } from '../model-sources.ts';
import { writeTrialReport } from '../postmortem-report.ts';
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
  resolveGeneralistFlag,
  resolveKeurmeesterFlag,
  resolveProviderFlag,
  resolveRepairPolicyFlag,
  resolveRetrievalFlags,
} from './args.ts';

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  assertKnownFlags(args.flags, [
    'cache-root',
    'decode-rate',
    'embeddings',
    'force-behaviors',
    'image-bin',
    'image-model',
    'library-recall',
    'list',
    'llama-bin',
    'llm-judge',
    'mlx-source-home',
    'model',
    'offline',
    'references',
    'reasoning-budget',
    'reasoning-effort',
    'remove-behaviors',
    'retrieval',
    'runs-dir',
    'source-home',
    'timeout',
    'write-reports',
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
  const reasoningBudgetOverride = args.flags['reasoning-budget']
    ? Number(args.flags['reasoning-budget'])
    : undefined;
  if (
    reasoningBudgetOverride !== undefined &&
    (!Number.isSafeInteger(reasoningBudgetOverride) || reasoningBudgetOverride <= 0)
  ) {
    throw new Error(
      `--reasoning-budget must be a positive integer, got "${args.flags['reasoning-budget']}"`,
    );
  }
  const reasoningEffortOverride =
    typeof args.flags['reasoning-effort'] === 'string'
      ? args.flags['reasoning-effort'].trim()
      : undefined;
  if (args.flags['reasoning-effort'] && !reasoningEffortOverride) {
    throw new Error('--reasoning-effort must be a non-empty value');
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
  const generalistMode = resolveGeneralistFlag(args.flags);
  const retrieval = resolveRetrievalFlags(args.flags);
  const repairPolicy = resolveRepairPolicyFlag(args.flags);
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
      ...(generalistMode ? { generalistMode } : {}),
      ...(retrieval ? { retrieval } : {}),
      ...(repairPolicy ? { repairPolicy } : {}),
      ...(keurmeester ? { keurmeester } : {}),
      ...(args.flags['mlx-source-home']
        ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
        : {}),
      ...(typeof args.flags['source-home'] === 'string'
        ? { modelSourceHome: args.flags['source-home'] }
        : {}),
      ...(args.flags['image-model'] ? { imageModelId: String(args.flags['image-model']) } : {}),
      ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {}),
      ...(decodeRateOverride !== undefined ? { decodeRateTokensPerSec: decodeRateOverride } : {}),
      ...(reasoningBudgetOverride !== undefined
        ? { llamaCppReasoningBudgetTokens: reasoningBudgetOverride }
        : {}),
      ...(reasoningEffortOverride ? { llamaCppReasoningEffort: reasoningEffortOverride } : {}),
      ...(args.flags['runs-dir'] ? { runsDir: String(args.flags['runs-dir']) } : {}),
      ...(args.flags['cache-root'] ? { cacheRoot: String(args.flags['cache-root']) } : {}),
      ...(args.flags.offline ? { offline: true } : {}),
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
    if (args.flags['write-reports']) {
      const report = await writeTrialReport(result.runDir, { force: true });
      if (report.score)
        console.log(`  composite: ${report.score.composite} (${report.score.band})`);
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

/**
 * Ollama-backed eval runner. Bypasses the llama.cpp binary + model-cache
 * machinery in `runner.ts` for environments that already have Ollama
 * running with the target model pulled. Reuses every scenario unchanged.
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/run-ollama.ts <scenarioId> [--model <ollama-tag>] [--timeout <duration>]
 *
 * Defaults:
 *   --model    gemma4:26b
 *   --timeout  scenario.timeoutMs
 *
 * Designed for migration validation: the chat manager + behavior
 * registry + provider gates exercise live, against a real local
 * model, without rebuilding native binaries every session.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { startAutoAnswerer } from '../auto-answer.ts';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { TrialLogger } from '../logging.ts';
import { repoRoot } from '../native-bin.ts';
import { captureFinalState } from '../runner.ts';
import { getScenario, listScenarios } from '../scenarios/index.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';
import type { EvalScenario, SuccessCheckResult } from '../types.ts';
import { parseArgs, parseDuration, printScenarios } from './args.ts';

function makeTrialId(scenarioId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${scenarioId}-ollama-${ts}-${rand}`;
}

async function ensureMeester(
  client: import('@bendyline/gezel-client/node').GezelClient,
): Promise<string> {
  const cfg = await client.getConfig();
  if (cfg.meesterGezelId) {
    const list = await client.listGezels();
    if (list.gezels.some((g) => g.id === cfg.meesterGezelId)) return cfg.meesterGezelId;
  }
  const list = await client.listGezels();
  const fallback = list.gezels[0];
  if (!fallback) throw new Error('no gezels available — did first-run bootstrap run?');
  return fallback.id;
}

async function pollUntilDone(
  scenario: EvalScenario,
  args: {
    client: import('@bendyline/gezel-client/node').GezelClient;
    meesterId: string;
    log: (msg: string) => void;
    pollIntervalMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<{ success: boolean; reason: string; failureMode?: 'timeout' | 'scenario-failed' }> {
  const deadline = Date.now() + args.timeoutMs;
  // Mirror runner.ts's per-trial dedup map so the ollama runner's
  // scenarios get the same noise reduction + failReason surfacing.
  const seenLines = new Map<string, string>();
  const logChanged = (key: string, line: string): void => {
    if (seenLines.get(key) === line) return;
    seenLines.set(key, line);
    args.log(line);
  };
  while (Date.now() < deadline) {
    if (args.signal?.aborted) {
      return { success: false, reason: 'aborted by signal', failureMode: 'timeout' };
    }
    const verdict: SuccessCheckResult = await scenario.successCheck({
      client: args.client,
      meesterId: args.meesterId,
      log: args.log,
      logChanged,
    });
    if (verdict.done) {
      return { success: verdict.success, reason: verdict.reason };
    }
    await wait(args.pollIntervalMs);
  }
  return { success: false, reason: `timed out after ${args.timeoutMs}ms`, failureMode: 'timeout' };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.flags.list) {
    printScenarios(listScenarios());
    return;
  }

  const scenarioId = args.positional[0];
  if (!scenarioId) {
    console.error('Usage: run-ollama <scenarioId> [--model <ollama-tag>] [--timeout 20m]');
    printScenarios(listScenarios());
    process.exit(2);
  }

  const scenario = getScenario(scenarioId);
  // Ollama owns its own server lifecycle, but it is still a local model
  // workload competing for the same device as native llama/MLX evals.
  const deviceLock = acquireEvalDeviceLock();
  const ollamaModel = String(args.flags.model ?? 'gemma4:26b');
  const ollamaUrl = String(args.flags['ollama-url'] ?? 'http://127.0.0.1:11434');
  // Ollama driver uses fixed wall-clock timeouts (the progress-driven
  // path lives in `runner.ts`'s `pollUntilDone`). Default to 30 min
  // when the scenario doesn't set a hard cap — generous enough for
  // ollama-routed trials, well below the 8h evals ceiling.
  const timeoutMs = args.flags.timeout
    ? parseDuration(String(args.flags.timeout))
    : (scenario.timeoutMs ?? 30 * 60 * 1000);

  const trialId = makeTrialId(scenario.id);
  const runsDir = join(repoRoot(), 'evals', 'runs');
  const runDir = join(runsDir, trialId);
  await mkdir(runDir, { recursive: true });

  const trialHome = await mkdtemp(join(tmpdir(), `gezel-eval-${scenario.id}-`));
  const startedAt = Date.now();

  const logger = new TrialLogger({ runDir, gezelHome: trialHome });
  await logger.init();
  const log = logger.log;

  log(`[trial] id=${trialId} scenario=${scenario.id} model=ollama:${ollamaModel}`);
  log(`[trial] runDir=${runDir}`);
  log(`[trial] trialHome=${trialHome}`);
  log(`[trial] ollamaUrl=${ollamaUrl}`);

  // Spawn the daemon. We pass an empty llamaBin path because the
  // ollama provider doesn't read it; the env var is harmless when set
  // to a non-existent path as long as we don't select llama-cpp.
  const spawned = await spawnTrialDaemon({
    home: trialHome,
    llamaBin: '/dev/null',
    stderrLogPath: join(runDir, 'daemon.log'),
    timeoutMs: 60_000,
    extraEnv: { GEZEL_OLLAMA_BASE_URL: ollamaUrl },
  });
  log(`[trial] daemon spawned pid=${spawned.pid} port=${spawned.baseUrl}`);

  const client = spawned.client;
  let success = false;
  let reason = 'trial did not produce a terminal result';
  let failureMode: string | undefined = 'crash';

  try {
    await client.updateConfig({
      provider: 'ollama',
      defaultModel: { ollama: ollamaModel },
      firstRunCompleted: true,
      // `proactive` is required for the voorman-idle stall detection
      // and ambient nudges (see tasks/scheduler.ts) — without this
      // the trial daemon defaults to `reactive`, the voorman writes a
      // plan, says "I'll do step 1 next", and silently halts. The
      // unattended eval has no user to nudge it back to action; the
      // ambient nudge is the only path that lights a fire.
      aiEngagementMode: 'proactive',
      // Tighten ambient-nudge cadence for evals. Defaults are tuned
      // for an attended user session (30 min first-nudge grace, 5 min
      // rapid interval) — those are too long for a 25 min unattended
      // trial. With the eval cadence, a stuck developer who wrote a
      // plan and stopped gets pinged ~60s later rather than ~30 min.
      projectNudge: {
        firstNudgeGraceMs: 60_000,
        rapidIntervalMs: 90_000,
      },
    });
    log(
      `[trial] provider=ollama model=${ollamaModel} configured, firstRunCompleted=true engagement=proactive`,
    );

    const meesterId = await ensureMeester(client);
    log(`[trial] meester=${meesterId}`);

    logger.startHistoryTail();
    const stopAutoAnswerer = startAutoAnswerer({ client, meesterId, log });

    if (scenario.skipInitialPrompt) {
      log('[trial] skipped initial meester prompt (scenario setup already kicked off work)');
    } else {
      await client.sendChatMessage(meesterId, {
        message: scenario.prompt,
        projectId: 'default',
      });
      log(`[trial] sent prompt to meester (${scenario.prompt.length} chars)`);
    }

    try {
      const verdict = await pollUntilDone(scenario, {
        client,
        meesterId,
        log,
        pollIntervalMs: 5_000,
        timeoutMs,
      });
      success = verdict.success;
      reason = verdict.reason;
      failureMode = verdict.failureMode;
    } finally {
      await stopAutoAnswerer();
    }
  } catch (err) {
    success = false;
    reason = `runner crashed: ${err instanceof Error ? err.message : String(err)}`;
    failureMode = 'crash';
    log(`[trial] crash: ${reason}`);
  } finally {
    // Snapshot artifacts/, workspace/, sessions/, project-history/, and
    // state.json into the run dir BEFORE shutting down the daemon —
    // the trial home gets wiped at process exit, and without this
    // capture the user has only `log.txt` + `history.jsonl` to work
    // with (no actual deliverables, no per-gezel chat sessions).
    // Best-effort: failures here are logged but don't change the
    // success verdict.
    try {
      await captureFinalState({ client, trialHome, runDir, log });
    } catch (err) {
      log(
        `[capture] final state snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await shutdownTrialDaemon(spawned);
    await logger.stop();
    const durationMs = Date.now() - startedAt;
    const result = {
      trialId,
      scenarioId: scenario.id,
      success,
      reason,
      ...(failureMode ? { failureMode } : {}),
      modelId: `ollama:${ollamaModel}`,
      durationMs,
      startedAt: new Date(startedAt).toISOString(),
    };
    await writeFile(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    log(`[trial] result: success=${success} reason=${reason} duration=${durationMs}ms`);
  }

  console.log('');
  console.log(`Result: ${success ? 'PASS' : 'FAIL'} — ${reason}`);
  console.log(`Run dir: ${runDir}`);
  deviceLock.release();
  process.exitCode = success ? 0 : 1;
}

main().catch((err) => {
  console.error('[evals] fatal:', err);
  process.exit(1);
});

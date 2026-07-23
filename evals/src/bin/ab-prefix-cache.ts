/**
 * A/B micro-harness for the layered prefix cache (`config.layeredPrefixCache`).
 *
 * Measures the CROSS-SESSION prefill win that the flag is designed to
 * deliver. A single agentic trial can't show it: within one session the
 * system prompt is frozen, so BOTH arms reuse the prefix turn-to-turn. The
 * win is a *new* session, same gezel+project but DIFFERENT volatile state
 * (task/workspace/recall), inheriting the warm `[system+tools]` prefix.
 *
 * Experiment (per arm, on `gemma4-e4b-q8` / llama-cpp, `--parallel 1`):
 *   1. spawn one daemon against a shared GEZEL_HOME
 *   2. session A scoped to task T1 → send → wait (cold; seeds the prefix
 *      file when A's slot is recycled for B)
 *   3. session B scoped to task T2 (different task → different volatile) →
 *      send → wait
 *   4. parse daemon.log `prompt eval time = … / N tokens` per request
 *
 * Expectation:
 *   - baseline (flag OFF): B's prompt-eval tokens ≈ A's — the whole-prompt
 *     hash differs (T2 ≠ T1 in the inline volatile band) so the prefix file
 *     misses and B cold-prefills system+tools again.
 *   - treatment (flag ON): B's prompt-eval tokens are MUCH lower — the
 *     stable system (volatile-free) is byte-identical to A's, the
 *     `prefix-gp` file restores, and llama-server's cache_prompt reuses the
 *     `[system+tools]` leading prefix; B prefills only the new volatile +
 *     user tokens.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx src/bin/ab-prefix-cache.ts
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { defaultCacheRoot, ensureWarmModel, linkModelIntoTrial } from '../model-cache.ts';
import { resolveLlamaBinary } from '../native-bin.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';

const MODEL = 'gemma4-e4b-q8';
const PROMPT = 'Reply with exactly the single word: ready.';
const TURN_TIMEOUT_MS = 240_000;

interface PromptEval {
  ms: number;
  tokens: number;
}

function parsePromptEvals(log: string): PromptEval[] {
  const re = /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/g;
  return [...log.matchAll(re)].map((m) => ({ ms: Number(m[1]), tokens: Number(m[2]) }));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
async function waitForIdle(client: any, gezelId: string, label: string): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  // Give the turn a beat to register as in-flight before we start polling.
  await sleep(1500);
  while (Date.now() < deadline) {
    const { inflight } = await client
      .listInflightTurns({ gezelId })
      .catch(() => ({ inflight: [] }));
    if (!inflight || inflight.length === 0) return;
    await sleep(2000);
  }
  console.warn(`[ab] ${label}: turn did not idle within ${TURN_TIMEOUT_MS}ms — continuing`);
}

async function runArm(arm: 'baseline' | 'treatment', llamaBin: string): Promise<PromptEval[]> {
  const home = await mkdtemp(join(tmpdir(), `gezel-ab-${arm}-`));
  const logPath = join(home, 'daemon.log');
  console.log(`\n=== ARM: ${arm} (home=${home}) ===`);
  // Link the warm cached model into this fresh home so the engine can load
  // it (mirrors the eval runner's warm-cache → link step).
  const cacheRoot = defaultCacheRoot();
  await ensureWarmModel({
    cacheRoot,
    engine: 'llama-cpp',
    modelId: MODEL,
    llamaBin,
    log: () => {},
  });
  await linkModelIntoTrial({ cacheRoot, trialHome: home, engine: 'llama-cpp', modelId: MODEL });
  const spawned = await spawnTrialDaemon({
    home,
    llamaBin,
    stderrLogPath: logPath,
    timeoutMs: 120_000,
    // Explicit on both arms — llama-cpp now defaults the flag ON, so the
    // baseline must force it OFF to be a true control.
    extraEnv: { GEZEL_LAYERED_PREFIX_CACHE: arm === 'treatment' ? '1' : '0' },
  });
  // biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
  const client: any = spawned.client;
  try {
    await client.updateConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': MODEL },
      providerConcurrency: { 'llama-cpp': 1 },
      firstRunCompleted: true,
    });

    const meester = await client.createNewMeester({});
    const meesterId: string = meester.id ?? meester.gezel?.id ?? meester.gezelId;
    const projResp = await client.createProject({
      name: 'Shop',
      about: 'A small online storefront. Build a simple, clean shopping experience.',
      missionObjectives: 'Ship a working storefront with a product list and checkout.',
    });
    const projectId: string = projResp.id ?? projResp.project?.id;
    console.log(`[ab] ${arm}: meester=${meesterId} project=${projectId}`);

    const mkTask = (title: string) =>
      client.createTask(projectId, {
        title,
        description: `${title} — produce the deliverable for this task.`,
        assignee: { kind: 'gezel', gezelId: meesterId },
        steps: [{ name: 'Build' }],
      });
    const t1 = await mkTask('Build the storefront');
    const t2 = await mkTask('Wire up checkout');

    // Session A (task T1) → cold prefill, seeds the prefix on slot recycle.
    await client.createChatSession({
      gezelId: meesterId,
      projectId,
      taskRef: t1.ref,
      ...(t1.activeStepId ? { stepId: t1.activeStepId } : {}),
    });
    await client.sendChatMessage(meesterId, { message: PROMPT, projectId });
    await waitForIdle(client, meesterId, `${arm}/A`);

    // Session B (task T2, different volatile) → reuse under treatment.
    await client.createChatSession({
      gezelId: meesterId,
      projectId,
      taskRef: t2.ref,
      ...(t2.activeStepId ? { stepId: t2.activeStepId } : {}),
    });
    await client.sendChatMessage(meesterId, { message: PROMPT, projectId });
    await waitForIdle(client, meesterId, `${arm}/B`);
  } finally {
    await shutdownTrialDaemon(spawned).catch(() => {});
  }

  const log = await readFile(logPath, 'utf8').catch(() => '');
  const evals = parsePromptEvals(log);
  console.log(`[ab] ${arm}: prompt-eval requests = ${evals.map((e) => e.tokens).join(', ')}`);
  await rm(home, { recursive: true, force: true }).catch(() => {});
  return evals;
}

async function main(): Promise<void> {
  const deviceLock = acquireEvalDeviceLock();
  const llamaBin = resolveLlamaBinary().path;
  console.log(`[ab] llama-server = ${llamaBin}`);
  const baseline = await runArm('baseline', llamaBin);
  const treatment = await runArm('treatment', llamaBin);

  // Session B's prefill = the LAST prompt-eval of each arm (B's first/only
  // request prefills its prompt; later tool-loop requests, if any, reuse
  // within-session). We compare the max prefill seen after A as a robust
  // proxy for "did B re-prefill the whole system+tools".
  const bBaseline = baseline.length >= 2 ? baseline[baseline.length - 1] : baseline[0];
  const bTreatment = treatment.length >= 2 ? treatment[treatment.length - 1] : treatment[0];
  const peakBaseline = Math.max(0, ...baseline.map((e) => e.tokens));
  const peakTreatment = Math.max(0, ...treatment.map((e) => e.tokens));

  console.log('\n================ A/B PREFIX-CACHE RESULT ================');
  console.log('baseline  prompt-eval token counts:', baseline.map((e) => e.tokens).join(', '));
  console.log('treatment prompt-eval token counts:', treatment.map((e) => e.tokens).join(', '));
  console.log('peak prefill tokens — baseline:', peakBaseline, ' treatment:', peakTreatment);
  console.log(
    "session B's prefill tokens — baseline:",
    bBaseline?.tokens,
    ' treatment:',
    bTreatment?.tokens,
  );
  if (bBaseline?.tokens && bTreatment?.tokens) {
    const saved = bBaseline.tokens - bTreatment.tokens;
    const pct = ((saved / bBaseline.tokens) * 100).toFixed(1);
    console.log(`session B prefill reduction: ${saved} tokens (${pct}%)`);
  }
  console.log('========================================================');
  deviceLock.release();
}

main().catch((err) => {
  console.error('[ab] failed:', err);
  process.exit(1);
});

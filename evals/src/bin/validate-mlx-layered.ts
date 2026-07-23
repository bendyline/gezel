/**
 * End-to-end validation of the layered prefix cache on the MLX engine.
 *
 * Unlike the llama-cpp A/B (`ab-prefix-cache.ts`), the eval runner can't
 * warm MLX (`ensureWarmModel` throws for mlx — it expects a pre-existing
 * dev cache), and no MLX model has ever been pulled on this device. So this
 * harness installs the MLX model itself via the daemon's install endpoint,
 * builds the venv on first inference, and runs the cross-session test:
 *
 *   - session A (task T1): cold — builds the mlx venv, loads the model,
 *     prefills the full prompt, and (flag ON) seeds `prefix-gp` from its
 *     real saved KV in the stream `finally`.
 *   - session B (task T2, different volatile): should MISS its own cache_id
 *     but HIT the seeded `prefix-gp` via the `prefix_cache_ids` cascade —
 *     proving the MLX layered path reuses `[system+tools]` cross-session.
 *
 * Verdict is read from the wrapped server's `[cache]` stdout lines in
 * daemon.log: expect `prefix-seeded …` (A) and `prefix-hit … prior_tokens>0`
 * (B). Flag is forced ON (mlx defaults OFF).
 *
 * Heavy + slow on first run (≈6.8 GB download + torch/mlx-vlm venv build +
 * two model loads). Run in the background.
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx src/bin/validate-mlx-layered.ts
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';

const MODEL = 'gemma4-e4b-q8';
const PROMPT = 'Reply with exactly the single word: ready.';
const HOME = join(homedir(), '.gezel-mlx-validate');
const FIRST_TURN_TIMEOUT_MS = 1_200_000; // venv build + model load + turn
const TURN_TIMEOUT_MS = 300_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Poll the session for an actual assistant reply — robust against the
// turn sitting queued behind a slow first-run engine startup (where
// listInflightTurns can read empty before the turn registers).
// biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
async function waitForReply(client: any, sessionId: string, label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    const sess = await client.getChatSession(sessionId).catch(() => null);
    const msgs: Array<{ role: string; content?: string }> = sess?.messages ?? [];
    if (msgs.some((m) => m.role === 'assistant' && (m.content?.length ?? 0) > 0)) {
      console.log(`[mlx] ${label}: assistant replied`);
      return;
    }
  }
  console.warn(`[mlx] ${label}: no assistant reply within ${Math.round(timeoutMs / 1000)}s`);
}

async function main(): Promise<void> {
  const deviceLock = acquireEvalDeviceLock();
  await mkdir(HOME, { recursive: true });
  const logPath = join(HOME, 'daemon.log');
  await rm(logPath, { force: true }).catch(() => {});
  console.log(`[mlx] home=${HOME}`);
  const spawned = await spawnTrialDaemon({
    home: HOME,
    stderrLogPath: logPath,
    timeoutMs: 120_000,
    extraEnv: { GEZEL_LAYERED_PREFIX_CACHE: '1' }, // force ON (mlx defaults OFF)
  });
  // biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
  const client: any = spawned.client;
  try {
    await client.updateConfig({
      provider: 'mlx',
      defaultModel: { mlx: MODEL },
      firstRunCompleted: true,
    });

    const modelDir = join(HOME, 'engines', 'mlx', 'models', MODEL);
    if (existsSync(join(modelDir, 'manifest.json'))) {
      console.log(`[mlx] ${MODEL} already installed at ${modelDir}`);
    } else {
      console.log(`[mlx] installing ${MODEL} (≈6.8 GB)…`);
      let lastPct = -1;
      await client.installMlxModel(MODEL, (e: Record<string, unknown>) => {
        if (e.type === 'progress' && typeof e.totalBytes === 'number' && e.totalBytes > 0) {
          const pct = Math.floor(((Number(e.bytesWritten) || 0) / e.totalBytes) * 100);
          if (pct >= lastPct + 10) {
            console.log(`[mlx] download ${pct}%`);
            lastPct = pct;
          }
        } else if (e.type === 'done') {
          console.log('[mlx] download done');
        } else if (e.type === 'error') {
          console.error(`[mlx] download error: ${e.error}`);
        }
      });
      if (!existsSync(join(modelDir, 'manifest.json'))) {
        throw new Error('install reported done but model dir has no manifest');
      }
    }

    const meester = await client.createNewMeester({});
    const meesterId: string = meester.id ?? meester.gezel?.id ?? meester.gezelId;
    const projResp = await client.createProject({
      name: 'Shop',
      about: 'A small online storefront. Build a simple, clean shopping experience.',
      missionObjectives: 'Ship a working storefront with a product list and checkout.',
    });
    const projectId: string = projResp.id ?? projResp.project?.id;
    console.log(`[mlx] meester=${meesterId} project=${projectId}`);

    const mkTask = (title: string) =>
      client.createTask(projectId, {
        title,
        description: `${title} — produce the deliverable for this task.`,
        assignee: { kind: 'gezel', gezelId: meesterId },
        steps: [{ name: 'Build' }],
      });
    const t1 = await mkTask('Build the storefront');
    const t2 = await mkTask('Wire up checkout');

    console.log('[mlx] session A (cold — loads model, then seeds prefix-gp)…');
    const sessA = await client.createChatSession({
      gezelId: meesterId,
      projectId,
      taskRef: t1.ref,
      ...(t1.activeStepId ? { stepId: t1.activeStepId } : {}),
    });
    await client.sendChatMessage(meesterId, { message: PROMPT, projectId });
    await waitForReply(client, sessA.id, 'A', FIRST_TURN_TIMEOUT_MS);

    console.log('[mlx] session B (warm — should inherit prefix-gp via cascade)…');
    const sessB = await client.createChatSession({
      gezelId: meesterId,
      projectId,
      taskRef: t2.ref,
      ...(t2.activeStepId ? { stepId: t2.activeStepId } : {}),
    });
    await client.sendChatMessage(meesterId, { message: PROMPT, projectId });
    await waitForReply(client, sessB.id, 'B', TURN_TIMEOUT_MS);
  } finally {
    await shutdownTrialDaemon(spawned).catch(() => {});
  }

  const log = await readFile(logPath, 'utf8').catch(() => '');
  const cacheLines = log
    .split('\n')
    .filter((l) => l.includes('[cache]'))
    .map((l) => l.slice(l.indexOf('[cache]')));
  console.log('\n================ MLX [cache] EVENT LOG ================');
  for (const l of cacheLines) console.log(l);
  console.log('======================================================');
  const seeded = cacheLines.some((l) => /prefix-seeded/.test(l));
  const prefixHit = cacheLines.find((l) => /prefix-hit/.test(l));
  const reused = prefixHit ? Number(/prior_tokens=(\d+)/.exec(prefixHit)?.[1] ?? 0) : 0;
  console.log('\n================ MLX LAYERED VERDICT ================');
  console.log(`prefix-gp seeded from session A:  ${seeded ? 'YES' : 'NO'}`);
  console.log(
    `session B prefix-hit:             ${prefixHit ? `YES (reused ${reused} tokens)` : 'NO'}`,
  );
  console.log(
    seeded && reused > 0
      ? '✅ MLX layered cross-session reuse WORKS'
      : '⚠️  MLX layered reuse NOT observed — inspect the event log above',
  );
  console.log('====================================================');
  deviceLock.release();
}

main().catch((err) => {
  console.error('[mlx] failed:', err);
  process.exit(1);
});

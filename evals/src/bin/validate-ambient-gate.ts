/**
 * Live validation for ambient admission control on a single-lane local
 * engine (ds4). Proves the end-to-end path — producer marks the work
 * `ambient`, the flag survives ChatManager plumbing, and the pool
 * replica's ProviderQueue actually holds it — which unit tests can't.
 *
 * Scenario (mirrors the wild-caught checkers incident):
 *   1. An interactive turn runs on ds4 (user is engaged).
 *   2. The session is archived → `summarizeInBackground('archive')`
 *      fires an ambient memory-summary one-shot immediately.
 *   3. EXPECT: /api/queues reports ambientHeld ≥ 1 while inside the
 *      quiet window — the chore does NOT camp on the lane.
 *   4. An interactive turn sent while the chore is held completes
 *      normally (the gate never blocks real work).
 *   5. After GEZEL_AMBIENT_QUIET_MS of quiet, the held chore
 *      dispatches and drains (ambientHeld → 0, pending ambient → 0).
 *
 * Run:
 *   GEZEL_DS4_SERVER_BIN=… GEZEL_DS4_MODEL=… \
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/validate-ambient-gate.ts
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';

const MODEL = process.env.GEZEL_DS4_MODEL_ID ?? 'deepseek-v4-flash-284b-q2';
const QUIET_MS = 60_000;
const TURN_TIMEOUT_MS = 300_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
async function waitForIdle(client: any, gezelId: string, label: string): Promise<void> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  await sleep(1500);
  while (Date.now() < deadline) {
    const { inflight } = await client
      .listInflightTurns({ gezelId })
      .catch(() => ({ inflight: [] }));
    if (!inflight || inflight.length === 0) return;
    await sleep(2000);
  }
  console.warn(`[validate] ${label}: turn did not idle within ${TURN_TIMEOUT_MS}ms`);
}

interface Ds4QueueView {
  running: number;
  queuedBackground: number;
  ambientHeld: number;
  pending: Array<{ lane: string; ambient?: boolean; job?: string }>;
  active: Array<{ job?: string }>;
}

// biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
async function ds4Queue(client: any): Promise<Ds4QueueView | null> {
  const status = await client.getQueueStatus().catch(() => null);
  const q = status?.providers?.ds4;
  if (!q) return null;
  return {
    running: q.running ?? 0,
    queuedBackground: q.queuedBackground ?? 0,
    ambientHeld: q.ambientHeld ?? 0,
    pending: q.pending ?? [],
    active: q.active ?? [],
  };
}

async function main(): Promise<void> {
  const bin = process.env.GEZEL_DS4_SERVER_BIN;
  const modelPath = process.env.GEZEL_DS4_MODEL;
  if (!bin || !modelPath) {
    console.error('[validate] set GEZEL_DS4_SERVER_BIN and GEZEL_DS4_MODEL');
    process.exit(2);
  }
  const deviceLock = acquireEvalDeviceLock();
  const home = await mkdtemp(join(tmpdir(), 'gezel-ambient-gate-'));
  const logPath = join(home, 'daemon.log');
  console.log(`[validate] home=${home}  quietMs=${QUIET_MS}`);

  const spawned = await spawnTrialDaemon({
    home,
    stderrLogPath: logPath,
    timeoutMs: 1_200_000,
    extraEnv: {
      GEZEL_DS4_SERVER_BIN: bin,
      GEZEL_DS4_MODEL: modelPath,
      GEZEL_AMBIENT_QUIET_MS: String(QUIET_MS),
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
  const client: any = spawned.client;

  const failures: string[] = [];
  const check = (cond: boolean, label: string) => {
    console.log(`[validate] ${cond ? 'PASS' : 'FAIL'}: ${label}`);
    if (!cond) failures.push(label);
  };

  try {
    await client.updateConfig({
      provider: 'ds4',
      defaultModel: { ds4: MODEL },
      providerConcurrency: { ds4: 1 },
      firstRunCompleted: true,
      projectNudge: { enabled: false },
    });
    const bram = await client.createGezel({
      name: 'Bram',
      role: 'Assistant',
      about:
        'You are Bram, a quiet assistant. Answer directly and briefly. Never delegate or ' +
        'use tools. When told to reply with an exact word, reply with exactly that word.',
    });
    const gezelId: string = bram.id ?? bram.gezel?.id ?? bram.gezelId;
    const proj = await client.createProject({ name: 'gate-check' });
    const projectId: string = proj.id ?? proj.project?.id;
    const session1 = await client.createChatSession({ gezelId, projectId });
    const session1Id: string = session1.id ?? session1.session?.id;

    // 1. Two interactive turns — loads the engine, marks user engagement,
    //    and clears the summarizer's own "≥ 2 user turns" cadence gate so
    //    the archive below actually produces a chore.
    console.log('[validate] interactive turn 1 (cold engine load)…');
    await client.sendChatMessage(gezelId, { message: 'Reply with exactly: ok.', projectId });
    await waitForIdle(client, gezelId, 'turn1');
    console.log('[validate] interactive turn 1b (same session)…');
    await client.sendChatMessage(gezelId, { message: 'Reply with exactly: sure.', projectId });
    await waitForIdle(client, gezelId, 'turn1b');

    // 2. Archive the session → summarizeInBackground('archive') fires an
    //    ambient memory-summary one-shot immediately.
    console.log('[validate] archiving session (fires the ambient summary chore)…');
    await client.archiveChatSession(session1Id);

    // 3. The chores must be HELD while we are inside the quiet window.
    let sawHeld = false;
    let heldView: Ds4QueueView | null = null;
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      const q = await ds4Queue(client);
      if (q && q.ambientHeld >= 1) {
        sawHeld = true;
        heldView = q;
        break;
      }
    }
    console.log(`[validate] queue view: ${JSON.stringify(heldView)}`);
    check(sawHeld, 'ambient chores are HELD while the user is recently active (ambientHeld ≥ 1)');
    const qDuring = await ds4Queue(client);
    check(
      (qDuring?.running ?? 0) === 0,
      'no ambient chore is RUNNING inside the quiet window (lane is free for the user)',
    );

    // 4. An interactive turn while chores are held must run immediately.
    console.log('[validate] interactive turn 2 (while chores held)…');
    const t0 = Date.now();
    await client.sendChatMessage(gezelId, { message: 'Reply with exactly: pass.', projectId });
    await waitForIdle(client, gezelId, 'turn2');
    console.log(`[validate] turn 2 completed in ${Math.round((Date.now() - t0) / 1000)}s`);
    const qAfterTurn = await ds4Queue(client);
    check(
      (qAfterTurn?.ambientHeld ?? 0) >= 1,
      'chores are STILL held right after the second turn (activity refreshed the clock)',
    );

    // 5. Go quiet. Within quietMs + generous chore runtime, the chores
    //    dispatch and drain.
    console.log(`[validate] going quiet for the window (${QUIET_MS / 1000}s) + chore runtime…`);
    const drainDeadline = Date.now() + QUIET_MS + 8 * 60_000;
    let dispatched = false;
    let drained = false;
    while (Date.now() < drainDeadline) {
      await sleep(5000);
      const q = await ds4Queue(client);
      if (!q) continue;
      const pendingAmbient = q.pending.filter((p) => p.ambient).length;
      // A held entry can only leave `pending` by dispatching (nothing
      // aborts it here) — and a fast chore can start AND finish between
      // two polls, so "pending dropped to zero" is the reliable
      // dispatch signal; a caught `running > 0` is a bonus.
      if (q.running > 0 || (pendingAmbient === 0 && q.ambientHeld === 0)) dispatched = true;
      if (dispatched && q.running === 0 && pendingAmbient === 0 && q.ambientHeld === 0) {
        drained = true;
        break;
      }
    }
    check(dispatched, 'held chores DISPATCHED after the quiet window elapsed');
    check(drained, 'chores drained to an idle queue (ambientHeld = 0, no pending ambient)');
    // The chore must also have SUCCEEDED — run 3 caught it dispatching
    // into a second ds4-server spawn refusal (the singleton split-brain).
    // Success is either stored memories OR a completed one-shot whose
    // answer was NONE (a trivial transcript legitimately summarizes to
    // nothing); failure is the summarizer's failed/warn path.
    const logNow = await readFile(logPath, 'utf8').catch(() => '');
    const summaryStored = /\[summarize\] session .* → \d+ memories/.test(logNow);
    const oneShotCompleted = /\[one-shot\] completed \(\d+ chars\)/.test(logNow);
    const summaryFailed = /\[summarize\] session .* failed:/.test(logNow);
    check(
      (summaryStored || oneShotCompleted) && !summaryFailed,
      'the summary chore ran to completion (no split-brain spawn failure)',
    );
  } finally {
    await shutdownTrialDaemon(spawned).catch(() => {});
    deviceLock.release();
  }

  const log = await readFile(logPath, 'utf8').catch(() => '');
  const choreRan = /summary · /.test(log);
  console.log(`[validate] chore evidence in daemon.log ('summary ·' job label): ${choreRan}`);

  console.log('\n================ AMBIENT GATE VALIDATION ================');
  if (failures.length === 0) {
    console.log('ALL CHECKS PASSED');
  } else {
    console.log(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`[validate] daemon.log retained at ${logPath}`);
}

main().catch((err) => {
  console.error('[validate] failed:', err);
  process.exit(1);
});

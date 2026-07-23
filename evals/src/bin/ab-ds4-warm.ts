/**
 * A/B micro-harness for the ds4 keep-warm adapter (`Ds4CacheAdapter.warm`).
 *
 * Question: when a game/task session goes COLD between turns — because the
 * single ds4 request lane was clobbered by another session's turn — does
 * `POST /api/cache/warm` (→ `prewarmSession` → session `prefillOnly`) put
 * the session's KV back so the next real turn prefills cheaply instead of
 * re-streaming the whole prompt?
 *
 * A single continuous session can't show it: turn N+1 already reuses turn N's
 * live KV. The warm adapter only matters when something EVICTED that live KV.
 * So each arm: build a session transcript → clobber the lane with a different
 * session's turn → measure the resume turn. Baseline resumes cold; treatment
 * fires warm first, waits for the `[ds4-cache] warmed session …` line, then
 * resumes.
 *
 * Observables (parsed from daemon.log, both throughput-invariant):
 *   - `[llama-cpp] TTFT <ms>ms` — wall-clock to first token.
 *   - `ds4-server: chat ctx=<reused>..<end>:<n> … prefill chunk 0/<N>` —
 *     the ground truth. Cold: reused=0, N≈full prompt. Prefix hit: reused>0,
 *     N≈just the new tokens.
 *
 * Protocol hardening (learned from run 1, 2026-07-21): background
 * orchestration — gezel-creation one-shots, import-sync voorman recruitment,
 * meester handoffs — runs REAL turns on ds4's single lane between the
 * scripted steps, clobbering KV unpredictably and contaminating both arms.
 * Every measured step is therefore preceded by `waitForEngineQuiet`: no new
 * ds4-server activity lines for QUIET_WINDOW_MS. Run 1 also never exercised
 * the warm at all (the ds4 cache adapter wasn't wired on the non-pool
 * provider path — fixed in manager.ts), which is why the `[ds4-cache]` wait
 * now treats "no adapter line" as a hard protocol failure, not a shrug.
 *
 * Run:
 *   GEZEL_DS4_SERVER_BIN=… GEZEL_DS4_MODEL=… \
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/ab-ds4-warm.ts
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';

const MODEL = process.env.GEZEL_DS4_MODEL_ID ?? 'deepseek-v4-flash-284b-q2';
const TURN_TIMEOUT_MS = 300_000;
const WARM_WAIT_MS = 15 * 60_000;
const QUIET_WINDOW_MS = 30_000;
const QUIET_CAP_MS = 10 * 60_000;

interface Measure {
  ttftMs: number | null;
  ctxReused: number | null;
  ctxEnd: number | null;
  prefillTokens: number | null;
  raw: string[];
}

/** A long, arm-unique transcript body so each arm's prefix is distinct (no
 * cross-arm disk-KV hits) and a cache MISS is unmistakable (thousands of
 * prefill tokens) versus a HIT (a handful). */
function longBody(seed: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 90; i++) {
    lines.push(
      `${seed} move ${i}: the piece on rank ${((i * 3) % 8) + 1} advances toward ` +
        `column ${((i * 5) % 8) + 1}; a measured, deliberate development that keeps ` +
        `the back rank intact while probing the ${seed} flank for a later breakthrough.`,
    );
  }
  return lines.join('\n');
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

/** Engine-activity lines: any ds4-server request progress. Background
 * one-shots and orchestration turns show up here even when they never
 * register as inflight chat turns. */
function countEngineActivity(log: string): number {
  return (log.match(/ds4-server: chat ctx=|ds4-server: tool calls/g) ?? []).length;
}

/** Wait until the ds4 engine has produced NO new activity lines for
 * QUIET_WINDOW_MS. Caps at QUIET_CAP_MS (warns, continues). */
async function waitForEngineQuiet(logPath: string, label: string): Promise<void> {
  const start = Date.now();
  let lastCount = countEngineActivity(await readLog(logPath));
  let quietSince = Date.now();
  while (Date.now() - start < QUIET_CAP_MS) {
    await sleep(3000);
    const count = countEngineActivity(await readLog(logPath));
    if (count !== lastCount) {
      lastCount = count;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= QUIET_WINDOW_MS) {
      console.log(`[ab] ${label}: engine quiet for ${QUIET_WINDOW_MS / 1000}s — proceeding`);
      return;
    }
  }
  console.warn(
    `[ab] ${label}: engine never went quiet within ${QUIET_CAP_MS / 1000}s — continuing`,
  );
}

/** Parse the daemon.log text appended since the last snapshot for one turn's
 * TTFT + first prefill sequence. */
function parseMeasure(newText: string): Measure {
  const raw = newText.split('\n').filter((l) => /ds4-server: chat ctx=|TTFT \d+ms/.test(l));
  let ttftMs: number | null = null;
  const ttft = newText.match(/TTFT (\d+)ms/);
  if (ttft) ttftMs = Number(ttft[1]);
  let ctxReused: number | null = null;
  let ctxEnd: number | null = null;
  let prefillTokens: number | null = null;
  // First prefill start line of the measured request.
  const ctx = newText.match(/chat ctx=(\d+)\.\.(\d+):(\d+)\b/);
  if (ctx) {
    ctxReused = Number(ctx[1]);
    ctxEnd = Number(ctx[2]);
  }
  const chunk = newText.match(/prefill chunk 0\/(\d+)\b/);
  if (chunk) prefillTokens = Number(chunk[1]);
  return { ttftMs, ctxReused, ctxEnd, prefillTokens, raw };
}

async function readLog(logPath: string): Promise<string> {
  return readFile(logPath, 'utf8').catch(() => '');
}

async function main(): Promise<void> {
  const bin = process.env.GEZEL_DS4_SERVER_BIN;
  const modelPath = process.env.GEZEL_DS4_MODEL;
  if (!bin || !modelPath) {
    console.error('[ab] set GEZEL_DS4_SERVER_BIN and GEZEL_DS4_MODEL');
    process.exit(2);
  }
  const deviceLock = acquireEvalDeviceLock();
  const home = await mkdtemp(join(tmpdir(), 'gezel-ab-ds4-warm-'));
  const logPath = join(home, 'daemon.log');
  console.log(`[ab] home=${home}`);
  console.log(`[ab] bin=${bin}`);
  console.log(`[ab] model=${modelPath}`);

  const spawned = await spawnTrialDaemon({
    home,
    stderrLogPath: logPath,
    timeoutMs: 1_200_000,
    extraEnv: {
      GEZEL_DS4_SERVER_BIN: bin,
      GEZEL_DS4_MODEL: modelPath,
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
  const client: any = spawned.client;

  const results: Record<string, Measure> = {};
  let warmAdapterLine: string | null = null;
  try {
    await client.updateConfig({
      provider: 'ds4',
      defaultModel: { ds4: MODEL },
      providerConcurrency: { ds4: 1 },
      firstRunCompleted: true,
      // Run 3 regression: once the harness's projects crossed the 10-min
      // first-nudge grace, the scheduler's ambient voorman nudges began
      // firing full 3-minute turns on ds4's single lane back-to-back —
      // the engine never went quiet again and the warm correctly skipped
      // with "engine busy" forever. Nudges are real product behavior but
      // poison a latency measurement; off for the A/B.
      projectNudge: { enabled: false },
    });
    // A PLAIN gezel, never the meester: run 2 was destroyed by the
    // meester autonomously recruiting a crew and handing off between
    // gezels — a multi-turn cascade on ds4's single lane that kept the
    // engine busy for 10+ minutes and queued the measured resume behind
    // it (TTFT 692s of queue-wait, not prefill). An explicit minimal
    // about also skips the background about-generation one-shot.
    const gezelResp = await client.createGezel({
      name: 'Bram',
      role: 'Assistant',
      about:
        'You are Bram, a quiet assistant. Answer the user directly and briefly. ' +
        'Never delegate, never create projects or gezels, never use tools unless ' +
        'explicitly asked. When told to reply with an exact word, reply with ' +
        'exactly that word and nothing else.',
    });
    const gezelId: string = gezelResp.id ?? gezelResp.gezel?.id ?? gezelResp.gezelId;
    console.log(`[ab] gezel=${gezelId}`);

    const mkProject = async (name: string): Promise<string> => {
      const r = await client.createProject({ name });
      return r.id ?? r.project?.id;
    };

    // Create ALL projects up front so import-sync / voorman recruitment /
    // about-generation noise fires now, long before any measured step.
    const projPrime = await mkProject('prime');
    const arms = {
      cold: { game: await mkProject('game-cold'), clob: await mkProject('clobber-cold') },
      warm: { game: await mkProject('game-warm'), clob: await mkProject('clobber-warm') },
    } as const;

    // --- Prime: load weights + warm the shared system prefix (not measured
    //     as an arm, but its TTFT is the "engine cold-load" reference). ---
    await client.createChatSession({ gezelId, projectId: projPrime });
    let off = (await readLog(logPath)).length;
    console.log('[ab] priming engine (cold weight load)…');
    await client.sendChatMessage(gezelId, {
      message: 'Reply with exactly: ok.',
      projectId: projPrime,
    });
    await waitForIdle(client, gezelId, 'prime');
    results.prime = parseMeasure((await readLog(logPath)).slice(off));
    console.log(`[ab] prime: ${JSON.stringify({ ...results.prime, raw: undefined })}`);

    const runArm = async (arm: 'cold' | 'warm'): Promise<void> => {
      const seed = arm === 'cold' ? 'sienna' : 'cobalt';
      const { game: projGame, clob: projClob } = arms[arm];

      await waitForEngineQuiet(logPath, `${arm}/pre-build`);

      // 1. Build the game session's transcript (arm-unique long body).
      const game = await client.createChatSession({ gezelId, projectId: projGame });
      const gameSessionId: string = game.id ?? game.session?.id;
      console.log(`[ab] ${arm}: building transcript (session=${gameSessionId.slice(0, 8)})…`);
      await client.sendChatMessage(gezelId, {
        message: `${longBody(seed)}\n\nAcknowledge with exactly: ok.`,
        projectId: projGame,
      });
      await waitForIdle(client, gezelId, `${arm}/build`);
      await waitForEngineQuiet(logPath, `${arm}/post-build`);

      // 2. Clobber the single ds4 lane with a different session's turn.
      await client.createChatSession({ gezelId, projectId: projClob });
      console.log(`[ab] ${arm}: clobbering the lane…`);
      await client.sendChatMessage(gezelId, {
        message: `${longBody(`${seed}-clobber`)}\n\nAcknowledge with exactly: ok.`,
        projectId: projClob,
      });
      await waitForIdle(client, gezelId, `${arm}/clobber`);
      await waitForEngineQuiet(logPath, `${arm}/post-clobber`);

      // 3. (treatment only) fire warm and wait for the adapter's log line.
      if (arm === 'warm') {
        const warmMark = (await readLog(logPath)).length;
        console.log(`[ab] warm: POST /api/cache/warm for ${gameSessionId.slice(0, 8)}…`);
        await client.warmSessionCache(gameSessionId).catch((e: unknown) => {
          console.warn('[ab] warmSessionCache error', e);
        });
        const deadline = Date.now() + WARM_WAIT_MS;
        const sidPrefix = gameSessionId.slice(0, 8);
        while (Date.now() < deadline) {
          const tail = (await readLog(logPath)).slice(warmMark);
          // Match THIS session's adapter line only — session-create
          // auto-warms for other sessions also log [ds4-cache] (run 2
          // matched one of those and misread the treatment entirely).
          const m = tail.match(new RegExp(`\\[ds4-cache\\][^\\n]*${sidPrefix}[^\\n]*`));
          if (m) {
            warmAdapterLine = m[0];
            break;
          }
          await sleep(1500);
        }
        console.log(`[ab] warm: adapter log → ${warmAdapterLine ?? '(none seen)'}`);
        if (!warmAdapterLine) {
          throw new Error(
            '[ab] PROTOCOL FAILURE: no [ds4-cache] line after POST /api/cache/warm — ' +
              'the adapter is not wired; the treatment arm would be meaningless (run 1 regression).',
          );
        }
        if (!warmAdapterLine.includes('warmed session')) {
          throw new Error(
            `[ab] PROTOCOL FAILURE: warm did not complete — adapter said: ${warmAdapterLine} (a skipped warm makes the treatment arm identical to baseline; run 2 regression).`,
          );
        }
        // Warm ran (or skipped) — either way let the engine settle before measuring.
        await waitForEngineQuiet(logPath, 'warm/post-warm');
      }

      // 4. Measured resume turn.
      off = (await readLog(logPath)).length;
      console.log(`[ab] ${arm}: measured resume turn…`);
      await client.sendChatMessage(gezelId, {
        message: 'It is your move. Reply with exactly: pass.',
        projectId: projGame,
      });
      await waitForIdle(client, gezelId, `${arm}/resume`);
      results[arm] = parseMeasure((await readLog(logPath)).slice(off));
      console.log(`[ab] ${arm}: ${JSON.stringify({ ...results[arm], raw: undefined })}`);
    };

    await runArm('cold');
    await runArm('warm');
  } finally {
    await shutdownTrialDaemon(spawned).catch(() => {});
    deviceLock.release();
  }

  const fmt = (m: Measure | undefined) =>
    m
      ? `TTFT=${m.ttftMs ?? '?'}ms  ctxReused=${m.ctxReused ?? '?'}  ctxEnd=${m.ctxEnd ?? '?'}  prefillTokens=${m.prefillTokens ?? '?'}`
      : '(missing)';

  console.log('\n================ ds4 WARM A/B RESULT ================');
  console.log('prime (engine cold-load):', fmt(results.prime));
  console.log('cold  (resume, no warm) :', fmt(results.cold));
  console.log('warm  (resume, warmed)  :', fmt(results.warm));
  console.log('warm adapter line       :', warmAdapterLine ?? '(n/a)');
  const c = results.cold;
  const w = results.warm;
  if (c && w) {
    console.log(
      `\nresume prefill tokens — cold: ${c.prefillTokens ?? '?'}  warm: ${w.prefillTokens ?? '?'}`,
    );
    console.log(`resume TTFT — cold: ${c.ttftMs ?? '?'}ms  warm: ${w.ttftMs ?? '?'}ms`);
  }
  console.log('====================================================');
  console.log(`[ab] daemon.log retained at ${logPath}`);
  await rm(join(home, 'artifacts'), { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error('[ab] failed:', err);
  process.exit(1);
});

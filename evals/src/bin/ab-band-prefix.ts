/**
 * A/B micro-harness for shared-band prefix reuse on MLX
 * (`config.mlxSharedBandPrefix`, ADR 0010).
 *
 * Sibling of `ab-prefix-cache.ts`, which measures the same *idea* on
 * llama-cpp. It is a separate bin rather than a flag on that one because
 * almost nothing is shared: MLX has no `llama-server` binary, `ensureWarmModel`
 * refuses for mlx (it expects a pre-existing dev cache), the drafter has to be
 * linked in separately, and the engine reports reuse in its own vocabulary
 * (`[batch] seed … mode= reused= prefill=`) rather than llama's
 * `prompt eval time = … / N tokens`.
 *
 * What it measures — the CROSS-SESSION win, which a single agentic trial
 * cannot show: within one session the system prompt is frozen, so both arms
 * reuse turn-to-turn. The win is a *sibling* — same gezel+project, different
 * task, so a different volatile tail — inheriting the warm `[tools + stable
 * system]` band instead of cold-prefilling it.
 *
 * Experiment (per arm, on `qwen3.8-27b-q4` / mlx):
 *   1. spawn one daemon against a fresh GEZEL_HOME with the model linked in
 *   2. session A on task T1 → send → wait (cold; publishes the band at turn end)
 *   3. session B on task T2 → send → wait
 *   4. parse the daemon log's `[batch] seed` lines
 *
 * Expectation:
 *   - baseline (flag OFF): B seeds `mode=fresh reused=0` — the whole-prompt
 *     hash differs (T2's task band ≠ T1's) so B mints its own prefix id and
 *     cold-prefills system+tools again.
 *   - treatment (flag ON): B seeds `mode=extension reused=<band>` and prefills
 *     only its own tail.
 *
 * NOTE the ordering hazard this harness exists to exercise: A and B must be
 * dispatched as a real sequence through one daemon, because the bug that
 * survived unit tests AND a synthetic probe was that the prefix lookup runs at
 * request arrival while the band is published at turn end. A harness that
 * fully drains A before creating B hides it.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { linkDrafterIntoTrial, linkModelIntoTrial } from '../model-cache.js';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.js';

const MODEL = 'qwen3.8-27b-q4';
/**
 * MLX weights, drafter and uv venv all come from the DEV home, not the eval
 * cache: `ensureWarmModel` refuses for mlx, so nothing ever populates
 * `~/.gezel-eval-cache/engines/mlx`. `runner.ts` passes this same home as
 * `cacheRoot` when it links an mlx trial.
 */
const MLX_SOURCE_HOME = join(homedir(), '.gezel-dev');
const PROMPT = 'In one short sentence, say what you would do first. Do not call any tools.';
const TURN_TIMEOUT_MS = 600_000;

/** One engine seed decision, as the MLX sidecar reports it. */
export interface SeedDecision {
  cacheId: string;
  mode: string;
  reused: number;
  prefill: number;
}

export function parseSeedDecisions(log: string): SeedDecision[] {
  const re = /\[batch\] seed cache_id=(\S+) mode=(\S+) reused=(\d+) prefill=(\d+)/g;
  return [...log.matchAll(re)].map((m) => ({
    cacheId: String(m[1]),
    mode: String(m[2]),
    reused: Number(m[3]),
    prefill: Number(m[4]),
  }));
}

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
    await sleep(3000);
  }
  console.warn(`[ab-band] ${label}: turn did not idle within ${TURN_TIMEOUT_MS}ms — continuing`);
}

/**
 * Symlink the uv venv tree from the dev home so the trial daemon's
 * `UvRuntime.ensureVenv` short-circuits. Without it each arm spends ~10
 * minutes installing mlx-lm + transformers + torch before its first token.
 * Mirrors `linkUvTreeIntoTrial` in runner.ts, which is private to that module.
 */
async function linkUvTree(trialHome: string): Promise<void> {
  const sourceUv = join(MLX_SOURCE_HOME, 'engines', 'uv');
  if (!existsSync(sourceUv)) {
    console.warn(`[ab-band] no uv venv at ${sourceUv} — the trial will provision one (slow)`);
    return;
  }
  const trialUv = join(trialHome, 'engines', 'uv');
  if (existsSync(trialUv)) return;
  await mkdir(join(trialHome, 'engines'), { recursive: true });
  await symlink(sourceUv, trialUv, process.platform === 'win32' ? 'junction' : 'dir');
}

async function runArm(arm: 'baseline' | 'treatment'): Promise<SeedDecision[]> {
  const home = await mkdtemp(join(tmpdir(), `gezel-band-${arm}-`));
  const logPath = join(home, 'daemon.log');
  console.log(`\n=== ARM: ${arm} (home=${home}) ===`);
  await linkModelIntoTrial({
    cacheRoot: MLX_SOURCE_HOME,
    trialHome: home,
    engine: 'mlx',
    modelId: MODEL,
  });
  // Without the drafter the trial silently measures speculation OFF — the
  // exact trap the core gate hit before `linkDrafterIntoTrial` existed.
  await linkDrafterIntoTrial({
    sourceHome: MLX_SOURCE_HOME,
    trialHome: home,
    modelId: MODEL,
  }).catch(() => {});
  await linkUvTree(home);
  const spawned = await spawnTrialDaemon({
    home,
    stderrLogPath: logPath,
    timeoutMs: 300_000,
    // Explicit on both arms: the default is OFF today, but a future default
    // flip must not silently turn the baseline into a second treatment.
    extraEnv: { GEZEL_MLX_SHARED_BAND_PREFIX: arm === 'treatment' ? '1' : '0' },
  });
  // biome-ignore lint/suspicious/noExplicitAny: client is loosely typed here
  const client: any = spawned.client;
  try {
    await client.updateConfig({
      provider: 'mlx',
      defaultModel: { mlx: MODEL },
      providerConcurrency: { mlx: 1 },
      firstRunCompleted: true,
    });
    const meester = await client.createNewMeester({});
    const meesterId: string = meester.id ?? meester.gezel?.id ?? meester.gezelId;
    const projResp = await client.createProject({
      name: 'Band probe',
      about: 'Cross-session prefix-reuse measurement. Not a real project.',
      missionObjectives: 'Produce two sibling task sessions that share a stable prompt band.',
    });
    const projectId: string = projResp.id ?? projResp.project?.id;
    console.log(`[ab-band] ${arm}: gezel=${meesterId} project=${projectId}`);

    const mkTask = (title: string) =>
      client.createTask(projectId, {
        title,
        description: `${title} — this task exists only to give the session a distinct task band.`,
        assignee: { kind: 'gezel', gezelId: meesterId },
        steps: [{ name: 'Answer once' }],
      });

    const sessionIds: string[] = [];
    for (const [label, title] of [
      ['A', 'Sibling A — the pioneer'],
      ['B', 'Sibling B — should inherit the band'],
    ] as const) {
      const task = await mkTask(title);
      const session = await client.createChatSession({
        gezelId: meesterId,
        projectId,
        taskRef: task.ref,
        ...(task.activeStepId ? { stepId: task.activeStepId } : {}),
      });
      const sessionId: string = session.id ?? session.session?.id ?? session.sessionId;
      // Address the session EXPLICITLY. `sendChatMessage(gezelId, …)` is the
      // legacy per-(gezel, project) helper that resolves to the most-recent
      // session, so both sends landed in one session and the run measured
      // intra-session reuse — two turns of one chat — while reporting itself
      // as a sibling comparison. The whole point here is two DISTINCT
      // sessions; the ids are printed so a future run cannot hide this.
      console.log(`[ab-band] ${arm}/${label}: task=${task.ref} session=${sessionId}`);
      await client.sendToChatSession(sessionId, { message: PROMPT });
      await waitForIdle(client, meesterId, `${arm}/${label}`);
      sessionIds.push(sessionId);
    }
    if (new Set(sessionIds).size < 2) {
      throw new Error(
        `[ab-band] ${arm}: expected 2 distinct sessions, got ${JSON.stringify(sessionIds)} — the arm measured intra-session reuse, not a sibling`,
      );
    }
  } finally {
    await shutdownTrialDaemon(spawned).catch(() => {});
  }

  const log = await readFile(logPath, 'utf8').catch(() => '');
  const seeds = parseSeedDecisions(log);
  for (const s of seeds) {
    console.log(
      `[ab-band] ${arm}: ${s.cacheId.slice(0, 8)} mode=${s.mode} reused=${s.reused} prefill=${s.prefill}`,
    );
  }
  await rm(home, { recursive: true, force: true }).catch(() => {});
  return seeds;
}

function summarize(arm: string, seeds: SeedDecision[]): void {
  const reused = seeds.reduce((n, s) => n + s.reused, 0);
  const prefilled = seeds.reduce((n, s) => n + s.prefill, 0);
  const extensions = seeds.filter((s) => s.mode === 'extension').length;
  const total = reused + prefilled;
  const pct = total > 0 ? ((100 * reused) / total).toFixed(1) : '0.0';
  console.log(
    `[ab-band] ${arm}: ${seeds.length} seeds, ${extensions} extension(s), ` +
      `reused ${reused} / prefilled ${prefilled} (${pct}% reused)`,
  );
}

async function main(): Promise<void> {
  const deviceLock = acquireEvalDeviceLock();
  try {
    // Arms run sequentially: two 27B engines on one box cross-saturate VRAM
    // and both numbers would lie.
    const baseline = await runArm('baseline');
    const treatment = await runArm('treatment');
    console.log('\n=== RESULT ===');
    summarize('baseline ', baseline);
    summarize('treatment', treatment);
    const gained = treatment.filter((s) => s.mode === 'extension').length;
    const base = baseline.filter((s) => s.mode === 'extension').length;
    console.log(
      gained > base
        ? `\n✓ treatment extended ${gained - base} more time(s) than baseline`
        : '\n✗ no additional extension under treatment — check the [cache] band-boundary lines',
    );
  } finally {
    deviceLock.release();
  }
}

// Guarded so the parser above can be unit-tested by importing this module.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error('[ab-band] fatal:', error);
    process.exitCode = 2;
  });
}

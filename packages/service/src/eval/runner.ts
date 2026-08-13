/**
 * Service-side eval runner.
 *
 * The CLI harness (`pnpm eval:run …`) is the source of truth for trial
 * orchestration — see `evals/src/runner.ts`. This module is a thin
 * service-side adapter that:
 *
 *   - Spawns the CLI binary as a child process so the service stays
 *     fully decoupled from the harness's lifecycle (a crashing trial
 *     can't take down the gezeld it was launched from).
 *   - Streams the child's stdout to a callback (the SSE route in
 *     `http/routes/eval.ts` forwards these to the UI).
 *   - On child exit, reads `<runDir>/result.json` and produces a
 *     `TrialOutcome` summary the UI table can render.
 *
 * Packaging note: today the CLI is `tsx`-based and only works in dev
 * mode (when `evals/` is on disk). Packaged-mode invocation will hit
 * `ENOENT` on the binary — we surface a clear error so the UI can show
 * "in-app eval running requires dev mode; use `pnpm eval:run` from
 * the repo." A v2 will ship a built copy of the harness in the
 * service-bundle to close this gap.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@bendyline/gezel';
import { windowsHeadlessSpawnOptions } from '@bendyline/gezel/native';

const log = createLogger('eval-runner');

export interface RunEvalRequest {
  scenarioId: string;
  modelId: string;
  imageModelId?: string;
  /** Override the scenario's default timeout. */
  timeoutMs?: number;
}

export type RunEvalEvent =
  | { type: 'spawned'; trialId?: string; runDir?: string }
  | { type: 'log'; line: string }
  | { type: 'done'; result: TrialOutcome }
  | { type: 'error'; error: string };

export interface TrialOutcome {
  trialId: string;
  scenarioId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  reason: string;
  failureMode?: string;
  runDir: string;
}

/**
 * Resolve the CLI harness binary. Walks up from this file looking for
 * the repo root (the dir containing `pnpm-workspace.yaml`) — same
 * logic as `evals/src/native-bin.ts:repoRoot()` so the two stay in
 * sync. Returns null when not found (packaged mode without evals on
 * disk).
 */
function resolveEvalBinary(): {
  cmd: string;
  args: string[];
  cwd: string;
  binPath: string;
} | null {
  let dir = (() => {
    try {
      // Resolve via this file's URL — robust to monorepo layout.
      // dist/ when built; src/ in dev. Either way, walking up to
      // pnpm-workspace.yaml gets us the repo root.
      return fileURLToPath(import.meta.url);
    } catch {
      return process.cwd();
    }
  })();
  for (let i = 0; i < 12; i++) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const binPath = join(dir, 'evals', 'src', 'bin', 'run.ts');
      if (!existsSync(binPath)) return null;
      // Use the evals package's `tsx` via pnpm-managed node_modules.
      const tsxBin = join(dir, 'node_modules', '.bin', 'tsx');
      if (!existsSync(tsxBin)) return null;
      return {
        cmd: tsxBin,
        args: [binPath],
        cwd: dir,
        binPath,
      };
    }
  }
  return null;
}

export function isEvalRunnerAvailable(): boolean {
  return resolveEvalBinary() !== null;
}

/**
 * Run a scenario end-to-end, streaming progress events through
 * `onEvent`. The promise resolves when the child exits — successful
 * or not. Cancellation via `signal` SIGTERMs the child and resolves
 * with `{ success: false, failureMode: 'interrupted' }`.
 *
 * The `runsDir` should be a stable per-user location (e.g.
 * `<gezelHome>/eval-runs/`) so prior trial dirs accumulate for the
 * history view. v1 defers cleanup to the user; old runs live until
 * manually removed.
 */
export async function runEval(
  req: RunEvalRequest,
  opts: {
    runsDir: string;
    onEvent: (event: RunEvalEvent) => void | Promise<void>;
    signal?: AbortSignal;
  },
): Promise<TrialOutcome | null> {
  const resolved = resolveEvalBinary();
  if (!resolved) {
    const message =
      'Eval harness not available in this build (looks like a packaged install). ' +
      'Run evals from the repo via `pnpm eval:run` for now; in-app eval running ' +
      'in packaged mode is on the roadmap.';
    await opts.onEvent({ type: 'error', error: message });
    return null;
  }
  const args = [
    ...resolved.args,
    req.scenarioId,
    '--model',
    req.modelId,
    '--runs-dir',
    opts.runsDir,
  ];
  if (req.imageModelId) {
    args.push('--image-model', req.imageModelId);
  }
  if (req.timeoutMs) {
    args.push('--timeout', `${req.timeoutMs}`);
  }

  log.info(`[eval-runner] spawning ${resolved.cmd} ${args.join(' ')}`);
  let child: ChildProcess;
  try {
    child = spawn(resolved.cmd, args, {
      cwd: resolved.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Inherit GEZEL_* env so the child harness sees the user's
      // cache root, dev-home, API keys for the LLM judge, etc.
      env: { ...process.env },
      ...windowsHeadlessSpawnOptions(),
    });
  } catch (err) {
    await opts.onEvent({
      type: 'error',
      error: `failed to spawn eval harness: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }

  // Best-effort runDir/trialId capture from the harness's stdout — the
  // first 5 lines include `[trial] runDir=...` and `[trial] id=...`.
  // We grep them so the SSE consumer can show a stable identifier
  // immediately (rather than waiting until the child exits).
  let runDir: string | null = null;
  let trialId: string | null = null;
  let spawnedEmitted = false;

  async function handleStdout(chunk: Buffer): Promise<void> {
    const text = chunk.toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      if (!trialId) {
        const m = line.match(/\[trial\] id=(\S+)/);
        if (m) trialId = m[1] ?? null;
      }
      if (!runDir) {
        const m = line.match(/\[trial\] runDir=(\S+)/);
        if (m) runDir = m[1] ?? null;
      }
      if (!spawnedEmitted && trialId && runDir) {
        spawnedEmitted = true;
        await opts.onEvent({ type: 'spawned', trialId, runDir });
      }
      await opts.onEvent({ type: 'log', line });
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    void handleStdout(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    // Stderr from the harness is rare (mostly internal errors); mirror
    // into the log channel so the UI can show it inline.
    const text = chunk.toString('utf8');
    for (const line of text.split('\n').filter((l) => l.length > 0)) {
      void opts.onEvent({ type: 'log', line: `[stderr] ${line}` });
    }
  });

  const abortHandler = (): void => {
    log.info('[eval-runner] aborting child via SIGTERM');
    try {
      child.kill('SIGTERM');
    } catch (err) {
      log.warn(`[eval-runner] kill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  opts.signal?.addEventListener('abort', abortHandler);

  return new Promise<TrialOutcome | null>((resolveFn) => {
    child.on('exit', async (code, sig) => {
      opts.signal?.removeEventListener('abort', abortHandler);
      log.info(`[eval-runner] child exited code=${code} signal=${sig}`);
      // Try to read result.json from the runDir we observed.
      let outcome: TrialOutcome | null = null;
      if (runDir) {
        try {
          const raw = readFileSync(join(runDir, 'result.json'), 'utf8');
          outcome = JSON.parse(raw) as TrialOutcome;
        } catch (err) {
          log.warn(
            `[eval-runner] result.json missing/unreadable in ${runDir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (outcome) {
        await opts.onEvent({ type: 'done', result: outcome });
      } else {
        await opts.onEvent({
          type: 'error',
          error: `child exited (code=${code} signal=${sig}) before producing a result.json`,
        });
      }
      resolveFn(outcome);
    });
    child.on('error', async (err) => {
      await opts.onEvent({
        type: 'error',
        error: `child process error: ${err.message}`,
      });
      resolveFn(null);
    });
  });
}

/**
 * List prior trial outcomes from a runs directory. Reads each
 * `<runDir>/result.json` and returns them sorted by `startedAt` desc.
 * Silently skips dirs without a valid result.json (in-progress runs
 * or crashes that didn't reach finalize).
 */
export async function listEvalResults(opts: {
  runsDir: string;
  limit?: number;
  scenarioId?: string;
}): Promise<TrialOutcome[]> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(opts.runsDir);
  } catch {
    return [];
  }
  const out: TrialOutcome[] = [];
  for (const name of entries) {
    const dir = join(opts.runsDir, name);
    const resultPath = join(dir, 'result.json');
    if (!existsSync(resultPath)) continue;
    try {
      const r = JSON.parse(readFileSync(resultPath, 'utf8')) as TrialOutcome;
      if (opts.scenarioId && r.scenarioId !== opts.scenarioId) continue;
      out.push(r);
    } catch {
      // Skip malformed.
    }
  }
  out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

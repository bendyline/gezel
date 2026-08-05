import { isGezelEngineCommand, listProcessSnapshots } from '@bendyline/gezel-client/node';
import type { ProcessListEntry } from './gezel-process-memory.js';

const ORPHAN_REAP_WAIT_MS = 10_000;
const ORPHAN_REAP_POLL_MS = 150;

export interface GezelOrphanCleanupResult {
  /** Clearly-Gezel owner-less engines selected for cleanup. */
  targetedPids: number[];
  /** Targets still visible after the bounded post-SIGKILL wait. */
  remainingPids: number[];
}

export interface ReapOrphanedGezelEngineProcessesOptions {
  platform?: NodeJS.Platform;
  servicePid?: number;
  psRunner?: () => Promise<ProcessListEntry[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  waitTimeoutMs?: number;
}

/**
 * Sweep every known first-party Gezel engine family.
 *
 * The per-engine supervisor also reaps before launching, but that is
 * deliberately scoped to the engine being started. A DS4 chat therefore
 * cannot discover an abandoned MLX Python server. Running this once after the
 * same-home daemon lock is acquired closes that cross-engine gap.
 *
 * Safety is intentionally strict: argv[0] must be one of our `gezel-*` native
 * binaries, or Python's first script argument must be a `gezel_*_server.py`.
 * On Unix, PPID 1 proves its owner exited. Windows retains the creator pid
 * instead of reparenting, so the creator must be absent from the same process
 * snapshot. The sweep is intentionally not home-scoped: production engines
 * can load models from the machine-shared store and run binaries from app
 * resources, leaving no user-home path in their command line. Ownerlessness
 * is the cross-home safety proof; a process with any live owner is untouched.
 */
export async function reapOrphanedGezelEngineProcesses(
  opts: ReapOrphanedGezelEngineProcessesOptions = {},
): Promise<GezelOrphanCleanupResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return { targetedPids: [], remainingPids: [] };
  }

  const psRunner = opts.psRunner ?? (() => listProcessSnapshots({ platform }));
  const killProcess = opts.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const servicePid = opts.servicePid ?? process.pid;
  const initial = await psRunner();
  const livePids = new Set(initial.map(({ pid }) => pid));
  const targetedPids = initial
    .filter(({ command }) => isGezelEngineCommand(command))
    .filter(
      ({ pid, ppid }) =>
        pid !== servicePid && (platform === 'win32' ? !livePids.has(ppid) : ppid === 1),
    )
    .map(({ pid }) => pid);

  for (const pid of targetedPids) {
    try {
      killProcess(pid, 'SIGKILL');
    } catch {
      // The process may have exited between ps and kill. The post-kill scan
      // below is authoritative and startup must not fail over cleanup.
    }
  }

  let remainingPids = await findRemaining(targetedPids, psRunner);
  const deadline = Date.now() + (opts.waitTimeoutMs ?? ORPHAN_REAP_WAIT_MS);
  while (remainingPids.length > 0 && Date.now() < deadline) {
    await sleep(ORPHAN_REAP_POLL_MS);
    remainingPids = await findRemaining(remainingPids, psRunner);
  }
  return { targetedPids, remainingPids };
}

async function findRemaining(
  pids: number[],
  psRunner: () => Promise<ProcessListEntry[]>,
): Promise<number[]> {
  if (pids.length === 0) return [];
  const alive = new Set((await psRunner()).map(({ pid }) => pid));
  return pids.filter((pid) => alive.has(pid));
}

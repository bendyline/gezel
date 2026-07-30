import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type ProcessListEntry,
  findGezelEngineProcesses,
  parseProcessList,
} from './gezel-process-memory.js';

const exec = promisify(execFile);
const ORPHAN_REAP_WAIT_MS = 10_000;
const ORPHAN_REAP_POLL_MS = 150;

export interface GezelOrphanCleanupResult {
  /** Same-home, clearly-Gezel PPID-1 engines selected for cleanup. */
  targetedPids: number[];
  /** Targets still visible after the bounded post-SIGKILL wait. */
  remainingPids: number[];
}

export interface ReapOrphanedGezelEngineProcessesOptions {
  home: string;
  platform?: NodeJS.Platform;
  servicePid?: number;
  psRunner?: () => Promise<ProcessListEntry[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  waitTimeoutMs?: number;
}

/**
 * Sweep every known engine family for the current Gezel home.
 *
 * The per-engine supervisor also reaps before launching, but that is
 * deliberately scoped to the engine being started. A DS4 chat therefore
 * cannot discover an abandoned MLX Python server. Running this once after the
 * same-home daemon lock is acquired closes that cross-engine gap.
 *
 * Safety is intentionally strict: the command must identify a known Gezel
 * native/Python engine, contain this service's exact home path, and have PPID
 * 1. A non-init parent means another live daemon still owns it.
 */
export async function reapOrphanedGezelEngineProcesses(
  opts: ReapOrphanedGezelEngineProcessesOptions,
): Promise<GezelOrphanCleanupResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return { targetedPids: [], remainingPids: [] };
  }

  const psRunner = opts.psRunner ?? defaultPsRunner;
  const killProcess = opts.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const servicePid = opts.servicePid ?? process.pid;
  const initial = await psRunner();
  const targetedPids = findGezelEngineProcesses(initial, opts.home)
    .filter(({ pid, ppid }) => pid !== servicePid && ppid === 1)
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

async function defaultPsRunner(): Promise<ProcessListEntry[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseProcessList(String(stdout));
}

/**
 * Cross-process ownership for evals that start a local chat/image engine.
 *
 * A cache-root-scoped lock is not sufficient: two eval processes can use
 * different caches while still competing for the same GPU, and each daemon's
 * native-engine orphan cleanup can see the other daemon's child. The default
 * therefore lives directly under the current OS user's home, independent of
 * model/cache/run directories.
 *
 * `mkdir` is the ownership primitive because creating a directory is atomic on
 * every platform Node supports. The JSON inside is diagnostic metadata, not
 * the source of exclusivity. A dead owner is removed by first atomically
 * renaming its directory to a deterministic owner-specific quarantine path.
 * That tombstone is deliberately retained: a delayed second reclaimer that
 * inspected the same dead owner cannot rename (and steal) the replacement
 * lock because its destination already exists and is non-empty.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  type AcquireEvalSleepGuardOptions,
  type EvalSleepGuardLease,
  acquireEvalSleepGuard,
} from './eval-sleep-guard.ts';
import { type ChatProvider, isLocalEngine } from './providers.ts';
import type { EvalScenario } from './types.ts';

export const EVAL_DEVICE_LOCK_BYPASS_ENV = 'GEZEL_EVAL_ALLOW_CONCURRENT';
export const EVAL_DEVICE_LOCK_PATH_ENV = 'GEZEL_EVAL_LOCK_PATH';

const OWNER_FILE = 'owner.json';
const DEFAULT_LOCK_NAME = '.gezel-eval-device.lock';

export interface EvalDeviceLockOwner {
  pid: number;
  startedAt: string;
  command: string;
  ownerId: string;
  hostname: string;
}

interface ProcessEvents {
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

export interface AcquireEvalDeviceLockOptions {
  /** Override the default/env lock location (primarily for tests). */
  lockPath?: string;
  /** Override process metadata (primarily for deterministic tests). */
  pid?: number;
  command?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  isProcessAlive?: (pid: number) => boolean;
  processEvents?: ProcessEvents;
  /** Override macOS sleep-guard dependencies (primarily for tests). */
  sleepGuard?: AcquireEvalSleepGuardOptions | false;
}

export interface EvalDeviceLockLease {
  /** False only when the explicit unsafe escape hatch bypassed ownership. */
  acquired: boolean;
  lockPath: string;
  release(): void;
}

interface ActiveLock {
  depth: number;
  owner: EvalDeviceLockOwner;
  processEvents: ProcessEvents;
  exitHandler: () => void;
  sleepGuard: EvalSleepGuardLease | null;
}

const activeLocks = new Map<string, ActiveLock>();

function defaultLockPath(env: NodeJS.ProcessEnv): string {
  const configured = env[EVAL_DEVICE_LOCK_PATH_ENV]?.trim();
  return resolve(configured || join(homedir(), DEFAULT_LOCK_NAME));
}

function defaultCommand(): string {
  // Limit diagnostic metadata so an accidentally huge argv cannot inflate a
  // tiny coordination file. Eval flags do not contain credentials.
  return [process.execPath, ...process.argv.slice(1)].join(' ').slice(0, 4096);
}

function parseOwner(lockPath: string): EvalDeviceLockOwner | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(lockPath, OWNER_FILE), 'utf8'),
    ) as Partial<EvalDeviceLockOwner>;
    if (
      !Number.isInteger(raw.pid) ||
      (raw.pid ?? 0) <= 0 ||
      typeof raw.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.startedAt)) ||
      typeof raw.command !== 'string' ||
      typeof raw.ownerId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(raw.ownerId) ||
      typeof raw.hostname !== 'string'
    ) {
      return null;
    }
    return raw as EvalDeviceLockOwner;
  } catch {
    return null;
  }
}

/**
 * `kill(pid, 0)` sends no signal. ESRCH proves the pid no longer exists;
 * EPERM and every other error are treated conservatively as "alive" because
 * deleting a live owner's lock is worse than asking for manual inspection.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

export class EvalDeviceLockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly owner: EvalDeviceLockOwner | null,
  ) {
    const ownerDetail = owner
      ? `pid ${owner.pid} on ${owner.hostname}, started ${owner.startedAt}\n  command: ${owner.command}`
      : 'owner metadata is missing or malformed; refusing to guess that the owner is dead';
    super(
      `local eval device is already reserved (${ownerDetail})\n  lock: ${lockPath}\nWait for that eval to finish. If concurrent local engines are intentionally safe on this machine, set ${EVAL_DEVICE_LOCK_BYPASS_ENV}=1 for the new command (unsafe: results and engine cleanup may interfere).`,
    );
    this.name = 'EvalDeviceLockBusyError';
  }
}

function removeIfOwned(lockPath: string, ownerId: string): void {
  if (parseOwner(lockPath)?.ownerId !== ownerId) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Best effort during process exit. A failed cleanup is safely recoverable
    // once this PID is dead; it must not replace the eval's real exit status.
  }
}

function releaseReference(lockPath: string, ownerId: string): void {
  const active = activeLocks.get(lockPath);
  if (!active || active.owner.ownerId !== ownerId) return;
  active.depth -= 1;
  if (active.depth > 0) return;

  active.processEvents.off('exit', active.exitHandler);
  active.sleepGuard?.release();
  activeLocks.delete(lockPath);
  removeIfOwned(lockPath, ownerId);
}

/**
 * Acquire the machine-device reservation for this OS user. Acquisition fails
 * immediately when a live owner exists; it never waits invisibly behind a
 * multi-hour matrix.
 */
export function acquireEvalDeviceLock(
  options: AcquireEvalDeviceLockOptions = {},
): EvalDeviceLockLease {
  const env = options.env ?? process.env;
  const lockPath = resolve(options.lockPath ?? defaultLockPath(env));

  if (env[EVAL_DEVICE_LOCK_BYPASS_ENV] === '1') {
    return { acquired: false, lockPath, release: () => {} };
  }

  // Matrix → batch → preflight/trial orchestration may share this helper in
  // one process. One physical lock with reference counting avoids self-
  // deadlock while retaining the whole outer operation's ownership window.
  const alreadyActive = activeLocks.get(lockPath);
  if (alreadyActive) {
    alreadyActive.depth += 1;
    let released = false;
    return {
      acquired: true,
      lockPath,
      release: () => {
        if (released) return;
        released = true;
        releaseReference(lockPath, alreadyActive.owner.ownerId);
      },
    };
  }

  const pid = options.pid ?? process.pid;
  const processAlive = options.isProcessAlive ?? isProcessAlive;
  const processEvents = options.processEvents ?? process;

  // Usually one iteration. Retries only cover a concurrent stale-owner
  // recovery changing the canonical path between our read and rename.
  let recoveryRetries = 0;
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;

      const owner = parseOwner(lockPath);
      if (!owner || processAlive(owner.pid)) {
        throw new EvalDeviceLockBusyError(lockPath, owner);
      }

      const quarantine = join(dirname(lockPath), `.${basename(lockPath)}.stale-${owner.ownerId}`);
      try {
        // Atomic source rename. The deterministic, non-empty destination is
        // retained forever as a generation tombstone. A contender that read
        // this same stale owner before us will target the same destination;
        // rename then fails instead of moving our replacement lock.
        renameSync(lockPath, quarantine);
      } catch (renameError) {
        if (
          renameError instanceof Error &&
          'code' in renameError &&
          (renameError.code === 'ENOENT' ||
            renameError.code === 'EEXIST' ||
            renameError.code === 'ENOTEMPTY' ||
            // Windows may report an existing directory target as EPERM.
            // Confirm the tombstone exists before treating that as a race;
            // a real permission failure must remain loud.
            existsSync(quarantine))
        ) {
          recoveryRetries += 1;
          if (recoveryRetries > 8) {
            throw new EvalDeviceLockBusyError(lockPath, parseOwner(lockPath));
          }
          continue;
        }
        throw renameError;
      }
      continue;
    }

    const owner: EvalDeviceLockOwner = {
      pid,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      command: options.command ?? defaultCommand(),
      ownerId: randomUUID(),
      hostname: hostname(),
    };
    try {
      writeFileSync(join(lockPath, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }

    const sleepGuard =
      options.sleepGuard === false ? null : acquireEvalSleepGuard({ ...options.sleepGuard, pid });
    const exitHandler = () => {
      const active = activeLocks.get(lockPath);
      if (active?.owner.ownerId === owner.ownerId) {
        active.sleepGuard?.release();
        activeLocks.delete(lockPath);
      }
      removeIfOwned(lockPath, owner.ownerId);
    };
    processEvents.once('exit', exitHandler);
    activeLocks.set(lockPath, {
      depth: 1,
      owner,
      processEvents,
      exitHandler,
      sleepGuard,
    });

    let released = false;
    return {
      acquired: true,
      lockPath,
      release: () => {
        if (released) return;
        released = true;
        releaseReference(lockPath, owner.ownerId);
      },
    };
  }
}

/** Cloud-only text evals do not reserve the local device. A local image model
 * still does, even when chat is hosted remotely. */
export function evalNeedsDeviceLock(input: {
  provider: ChatProvider;
  scenarios?: readonly Pick<EvalScenario, 'defaultImageModelId'>[];
  imageModelId?: string;
}): boolean {
  return (
    isLocalEngine(input.provider) ||
    Boolean(input.imageModelId) ||
    Boolean(input.scenarios?.some((scenario) => scenario.defaultImageModelId))
  );
}

/** Acquire only when this CLI invocation can start a local native engine. */
export function acquireEvalDeviceLockIfNeeded(input: {
  provider: ChatProvider;
  scenarios?: readonly Pick<EvalScenario, 'defaultImageModelId'>[];
  imageModelId?: string;
  options?: AcquireEvalDeviceLockOptions;
}): EvalDeviceLockLease | null {
  if (!evalNeedsDeviceLock(input)) return null;
  return acquireEvalDeviceLock(input.options);
}

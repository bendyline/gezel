import { mkdir, open, readFile, rm } from 'node:fs/promises';

/**
 * Thrown when a gezel home already has a live daemon. The CLI's `gezel
 * start` / the supervisor surface this as an actionable message rather
 * than a stack trace.
 */
export class SingleInstanceError extends Error {
  constructor(
    readonly holderPid: number,
    readonly lockPath: string,
  ) {
    super(
      holderPid > 0
        ? `Another gezel daemon is already running for this home (pid ${holderPid}). Stop it first (e.g. \`gezel stop\`), or use a different GEZEL_HOME.`
        : `Could not acquire the single-instance lock at ${lockPath}.`,
    );
    this.name = 'SingleInstanceError';
  }
}

export interface RuntimeLock {
  release(): Promise<void>;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → exists but we can't signal it
    // (alive, owned by another user). Anything else → treat as dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolderPid(lockPath: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire an exclusive single-instance lock for a gezel home so two daemons
 * can't share one `~/.gezel/` and race its on-disk state (config, sessions,
 * tasks, runtime files). Atomic `O_CREAT|O_EXCL` create of
 * `<runtimeDir>/lock` holding the owner pid; a stale lock (dead holder) is
 * reclaimed. Throws {@link SingleInstanceError} when a live daemon holds it.
 *
 * The returned `release()` removes the lock — call it on graceful shutdown.
 * A hard crash leaves a stale lock that the next start reclaims via the
 * pid-liveness check.
 */
export async function acquireSingleInstanceLock(opts: {
  runtimeDir: string;
  lockPath: string;
  isAlive?: (pid: number) => boolean;
}): Promise<RuntimeLock> {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  await mkdir(opts.runtimeDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(opts.lockPath, 'wx'); // fails with EEXIST if present
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return {
        async release() {
          // Only remove the lock if it's still ours — defends against a
          // narrow race where another process reclaimed our stale lock.
          const holder = await readHolderPid(opts.lockPath);
          if (holder === null || holder === process.pid) {
            await rm(opts.lockPath, { force: true }).catch(() => {});
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readHolderPid(opts.lockPath);
      if (holder !== null && holder !== process.pid && isAlive(holder)) {
        throw new SingleInstanceError(holder, opts.lockPath);
      }
      // Stale (dead holder / our own pid / unreadable) — reclaim and retry.
      await rm(opts.lockPath, { force: true }).catch(() => {});
    }
  }
  throw new SingleInstanceError(-1, opts.lockPath);
}

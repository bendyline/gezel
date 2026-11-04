import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises';
import {
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_STALE_AFTER_MS,
  type LockIdentity,
  currentLockIdentity,
  foreignHolderMessage,
  parseLockFile,
  procStartTicks,
  sharesPidNamespace,
} from '@bendyline/gezel/native';

export type { LockIdentity };
export { currentLockIdentity, parseLockFile, procStartTicks, sharesPidNamespace };

/**
 * Thrown when a gezel home already has a live daemon. The CLI's `gezel
 * start` / the supervisor surface this as an actionable message rather
 * than a stack trace.
 */
export class SingleInstanceError extends Error {
  constructor(
    readonly holderPid: number,
    readonly lockPath: string,
    readonly holderHost?: string,
  ) {
    super(
      holderHost !== undefined
        ? foreignHolderMessage({ pid: holderPid, hostname: holderHost })
        : holderPid > 0
          ? `Another gezel daemon is already running for this home (pid ${holderPid}). Stop it first with \`gezel stop\`, or use a different GEZEL_HOME.`
          : `Could not acquire the single-instance lock at ${lockPath}.`,
    );
    this.name = 'SingleInstanceError';
  }
}

export interface RuntimeLock {
  release(): Promise<void>;
}

// A holder's identity (core's lock-identity.ts) is what let a one-shot
// `docker run … gezel do` stop reclaiming a serving container's live lock.

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

/**
 * The pid stays on the first line so a daemon from before the identity
 * record (which parses the leading integer) still reads it as held instead
 * of stale.
 */
function serializeIdentity(identity: LockIdentity): string {
  return `${identity.pid}\n${JSON.stringify({ v: 1, ...identity })}\n`;
}

async function readHolder(lockPath: string): Promise<LockIdentity | null> {
  try {
    return parseLockFile(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function lockMtimeMs(lockPath: string): Promise<number | null> {
  try {
    return (await stat(lockPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A holder outside our pid namespace is alive while its heartbeat moves.
 * A fresh-looking mtime may be a holder that died moments ago (a killed
 * container restarting onto its own volume), so wait until the heartbeat
 * either advances (alive) or ages past the stale bound (dead).
 */
async function foreignHolderIsAlive(
  lockPath: string,
  opts: { now: () => number; sleep: (ms: number) => Promise<void>; staleAfterMs: number },
): Promise<boolean> {
  const first = await lockMtimeMs(lockPath);
  if (first === null) return false;
  for (;;) {
    if (opts.now() - first > opts.staleAfterMs) return false;
    await opts.sleep(1_000);
    const current = await lockMtimeMs(lockPath);
    if (current === null) return false;
    if (current !== first) return true;
  }
}

/**
 * Acquire an exclusive single-instance lock for a gezel home so two daemons
 * can't share one `~/.gezel/` and race its on-disk state (config, sessions,
 * tasks, runtime files). Atomic `O_CREAT|O_EXCL` create of
 * `<runtimeDir>/lock` holding the owner's identity; a stale lock is
 * reclaimed. Throws {@link SingleInstanceError} when a live daemon holds it.
 *
 * While held, the lock file's mtime is touched every few seconds: that
 * heartbeat is how a daemon in another container (another pid namespace)
 * is told apart from a dead one.
 *
 * The returned `release()` stops the heartbeat and removes the lock — call
 * it on graceful shutdown. A hard crash leaves a stale lock the next start
 * reclaims.
 */
export async function acquireSingleInstanceLock(opts: {
  runtimeDir: string;
  lockPath: string;
  isAlive?: (pid: number) => boolean;
  identity?: LockIdentity;
  startTicksOf?: (pid: number) => string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
}): Promise<RuntimeLock> {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const me = opts.identity ?? currentLockIdentity();
  const startTicksOf = opts.startTicksOf ?? procStartTicks;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const staleAfterMs = opts.staleAfterMs ?? LOCK_STALE_AFTER_MS;
  await mkdir(opts.runtimeDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(opts.lockPath, 'wx'); // fails with EEXIST if present
      try {
        await handle.writeFile(serializeIdentity(me));
      } finally {
        await handle.close();
      }
      return holdLock(opts.lockPath, me, opts.heartbeatIntervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readHolder(opts.lockPath);
      if (holder) {
        if (!sharesPidNamespace(holder, me)) {
          if (await foreignHolderIsAlive(opts.lockPath, { now, sleep, staleAfterMs })) {
            throw new SingleInstanceError(holder.pid, opts.lockPath, holder.hostname ?? 'unknown');
          }
        } else if (holder.pid !== me.pid && isAlive(holder.pid)) {
          // A recorded start time that no longer matches means the pid was
          // reused by an unrelated process after the holder died.
          const reused =
            holder.startTicks !== undefined &&
            startTicksOf(holder.pid) !== undefined &&
            startTicksOf(holder.pid) !== holder.startTicks;
          if (!reused) throw new SingleInstanceError(holder.pid, opts.lockPath);
        }
      }
      // Stale (dead holder / our own pid / unreadable) — reclaim and retry.
      await rm(opts.lockPath, { force: true }).catch(() => {});
    }
  }
  throw new SingleInstanceError(-1, opts.lockPath);
}

function holdLock(lockPath: string, me: LockIdentity, intervalMs: number): RuntimeLock {
  const isOurs = (holder: LockIdentity | null) =>
    holder === null ||
    (me.instance !== undefined && holder.instance !== undefined
      ? holder.instance === me.instance
      : holder.pid === me.pid);
  let timer: NodeJS.Timeout | undefined = setInterval(() => {
    void (async () => {
      const holder = await readHolder(lockPath);
      if (holder === null || !isOurs(holder)) {
        // Someone else owns the file now; touching it would keep their lock
        // looking alive on our behalf.
        clearInterval(timer);
        timer = undefined;
        return;
      }
      const at = new Date();
      await utimes(lockPath, at, at).catch(() => {});
    })();
  }, intervalMs);
  timer.unref?.();
  return {
    async release() {
      if (timer) clearInterval(timer);
      timer = undefined;
      // Only remove the lock if it's still ours — defends against a
      // narrow race where another process reclaimed our stale lock.
      if (isOurs(await readHolder(lockPath))) {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    },
  };
}

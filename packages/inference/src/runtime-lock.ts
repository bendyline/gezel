import { readFileSync, readlinkSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';

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
        ? `Another Gezel daemon (host "${holderHost}", pid ${holderPid}) is using this home. If it runs in a container, run commands inside that container with \`docker exec <container> gezel …\` instead of starting a second container on the same volume.`
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

/**
 * Who holds a lock. A pid alone identifies a process only inside one pid
 * namespace on one boot: two containers sharing a volume each see the
 * other's pid as dead (or as an unrelated process), which let a one-shot
 * `docker run … gezel do` reclaim a serving container's live lock. The
 * namespace, boot and host fields say when a pid check is meaningful; a
 * holder outside our namespace is judged by the lock file's heartbeat.
 */
export interface LockIdentity {
  pid: number;
  hostname?: string;
  bootId?: string;
  pidNs?: string;
  /** Process start time in clock ticks since boot (`/proc/<pid>/stat` field 22). */
  startTicks?: string;
  /** Random per-process id; tells our own heartbeat whether the lock is still ours. */
  instance?: string;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_AFTER_MS = 40_000;

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

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function procStartTicks(pid: number | 'self'): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const stat = readTrimmed(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  // comm (field 2) may contain spaces and parentheses; fields resume after
  // the last ')'. starttime is field 22 overall, the 20th after comm.
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return rest[19];
}

export function currentLockIdentity(): LockIdentity {
  const linux = process.platform === 'linux';
  let pidNs: string | undefined;
  if (linux) {
    try {
      pidNs = readlinkSync('/proc/self/ns/pid');
    } catch {
      pidNs = undefined;
    }
  }
  return {
    pid: process.pid,
    hostname: osHostname(),
    bootId: linux ? readTrimmed('/proc/sys/kernel/random/boot_id') : undefined,
    pidNs,
    startTicks: procStartTicks('self'),
    instance: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  };
}

/**
 * The pid stays on the first line so a daemon from before the identity
 * record (which parses the leading integer) still reads it as held instead
 * of stale.
 */
function serializeIdentity(identity: LockIdentity): string {
  return `${identity.pid}\n${JSON.stringify({ v: 1, ...identity })}\n`;
}

export function parseLockFile(text: string): LockIdentity | null {
  const [first, second] = text.split('\n');
  const pid = Number.parseInt((first ?? '').trim(), 10);
  if (!Number.isFinite(pid)) return null;
  if (!second?.trim()) return { pid };
  try {
    const record = JSON.parse(second) as Partial<LockIdentity>;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    return {
      pid,
      hostname: text(record.hostname),
      bootId: text(record.bootId),
      pidNs: text(record.pidNs),
      startTicks: text(record.startTicks),
      instance: text(record.instance),
    };
  } catch {
    return { pid };
  }
}

async function readHolder(lockPath: string): Promise<LockIdentity | null> {
  try {
    return parseLockFile(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a pid check against `holder` means anything here. Any field the
 * holder recorded must match ours; a legacy pid-only record is assumed to be
 * in our namespace, which is how it was judged before.
 */
export function sharesPidNamespace(holder: LockIdentity, me: LockIdentity): boolean {
  const same = (a: string | undefined, b: string | undefined) => !a || !b || a === b;
  return (
    same(holder.hostname, me.hostname) &&
    same(holder.bootId, me.bootId) &&
    same(holder.pidNs, me.pidNs)
  );
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
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  await mkdir(opts.runtimeDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(opts.lockPath, 'wx'); // fails with EEXIST if present
      try {
        await handle.writeFile(serializeIdentity(me));
      } finally {
        await handle.close();
      }
      return holdLock(opts.lockPath, me, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
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

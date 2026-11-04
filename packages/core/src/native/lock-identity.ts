import { readFileSync, readlinkSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';

/**
 * Who holds a home's single-instance lock (`<home>/runtime/lock`). A pid alone
 * identifies a process only inside one pid namespace on one boot: two
 * containers sharing a volume each see the other's pid as dead, or as an
 * unrelated process of their own. The namespace, boot and host fields say when
 * a pid check is meaningful; a holder outside our namespace is judged by the
 * lock file's heartbeat (its mtime) instead.
 *
 * Shared by the daemon that takes the lock (inference's `runtime-lock.ts`) and
 * the clients that decide whether to adopt the daemon its runtime files name
 * (`@bendyline/gezel-client`'s discovery), so both read a holder the same way.
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

/** How often a holder touches its lock file. */
export const LOCK_HEARTBEAT_INTERVAL_MS = 10_000;
/** A lock whose heartbeat is older than this belongs to a daemon that died. */
export const LOCK_STALE_AFTER_MS = 40_000;

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

/** What to tell someone whose home is in use by a daemon in another container. */
export function foreignHolderMessage(holder: Pick<LockIdentity, 'pid' | 'hostname'>): string {
  return `Another Gezel daemon (host "${holder.hostname ?? 'unknown'}", pid ${holder.pid}) is using this home. If it runs in a container, run commands inside that container with \`docker exec <container> gezel …\` instead of starting a second container on the same volume.`;
}

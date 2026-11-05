import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * One PID the probe refuses blanks every row in its batch: macOS ps prints
 * "process id too large" past XNU's PID_MAX, and Get-Process -Id binds Int32.
 * A PID past the limit cannot be live, so it is left out like an absent one.
 */
const PROBE_PID_LIMIT: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 99_999,
  win32: 2_147_483_647,
};

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Birth stamps survive coordinator restarts and distinguish a reused PID. */
export async function readProcessIdentities(
  pids: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const limit = PROBE_PID_LIMIT[process.platform] ?? Number.MAX_SAFE_INTEGER;
  const ids = [...new Set(pids)].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= limit,
  );
  const identities = new Map<number, string>();
  if (!ids.length) return identities;
  try {
    if (process.platform === 'linux') {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      await Promise.all(
        ids.map(async (pid) => {
          const value = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
          if (!value) return;
          // comm may contain spaces and parentheses; fields after its final ')' start at field 3.
          const start = value
            .slice(value.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/)[19];
          if (start && /^\d+$/.test(start)) identities.set(pid, `${boot}:${start}`);
        }),
      );
    } else {
      const windows = process.platform === 'win32';
      const { stdout } = await exec(
        windows ? 'powershell.exe' : 'ps',
        windows
          ? [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + ":" + $_.StartTime.ToUniversalTime().Ticks.ToString() } catch {} }`,
            ]
          : ['-p', ids.join(','), '-o', 'pid=', '-o', 'lstart='],
        {
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 256 * 1024,
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
        },
      ).catch((error: { stdout?: string }) => {
        // ps (and Windows process lookup) may return live rows alongside a missing PID error.
        if (typeof error.stdout === 'string') return { stdout: error.stdout };
        throw error;
      });
      for (const line of stdout.split(/\r?\n/)) {
        const match = windows
          ? /^\s*(\d+):(\d+)\s*$/.exec(line)
          : /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (match && ids.includes(Number(match[1]))) identities.set(Number(match[1]), match[2]!);
      }
    }
  } catch {
    // Access denied or an unavailable OS probe is unknown, never proof of death.
  }
  return identities;
}

/**
 * How long a stamp read for a still-live PID is trusted. A PID can die and be
 * reused between two liveness checks; this bounds how long such a dead
 * engine's reservation outlives it. That is the safe direction: memory looks
 * taken for a few seconds longer, never free twice.
 */
export const VERIFIED_IDENTITY_TTL_MS = 10_000;

export interface ProcessIdentityCacheOptions {
  read?: (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>;
  alive?: (pid: number) => boolean;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Reading a birth stamp starts `ps`, or PowerShell on Windows. The capacity
 * ledger used to read every PID it holds on each command, which ran before
 * every engine request. A stamp read for a PID that is still alive is reused
 * for a short while, and the PIDs that do need reading go in one batch.
 *
 * A cached stamp may only confirm the stamp a reservation already recorded.
 * A stamp about to be recorded, or one that disagrees, is read again: another
 * coordinator may have recorded a newer process at that PID, and trusting an
 * older stamp there would free a live engine's memory.
 */
export class ProcessIdentityCache {
  private readonly verified = new Map<number, { identity: string; at: number }>();

  constructor(private readonly options: ProcessIdentityCacheOptions = {}) {}

  /**
   * `record`: PIDs whose stamp is about to be written onto a reservation.
   * `confirm`: each PID's stamps as reservations recorded them.
   * PIDs that are dead, or whose stamp cannot be read, are left out.
   */
  async lookup(
    record: Iterable<number>,
    confirm: ReadonlyMap<number, readonly string[]>,
  ): Promise<ReadonlyMap<number, string>> {
    const alive = this.options.alive ?? processAlive;
    const ttl = this.options.ttlMs ?? VERIFIED_IDENTITY_TTL_MS;
    const now = (this.options.now ?? (() => performance.now()))();
    for (const [pid, entry] of this.verified) {
      if (now - entry.at >= ttl) this.verified.delete(pid);
    }
    const live = (pid: number) => {
      if (alive(pid)) return true;
      // Forget a PID seen dead, so whatever process takes it next is read.
      this.verified.delete(pid);
      return false;
    };
    const identities = new Map<number, string>();
    const unread = new Set<number>();
    for (const pid of record) if (live(pid)) unread.add(pid);
    for (const [pid, stamps] of confirm) {
      if (unread.has(pid) || !live(pid)) continue;
      const cached = this.verified.get(pid)?.identity;
      if (cached !== undefined && stamps.every((stamp) => stamp === cached)) {
        identities.set(pid, cached);
      } else {
        unread.add(pid);
      }
    }
    if (unread.size === 0) return identities;
    const read = await (this.options.read ?? readProcessIdentities)([...unread]).catch(
      () => new Map<number, string>(),
    );
    for (const pid of unread) {
      const identity = read.get(pid);
      if (identity === undefined) {
        this.verified.delete(pid);
        continue;
      }
      this.verified.set(pid, { identity, at: now });
      identities.set(pid, identity);
    }
    return identities;
  }
}

/** One cache per process: every ledger in it asks about the same OS processes. */
export const sharedProcessIdentities = new ProcessIdentityCache();

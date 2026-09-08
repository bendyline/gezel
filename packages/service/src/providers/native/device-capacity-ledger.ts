import { chmod, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { NativeCapacityCommand, NativeCapacityReply } from '@bendyline/gezel';
import { CapacityDeniedError } from './capacity-broker.js';

// Keep the newer builtin behind a runtime require. The current tsup/esbuild
// target rewrites a static `node:sqlite` import to the nonexistent npm package
// `sqlite`, making the daemon bundle fail before it can write runtime state.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export interface DeviceCapacitySample {
  budgetBytes: number;
  gpuBudgetBytes: number;
  availableBytes?: number;
  availableGpuBytes?: number;
  serializeLoads: boolean;
}

interface Claim {
  id: string;
  ownerPid: number;
  childPid?: number;
  label: string;
  bytes: number;
  gpuBytes: number;
  exclusive: boolean;
  priority: 'interactive' | 'background';
  bypasses: number;
  phase: 'waiting' | 'loading' | 'ready';
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * SQLite's process lock makes check-and-reserve atomic across GEZEL_HOME values.
 * Reservations survive a broker restart. A dead parent does not free the memory
 * of a surviving engine child, and a live owner never loses a lease to a TTL.
 */
export class DeviceCapacityLedger {
  constructor(
    private readonly options: {
      directory: string;
      sample: () => Promise<DeviceCapacitySample>;
      alive?: (pid: number) => boolean;
    },
  ) {}

  async execute(command: NativeCapacityCommand): Promise<NativeCapacityReply> {
    const sample = await this.options.sample();
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const path = join(this.options.directory, 'leases.sqlite');
    const db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, claim TEXT NOT NULL)');
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = this.transact(db, command, sample);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
  }

  private transact(
    db: DatabaseSyncType,
    command: NativeCapacityCommand,
    sample: DeviceCapacitySample,
  ): NativeCapacityReply {
    const alive = this.options.alive ?? processAlive;
    const rows = db.prepare('SELECT claim FROM claims ORDER BY rowid').all();
    const claims = rows.map((row) => JSON.parse(String(row.claim)) as Claim);
    const remove = db.prepare('DELETE FROM claims WHERE id = ?');
    const save = db.prepare('UPDATE claims SET claim = ? WHERE id = ?');
    const live = claims.filter((claim) => {
      // An unbound grant with a dead owner could have spawned just before the
      // owner died. Keep it conservatively; never guess that its bytes are free.
      const stale =
        (claim.childPid !== undefined && !alive(claim.childPid)) ||
        (!alive(claim.ownerPid) && claim.phase === 'waiting');
      if (stale) remove.run(claim.id);
      return !stale;
    });
    let own = live.find((c) => c.id === command.id);
    if (command.action === 'release') {
      remove.run(command.id);
      return { state: 'released', releaseRequested: false };
    }
    if (command.action === 'acquire' && !own) {
      if (command.bytes > sample.budgetBytes || command.gpuBytes > sample.gpuBudgetBytes) {
        throw new CapacityDeniedError(
          `Not enough memory to load ${command.label}: its planned working set exceeds this device's safe model capacity.`,
        );
      }
      own = {
        id: command.id,
        ownerPid: command.ownerPid,
        label: command.label,
        bytes: command.bytes,
        gpuBytes: command.gpuBytes,
        exclusive: command.exclusive,
        phase: 'waiting',
        priority: command.priority ?? 'interactive',
        bypasses: 0,
      };
      db.prepare('INSERT INTO claims (id, claim) VALUES (?, ?)').run(own.id, JSON.stringify(own));
      live.push(own);
    }
    if (!own) return { state: 'released', releaseRequested: false };
    if (command.action === 'acquire' && command.priority === 'interactive')
      own.priority = 'interactive';
    if (command.action === 'bind' && own.phase !== 'waiting') own.childPid = command.childPid;
    if (command.action === 'ready' && own.phase === 'loading') own.phase = 'ready';
    const active = live.filter((c) => c.phase !== 'waiting');
    const waiting = live.filter((c) => c.phase === 'waiting');
    const first =
      waiting.find((c) => c.bypasses >= 4) ??
      waiting.find((c) => c.priority !== 'background') ??
      waiting[0];
    const fits = (request: Claim) =>
      active.reduce((sum, c) => sum + c.bytes, request.bytes) <= sample.budgetBytes &&
      active.reduce((sum, c) => sum + c.gpuBytes, request.gpuBytes) <= sample.gpuBudgetBytes &&
      !(
        request.gpuBytes > 0 &&
        active.some((c) => c.gpuBytes > 0 && (c.exclusive || request.exclusive))
      );
    // Set only when the ONLY thing in the way is memory this protocol does
    // not govern: the request leads the queue, fits the budget, and no other
    // claim is loading or resident. Waiting cannot help — see the waiter.
    let shortfall: { requiredBytes: number; availableBytes: number } | undefined;
    if (own === first && fits(own)) {
      const loading = active.filter((c) => c.phase === 'loading');
      const memoryAvailable =
        sample.availableBytes === undefined ||
        own.bytes + loading.reduce((sum, c) => sum + c.bytes, 0) <= sample.availableBytes;
      const gpuAvailable =
        sample.availableGpuBytes === undefined ||
        own.gpuBytes + loading.reduce((sum, c) => sum + c.gpuBytes, 0) <= sample.availableGpuBytes;
      const loadSlot =
        !sample.serializeLoads || own.gpuBytes === 0 || !loading.some((c) => c.gpuBytes > 0);
      if (memoryAvailable && gpuAvailable && loadSlot) {
        own.phase = 'loading';
        for (const older of waiting.slice(0, waiting.indexOf(own))) {
          older.bypasses = (older.bypasses ?? 0) + 1;
          save.run(JSON.stringify(older), older.id);
        }
      } else if (active.length === 0) {
        // `loadSlot` can only be false behind a loading claim, so reaching
        // here with no active claims means the host itself is short.
        if (!memoryAvailable && sample.availableBytes !== undefined)
          shortfall = { requiredBytes: own.bytes, availableBytes: sample.availableBytes };
        else if (!gpuAvailable && sample.availableGpuBytes !== undefined)
          shortfall = { requiredBytes: own.gpuBytes, availableBytes: sample.availableGpuBytes };
      }
    }
    save.run(JSON.stringify(own), own.id);
    // FIFO within a lane, with bounded priority bypass, protects large and
    // background requests from an endless stream of small interactive arrivals.
    // Only owners stop their own idle engine; this protocol never sends signals.
    const releaseRequested =
      own.phase !== 'waiting' &&
      first !== undefined &&
      first !== own &&
      (!fits(first) ||
        (sample.availableBytes !== undefined && first.bytes > sample.availableBytes) ||
        (sample.availableGpuBytes !== undefined && first.gpuBytes > sample.availableGpuBytes));
    return {
      state: own.phase === 'waiting' ? 'waiting' : 'granted',
      releaseRequested,
      ...(own.phase === 'waiting'
        ? shortfall
          ? {
              reason:
                `Waiting for memory to load ${own.label}: it needs ${gb(shortfall.requiredBytes)} ` +
                `and this device has ${gb(shortfall.availableBytes)} available.`,
              externalShortfall: true,
              requiredBytes: shortfall.requiredBytes,
              availableBytes: shortfall.availableBytes,
            }
          : {
              reason: `Waiting for memory to load ${own.label}; another engine or application is using the available capacity.`,
            }
        : {}),
    };
  }
}

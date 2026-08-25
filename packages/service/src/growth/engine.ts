/**
 * Growth engine — recomputes a gezel's XP from learning signals and,
 * when a level threshold is crossed, creates a pending level-up with
 * user-resolvable proposals. Levels advance ONLY when the user resolves
 * a pending (accept or skip) — never silently. XP keeps accruing while
 * a choice is pending; only one pending exists at a time.
 *
 * Ambient refreshes ride the memory compactor's daily sweep; the HTTP
 * refresh route calls in directly (user-initiated). Both respect
 * `config.growth.enabled`.
 */

import {
  type GezelGrowthState,
  type GrowthSignals,
  KeyedLock,
  createLogger,
  xpForLevel,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { CompactOneShot } from '../memory/compaction.js';
import { isMemoryKind } from '../memory/daily-markdown.js';
import type { MemoryManager } from '../memory/manager.js';
import { generateProposals } from './proposals.js';
import { computeSignals, countTaskWork, ratchetSignals, totalXp } from './xp.js';

const log = createLogger('growth');

export interface GrowthEngineOptions {
  store: Store;
  memory: MemoryManager;
  history: HistoryManager;
  /** `ChatManager.oneShotCompletion` bound — injected so tests can stub it. */
  oneShot: CompactOneShot;
  /** Announcement hook — wired to `ChatManager.announceGrowth` in service.ts. */
  announce?: (gezelId: string, toLevel: number) => Promise<void>;
}

export class GrowthEngine {
  private readonly store: Store;
  private readonly memory: MemoryManager;
  private readonly history: HistoryManager;
  private readonly oneShot: CompactOneShot;
  private readonly announce: ((gezelId: string, toLevel: number) => Promise<void>) | undefined;
  private readonly gezelLocks = new KeyedLock();

  constructor(opts: GrowthEngineOptions) {
    this.store = opts.store;
    this.memory = opts.memory;
    this.history = opts.history;
    this.oneShot = opts.oneShot;
    this.announce = opts.announce;
  }

  /**
   * Recompute signals/XP, persist, and create a pendingLevelUp when a
   * threshold is crossed. `allowKlerk` gates trait-proposal generation;
   * when false (or the Klerk fails) a crossed threshold still produces
   * a pending with tuning + cosmetic options only. `createPending: false`
   * recomputes XP only — used by the GET route's background freshness
   * pass so a signals-only refresh can't preempt the daily sweep's
   * Klerk-backed proposal generation with a payout-only pending.
   * Idempotent: an existing pending is returned untouched (XP still
   * refreshes).
   */
  async refresh(
    gezelId: string,
    opts: { allowKlerk: boolean; createPending?: boolean },
  ): Promise<GezelGrowthState> {
    return this.runExclusive(gezelId, () => this.refreshLocked(gezelId, opts));
  }

  /**
   * Serialize growth-state mutations for one gezel. `growth.json` writes are
   * whole-file last-writer-wins, so every read-modify-write — refresh here,
   * accept/decline/trait-removal in the routes — must run under this lock.
   * Unserialized, the background refresh the sheet GET fires could write
   * back a `pendingLevelUp` the user consumed while it computed,
   * resurrecting the level-up for a second accept.
   */
  runExclusive<T>(gezelId: string, fn: () => Promise<T>): Promise<T> {
    return this.gezelLocks.run(gezelId, fn);
  }

  private async refreshLocked(
    gezelId: string,
    opts: { allowKlerk: boolean; createPending?: boolean },
  ): Promise<GezelGrowthState> {
    const config = await this.store.readConfig();
    if (config.growth?.enabled === false) {
      return this.store.readGezelGrowth(gezelId);
    }

    const prev = await this.store.readGezelGrowth(gezelId);
    const signals = ratchetSignals(prev.signals, await this.computeLiveSignals(gezelId));
    const xp = totalXp(signals);
    let state: GezelGrowthState = {
      ...prev,
      signals,
      xp,
      lastComputedAt: new Date().toISOString(),
    };

    // Offer one threshold at a time, only when nothing is already pending.
    if (
      (opts.createPending ?? true) &&
      !state.pendingLevelUp &&
      xp >= xpForLevel(state.level + 1)
    ) {
      const toLevel = state.level + 1;
      const gezel = await this.store.getGezel(gezelId).catch(() => null);
      const proposals = await generateProposals({
        store: this.store,
        memory: this.memory,
        oneShot: this.oneShot,
        gezelId,
        toLevel,
        state,
        frontmatter: gezel?.parsed.frontmatter ?? {},
        allowKlerk: opts.allowKlerk,
      });
      state = {
        ...state,
        pendingLevelUp: { toLevel, proposals, createdAt: new Date().toISOString() },
      };
      await this.store.writeGezelGrowth(gezelId, state);
      const name = gezel?.name ?? gezelId;
      await this.history
        .log({
          kind: 'gezel.level.up',
          gezelId,
          summary: `${name} reached level ${toLevel} — growth choices await`,
          details: {
            toLevel,
            xp,
            proposalKinds: proposals.map((p) => p.kind),
          },
        })
        .catch(() => {});
      log.info(`[growth] ${gezelId} reached level ${toLevel} (${proposals.length} proposals)`);
      try {
        await this.announce?.(gezelId, toLevel);
      } catch (err) {
        log.warn(
          `[growth] announce failed for ${gezelId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return state;
    }

    await this.store.writeGezelGrowth(gezelId, state);
    return state;
  }

  /** Gather live inputs and compute (un-ratcheted) signals. */
  private async computeLiveSignals(gezelId: string): Promise<GrowthSignals> {
    const entries = await this.memory.allEntries('gezel', gezelId);
    const memoryEntries = entries.map((e) => ({
      kind: isMemoryKind(e.kind) ? e.kind : ('fact' as const),
    }));

    const [lessonsEvents, consultEvents, tasks] = await Promise.all([
      this.history.listEvents({ gezelId, kinds: ['memory.lessons-updated'] }).catch(() => []),
      this.history.listEvents({ gezelId, kinds: ['gezel.message.delivered'] }).catch(() => []),
      this.store.listAllTasks().catch(() => []),
    ]);

    const consultationsByDay = new Map<string, number>();
    for (const e of consultEvents) {
      const day = e.at.slice(0, 10);
      consultationsByDay.set(day, (consultationsByDay.get(day) ?? 0) + 1);
    }

    const { completedSteps, completedTasks } = countTaskWork(tasks, gezelId);

    return computeSignals({
      memoryEntries,
      lessonsUpdates: lessonsEvents.length,
      completedSteps,
      completedTasks,
      consultationsByDay,
    });
  }
}

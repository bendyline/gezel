import { generateGrowthProposals } from '../growth/proposals.js';
import { computeSignals, countTaskWork, ratchetSignals, totalXp } from '../growth/xp.js';
import { KeyedLock } from '../keyed-lock.js';
import { createLogger } from '../log.js';
import { type GezelGrowthState, xpForLevel } from '../schemas/growth.js';
import type { PortableStore } from './store.js';

const log = createLogger('growth');

export interface PortableGrowthDeps {
  store: PortableStore;
  /** One background completion by the Klerk; throws when no model can run. */
  complete(prompt: string): Promise<string>;
  /** Chars of memory a proposal prompt may carry, sized to the Klerk's window. */
  proposalBudget(): Promise<number>;
  /** Tell the person a gezel levelled up (held while social mode is off). */
  announce?(gezelId: string, toLevel: number): Promise<void>;
  /** XP changed; the UI refreshes badges and the Growth tab. */
  onUpdated?(gezelId: string, xp: number): void;
}

/**
 * Gezel growth on the phone: the desktop engine's refresh over the phone's
 * own sources — the task store for completed work, the memory files for what
 * a gezel wrote down, delivered messages for consultations. The phone has no
 * lessons distiller, so lessons XP holds at whatever it was ratcheted to.
 */
export class PortableGrowth {
  private readonly locks = new KeyedLock();

  constructor(private readonly deps: PortableGrowthDeps) {}

  /** Every read-modify-write of one gezel's growth.json runs under this lock. */
  runExclusive<T>(gezelId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(gezelId, fn);
  }

  refresh(
    gezelId: string,
    opts: { allowKlerk: boolean; createPending?: boolean },
  ): Promise<GezelGrowthState> {
    return this.runExclusive(gezelId, () => this.refreshLocked(gezelId, opts));
  }

  private async refreshLocked(
    gezelId: string,
    opts: { allowKlerk: boolean; createPending?: boolean },
  ): Promise<GezelGrowthState> {
    const { store } = this.deps;
    const prev = await store.readGezelGrowth(gezelId);
    if ((await store.readConfig()).growth?.enabled === false) return prev;
    const signals = ratchetSignals(prev.signals, await this.liveSignals(gezelId));
    const xp = totalXp(signals);
    const state: GezelGrowthState = {
      ...prev,
      signals,
      xp,
      lastComputedAt: new Date().toISOString(),
    };
    // One threshold at a time, and only when nothing is already waiting.
    if (
      (opts.createPending ?? true) &&
      !state.pendingLevelUp &&
      xp >= xpForLevel(state.level + 1)
    ) {
      const gezel = await store.getGezel(gezelId).catch(() => null);
      const toLevel = state.level + 1;
      const proposals = await generateGrowthProposals({
        sources: {
          authoredEntries: () => store.authoredMemoryEntries(gezelId),
          activeTraits: async () => gezel?.parsed.frontmatter.traits ?? [],
          lessons: () => store.readMemoryLessons(gezelId),
          complete: (prompt) => this.deps.complete(prompt),
        },
        gezelId,
        toLevel,
        state,
        frontmatter: gezel?.parsed.frontmatter ?? {},
        allowKlerk: opts.allowKlerk,
        ...(opts.allowKlerk
          ? { inputBudget: await this.deps.proposalBudget().catch(() => 6_000) }
          : {}),
      });
      state.pendingLevelUp = { toLevel, proposals, createdAt: new Date().toISOString() };
      await store.writeGezelGrowth(gezelId, state);
      log.info(`${gezelId} reached level ${toLevel} (${proposals.length} proposals)`);
      await this.deps
        .announce?.(gezelId, toLevel)
        .catch((err) => log.warn(`announce failed for ${gezelId}:`, err));
      this.deps.onUpdated?.(gezelId, xp);
      return state;
    }
    await store.writeGezelGrowth(gezelId, state);
    if (xp !== prev.xp) this.deps.onUpdated?.(gezelId, xp);
    return state;
  }

  private async liveSignals(gezelId: string) {
    const { store } = this.deps;
    const [entries, tasks, consultationsByDay] = await Promise.all([
      store.authoredMemoryEntries(gezelId),
      store.listTasks(),
      store.consultationsByDay(gezelId),
    ]);
    const work = countTaskWork(tasks, gezelId);
    return computeSignals({
      memoryEntries: entries,
      lessonsUpdates: 0,
      completedSteps: work.completedSteps,
      completedTasks: work.completedTasks,
      consultationsByDay,
    });
  }
}

/**
 * GrowthHistoryTally
 *
 * The two history counts XP needs per gezel — `memory.lessons-updated` events
 * and `gezel.message.delivered` events by day — built with one pass over the
 * audit log and then kept current from `HistoryManager.subscribe`. Each XP
 * refresh used to scan the whole log twice (once per kind) for every gezel:
 * 1.4M events in a bulk workflow home, a fifth of the daemon's main thread
 * while the memory compactor's sweep refreshed each gezel (2026-10-27).
 *
 * How it stays exact: the listener counts only once a build has begun. While
 * the build pass runs, the listener and the pass share the set of ids counted
 * so far and each skips what the other counted, so an event appended mid-pass
 * counts once whichever sees it first. A delete or redaction bumps
 * `rewriteGeneration`; the next read rebuilds from scratch.
 *
 * Usage: `GrowthEngine` owns one for the life of the service and awaits
 * `countsFor(gezelId)` inside each refresh. The first call pays for the pass;
 * concurrent callers share it.
 *
 * Related files: `engine.ts` (consumer), `history/manager.ts` (`subscribe`,
 * `iterateEvents`, `rewriteGeneration`), `core/src/growth/xp.ts` (how the
 * counts become XP).
 *
 * Gotchas: events are matched exactly as `listEvents({ gezelId, kinds })`
 * matched them: on the event's own `gezelId`, not on details. A home whose
 * growth is disabled never builds the tally, so it never costs anything.
 */
import type { HistoryEvent, HistoryEventKind } from '@bendyline/gezel';
import type { HistoryManager } from '../history/manager.js';

const LESSONS: HistoryEventKind = 'memory.lessons-updated';
const CONSULT: HistoryEventKind = 'gezel.message.delivered';

export interface GrowthHistoryCounts {
  lessonsUpdates: number;
  consultationsByDay: ReadonlyMap<string, number>;
}

type TallySource = Pick<HistoryManager, 'subscribe' | 'iterateEvents' | 'rewriteGeneration'>;

export class GrowthHistoryTally {
  private lessons = new Map<string, number>();
  private consults = new Map<string, Map<string, number>>();
  /** The rewrite generation the counts were built at; -1 before any build. */
  private builtAt = -1;
  private build: Promise<void> | null = null;
  /** Ids counted so far while a build pass runs, by the pass or the listener. */
  private countedDuringBuild: Set<string> | null = null;

  constructor(private readonly history: TallySource) {
    history.subscribe((event) => this.onLogged(event));
  }

  async countsFor(gezelId: string): Promise<GrowthHistoryCounts> {
    while (this.builtAt !== this.history.rewriteGeneration) {
      this.build ??= this.rebuild().finally(() => {
        this.build = null;
      });
      await this.build;
    }
    return {
      lessonsUpdates: this.lessons.get(gezelId) ?? 0,
      consultationsByDay: new Map(this.consults.get(gezelId) ?? []),
    };
  }

  private onLogged(event: HistoryEvent): void {
    if (this.countedDuringBuild) this.countOnce(event, this.countedDuringBuild);
    else if (this.builtAt !== -1) this.add(event);
  }

  private async rebuild(): Promise<void> {
    const generation = this.history.rewriteGeneration;
    this.lessons = new Map();
    this.consults = new Map();
    this.builtAt = -1;
    const counted = new Set<string>();
    this.countedDuringBuild = counted;
    try {
      for await (const event of this.history.iterateEvents({ kinds: [LESSONS, CONSULT] })) {
        this.countOnce(event, counted);
      }
      this.builtAt = generation;
    } finally {
      this.countedDuringBuild = null;
    }
  }

  private countOnce(event: HistoryEvent, counted: Set<string>): void {
    // An id-less line (hand-written, very old) cannot be deduplicated; it
    // still counts, as it did in `listEvents`.
    if (event.id && counted.has(event.id)) return;
    if (this.add(event) && event.id) counted.add(event.id);
  }

  /** Count one event if it is one XP reads. Returns whether it counted. */
  private add(event: HistoryEvent): boolean {
    const gezelId = event.gezelId;
    if (!gezelId) return false;
    if (event.kind === LESSONS) {
      this.lessons.set(gezelId, (this.lessons.get(gezelId) ?? 0) + 1);
      return true;
    }
    if (event.kind === CONSULT) {
      let byDay = this.consults.get(gezelId);
      if (!byDay) {
        byDay = new Map();
        this.consults.set(gezelId, byDay);
      }
      const day = event.at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      return true;
    }
    return false;
  }
}

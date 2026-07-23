import { createLogger } from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { HistoryManager } from '../history/manager.js';
import type { Store } from './store.js';

/**
 * Maintains the per-project "last activity" stamp (`activity.json`) by
 * listening on the two buses every meaningful project touch already
 * flows through: the history log (tasks, documents, tool calls, project
 * edits) and the chat event bus (every turn, including streamed deltas).
 *
 * `project.updatedAt` can't serve this role — it only bumps on explicit
 * metadata edits (see the scheduler's nudge sweep, which used to
 * recompute activity by loading every session on every pass). This
 * tracker gives the same answer as a cheap stored stamp.
 *
 * Write discipline: stamps land in memory on every event; disk only
 * sees a write when the stamp moved ≥5 min past the persisted value.
 * Chat deltas arrive many times a second mid-turn — persisting each
 * would be pure write amplification for a value nobody reads at that
 * resolution.
 */

const log = createLogger('activity');

const PERSIST_THRESHOLD_MS = 5 * 60_000;

/**
 * Ambient generators must not count as project activity — a digest or
 * status report that re-armed the "meaningfully changed" check would
 * schedule itself forever.
 */
const SELF_KINDS: ReadonlySet<string> = new Set([
  'project.digest.generated',
  'meester.status.generated',
  'project.nudge.sent',
]);

export interface ActivityTrackerOptions {
  store: Store;
  history: HistoryManager;
  chatEvents: ChatEventBus;
  now?: () => number;
  persistThresholdMs?: number;
}

export class ActivityTracker {
  private readonly store: Store;
  private readonly history: HistoryManager;
  private readonly chatEvents: ChatEventBus;
  private readonly now: () => number;
  private readonly persistThresholdMs: number;

  /** Newest observed stamp per project (ms epoch). */
  private readonly latest = new Map<string, number>();
  /** Stamp last written to (or read from) disk per project. */
  private readonly persisted = new Map<string, number>();
  /** Projects whose on-disk stamp has been loaded into `persisted`. */
  private readonly loads = new Map<string, Promise<void>>();
  private readonly writing = new Set<string>();
  private unsubs: Array<() => void> = [];

  constructor(opts: ActivityTrackerOptions) {
    this.store = opts.store;
    this.history = opts.history;
    this.chatEvents = opts.chatEvents;
    this.now = opts.now ?? (() => Date.now());
    this.persistThresholdMs = opts.persistThresholdMs ?? PERSIST_THRESHOLD_MS;
  }

  start(): void {
    this.unsubs.push(
      this.history.subscribe((event) => {
        if (!event.projectId || SELF_KINDS.has(event.kind)) return;
        const at = Date.parse(event.at);
        this.stamp(event.projectId, Number.isFinite(at) ? at : this.now());
      }),
    );
    this.unsubs.push(
      this.chatEvents.subscribeAll((envelope) => {
        if (!envelope.projectId) return;
        this.stamp(envelope.projectId, this.now());
      }),
    );
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    await this.flush();
  }

  stamp(projectId: string, atMs: number): void {
    const current = this.latest.get(projectId) ?? 0;
    if (atMs <= current) return;
    this.latest.set(projectId, atMs);
    void this.maybePersist(projectId).catch((err) =>
      log.warn(`activity persist for ${projectId} failed: ${String(err)}`),
    );
  }

  /**
   * Newest known activity for a project — max of the in-memory stamp
   * and the on-disk one (loaded once). Null when the project has never
   * been observed.
   */
  async lastActivityAt(projectId: string): Promise<string | null> {
    await this.ensureLoaded(projectId);
    const ms = Math.max(this.latest.get(projectId) ?? 0, this.persisted.get(projectId) ?? 0);
    return ms > 0 ? new Date(ms).toISOString() : null;
  }

  /** Persist every stamp that is newer than its on-disk value. */
  async flush(): Promise<void> {
    for (const [projectId, ms] of this.latest) {
      await this.ensureLoaded(projectId);
      if (ms > (this.persisted.get(projectId) ?? 0)) {
        await this.write(projectId, ms).catch((err) =>
          log.warn(`activity flush for ${projectId} failed: ${String(err)}`),
        );
      }
    }
  }

  private async maybePersist(projectId: string): Promise<void> {
    await this.ensureLoaded(projectId);
    if (this.writing.has(projectId)) return;
    const latest = this.latest.get(projectId) ?? 0;
    const persisted = this.persisted.get(projectId) ?? 0;
    if (latest - persisted < this.persistThresholdMs) return;
    this.writing.add(projectId);
    try {
      await this.write(projectId, latest);
    } finally {
      this.writing.delete(projectId);
    }
  }

  private async write(projectId: string, ms: number): Promise<void> {
    await this.store.writeProjectActivity(projectId, {
      lastActivityAt: new Date(ms).toISOString(),
    });
    this.persisted.set(projectId, ms);
  }

  private ensureLoaded(projectId: string): Promise<void> {
    let load = this.loads.get(projectId);
    if (!load) {
      load = this.store
        .readProjectActivity(projectId)
        .then((activity) => {
          const ms = activity ? Date.parse(activity.lastActivityAt) : Number.NaN;
          if (Number.isFinite(ms)) {
            this.persisted.set(projectId, Math.max(this.persisted.get(projectId) ?? 0, ms));
          }
        })
        .catch(() => undefined);
      this.loads.set(projectId, load);
    }
    return load;
  }
}

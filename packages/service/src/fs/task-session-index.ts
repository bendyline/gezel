/**
 * TaskSessionIndex
 *
 * An in-memory map from a task ref to the chat sessions bound to it, kept by
 * one store. Finding a task's sessions used to mean listing every session file
 * of a gezel, or of the whole home, and stat-ing each one. A media-review task
 * did that three times (session create, gate outcome, completion wrap-up) over
 * 45k–112k files, 1.7–4.8 s per listing at 20 workers. The daemon's file I/O
 * threads saturated and step completion doubled to 17 s (2026-10-27).
 *
 * The store feeds the index: every session it writes, deletes or summarises
 * while listing is noted. A gezel counts as complete once one full listing of
 * its sessions has finished; sessions written after that are noted as they are
 * written, so the gezel stays complete for the life of the process. Until then,
 * `Store.listTaskSessions` lists the gezel once to complete it.
 *
 * Only task-bound sessions take memory: two map entries each.
 *
 * Related files: `store.ts` (`listTaskSessions`; feeds the index),
 * `task-lineage-index.ts` (the same pattern for parent → child tasks).
 *
 * Gotchas: a session file created behind the store's back (a sync from another
 * machine, a hand copy) is found only after its gezel's next full listing. The
 * store re-reads each indexed session's summary through its stat-checked cache,
 * so a stale entry costs one stat, never a wrong answer.
 */

/** One session's identity inside the index. */
export interface IndexedSession {
  gezelId: string;
  sessionId: string;
}

export class TaskSessionIndex {
  /** `gezelId/sessionId` → the task ref it is bound to. */
  private readonly taskOf = new Map<string, string>();
  /** Task ref → `gezelId/sessionId` keys. */
  private readonly sessionsOf = new Map<string, Set<string>>();
  private readonly complete = new Set<string>();
  private readonly builds = new Map<string, Promise<unknown>>();

  /** Record (or correct) one session's task binding as it stands on disk. */
  note(gezelId: string, sessionId: string, taskRef: string | undefined): void {
    const key = `${gezelId}/${sessionId}`;
    const previous = this.taskOf.get(key);
    if (previous === taskRef) return;
    if (previous !== undefined) this.drop(key, previous);
    if (!taskRef) return;
    this.taskOf.set(key, taskRef);
    let keys = this.sessionsOf.get(taskRef);
    if (!keys) {
      keys = new Set();
      this.sessionsOf.set(taskRef, keys);
    }
    keys.add(key);
  }

  forget(gezelId: string, sessionId: string): void {
    const key = `${gezelId}/${sessionId}`;
    const previous = this.taskOf.get(key);
    if (previous !== undefined) this.drop(key, previous);
  }

  /** A full listing of the gezel's sessions finished: every one has been noted. */
  markComplete(gezelId: string): void {
    this.complete.add(gezelId);
  }

  isComplete(gezelId: string): boolean {
    return this.complete.has(gezelId);
  }

  /**
   * Run `list` (a full listing that notes every session and marks the gezel
   * complete) for each gezel not yet complete, once per gezel however many
   * callers are waiting on it.
   */
  async completeGezels(
    gezelIds: string[],
    list: (gezelId: string) => Promise<unknown>,
  ): Promise<void> {
    await Promise.all(
      gezelIds
        .filter((gezelId) => !this.complete.has(gezelId))
        .map((gezelId) => {
          let build = this.builds.get(gezelId);
          if (!build) {
            build = list(gezelId).finally(() => this.builds.delete(gezelId));
            this.builds.set(gezelId, build);
          }
          return build;
        }),
    );
  }

  /** Sessions noted as bound to `taskRef`. */
  sessionsFor(taskRef: string): IndexedSession[] {
    return [...(this.sessionsOf.get(taskRef) ?? [])].map((key) => {
      const slash = key.indexOf('/');
      return { gezelId: key.slice(0, slash), sessionId: key.slice(slash + 1) };
    });
  }

  private drop(key: string, taskRef: string): void {
    this.taskOf.delete(key);
    const keys = this.sessionsOf.get(taskRef);
    keys?.delete(key);
    if (keys?.size === 0) this.sessionsOf.delete(taskRef);
  }
}

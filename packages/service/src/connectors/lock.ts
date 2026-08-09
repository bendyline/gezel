/**
 * Per-project async serialization for connector work. Sync passes, binding
 * mutations, and action commits all read-modify-write the same project state
 * (project.json bindings, the corpus, the `_actions` staging dirs), so the
 * sync manager and the action manager share ONE instance — a commit can't
 * race a sync or a concurrent discard on the same project.
 */
export class ProjectLocks {
  private readonly locks = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }
}

/**
 * Run `fn` over a work source keeping up to `width()` calls in flight. The
 * source is either a fixed array or a pull supplier (`undefined` = no more
 * work) — the supplier form lets a caller re-query its work-list as slots
 * open, so the pool never drains to zero between what used to be fixed
 * batches. Width is re-read as slots free, so a lazily-initialized provider
 * (reporting 1 until its first call spins it up) widens mid-batch. `stop`
 * halts NEW dispatches; in-flight calls always finish. sqlite writes inside
 * `fn` stay safe under this interleaving: the driver is synchronous, so
 * statements never actually overlap — only the awaited model calls do.
 */
export async function runPooled<T>(
  source: readonly T[] | (() => Promise<T | undefined> | T | undefined),
  width: () => number,
  fn: (item: T) => Promise<void>,
  stop?: () => boolean,
): Promise<void> {
  let next: () => Promise<T | undefined> | T | undefined;
  if (typeof source === 'function') {
    next = source;
  } else {
    let i = 0;
    next = () => (i < source.length ? (source[i++] as T) : undefined);
  }
  const state: { failure: { error: unknown } | null } = { failure: null };
  const active = new Set<Promise<void>>();
  let exhausted = false;
  const dispatch = async () => {
    while (
      !exhausted &&
      active.size < Math.max(1, width()) &&
      !stop?.() &&
      state.failure === null
    ) {
      const item = await next();
      if (item === undefined) {
        exhausted = true;
        break;
      }
      const p: Promise<void> = fn(item)
        .catch((error) => {
          state.failure ??= { error };
        })
        .finally(() => active.delete(p));
      active.add(p);
    }
  };
  await dispatch();
  while (active.size > 0) {
    await Promise.race(active);
    await dispatch();
  }
  if (state.failure) throw state.failure.error;
}

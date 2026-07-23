/**
 * One-shot "create" intents handed from the sidebar's "+" buttons to the
 * area views. Clicking "+" opens the area (Projects / Gezels / Documents)
 * and wants its create dialog to pop. The view registers its event
 * listener in a mount effect, which runs *after* the click dispatches —
 * so a plain event would be missed when the view wasn't already mounted.
 *
 * This module bridges that gap: the sidebar records the intent, the view
 * consumes it on mount. The accompanying `gezel:new-*` event still covers
 * the case where the view is already mounted (its listener is live).
 */
export type CreateKind = 'project' | 'gezel' | 'document';

let pending: CreateKind | null = null;
let clearScheduled = false;

/** Record that the user asked to create something of `kind`. */
export function requestCreate(kind: CreateKind): void {
  pending = kind;
  clearScheduled = false;
}

/**
 * Consume a pending intent for `kind`; returns true if set. The clear is
 * deferred to a microtask rather than firing synchronously so that
 * StrictMode's double-invoked render initializers (and a mount effect)
 * both observe the same intent within the same commit. By the next
 * microtask the intent is gone, so it can't leak into a later mount.
 */
export function consumeCreate(kind: CreateKind): boolean {
  if (pending === kind) {
    if (!clearScheduled) {
      clearScheduled = true;
      queueMicrotask(() => {
        pending = null;
        clearScheduled = false;
      });
    }
    return true;
  }
  return false;
}

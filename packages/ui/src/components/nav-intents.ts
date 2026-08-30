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
 *
 * **Consume from an effect, never from a render initializer.** The area
 * views are `lazy()`, so their first render happens under Suspense, and
 * React is free to render a component, throw that render away, and render
 * it again later. A `useState(() => consumeCreate(...))` observes the
 * intent during the discarded pass, the deferred clear below fires in the
 * meantime, and the render that actually commits sees nothing — the area
 * opens with no dialog. That reproduced on roughly two of every three
 * cold opens of the Gezellen "+".
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
 * Consume a pending intent for `kind`; returns true if set. Call this from
 * a mount effect — see the module note above.
 *
 * The clear is deferred to a microtask rather than firing synchronously so
 * that StrictMode's double-invoked mount effect observes the same intent
 * both times. Those two runs share a task; a discarded render and the
 * re-render that replaces it do not, which is why a render initializer is
 * not a safe place to call this from. By the next macrotask the intent is
 * gone, so it can't leak into a later mount.
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

/** Test seam. */
export function resetCreateIntents(): void {
  pending = null;
  clearScheduled = false;
}

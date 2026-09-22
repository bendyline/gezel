/**
 * The Escape that the Back gesture synthesizes to dismiss an overlay.
 *
 * Back means "close what is on top". It must never mean "abandon the work
 * underneath". The gesture dismisses overlays by dispatching a keyboard Escape,
 * which then bubbles to window like any other — so a listener that treats a
 * real Escape as a destructive shortcut, such as the composer cancelling a
 * running reply, would fire whenever an overlay declined to handle it. Marking
 * the synthetic event lets those listeners tell the two apart.
 */
const MARK = Symbol.for('gezel.backDismiss');

/** Mark an event as the Back gesture's overlay dismissal. */
export function markBackDismiss(event: Event): void {
  (event as unknown as Record<symbol, boolean>)[MARK] = true;
}

/** True when this event came from the Back gesture rather than a key press. */
export function isBackDismiss(event: Event): boolean {
  return (event as unknown as Record<symbol, boolean | undefined>)[MARK] === true;
}

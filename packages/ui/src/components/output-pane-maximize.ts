/**
 * Small window-event bridge between the project Output pane and the app
 * titlebar. The pane lives several component layers below App, but its
 * maximized state needs one persistent escape hatch in the titlebar because
 * the pane's own toolbar sits underneath that titlebar while maximized.
 */
export const OUTPUT_PANE_MAXIMIZED_EVENT = 'gezel:output-pane-maximized';
export const OUTPUT_PANE_RESTORE_EVENT = 'gezel:restore-output-pane';

export function reportOutputPaneMaximized(maximized: boolean): void {
  window.dispatchEvent(new CustomEvent(OUTPUT_PANE_MAXIMIZED_EVENT, { detail: { maximized } }));
}

export function requestOutputPaneRestore(): void {
  window.dispatchEvent(new CustomEvent(OUTPUT_PANE_RESTORE_EVENT));
}

/**
 * Ask a project's Output pane to open full window. Opening a board from a
 * finished card landed it in a half pane beside the chat (2026-10-11). The
 * request waits for the pane to mount, which follows the project's page
 * loading, and lapses after a short while so it never maximizes a later,
 * unrelated visit.
 */
export const OUTPUT_PANE_OPEN_FULL_EVENT = 'gezel:open-output-full';
const OPEN_FULL_TTL_MS = 30_000;
let pendingOpenFull: { projectId: string; at: number } | null = null;

export function requestOutputPaneFullWindow(projectId: string): void {
  pendingOpenFull = { projectId, at: Date.now() };
  window.dispatchEvent(new CustomEvent(OUTPUT_PANE_OPEN_FULL_EVENT, { detail: { projectId } }));
}

/** Whether a full-window request is waiting for this project; consumes it. */
export function takeOutputPaneFullWindow(projectId: string): boolean {
  const pending = pendingOpenFull;
  if (!pending || pending.projectId !== projectId) return false;
  pendingOpenFull = null;
  return Date.now() - pending.at <= OPEN_FULL_TTL_MS;
}

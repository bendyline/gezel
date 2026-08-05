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

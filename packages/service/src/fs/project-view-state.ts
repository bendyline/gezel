/** Project fields that record how the person is looking at it, not what it is. */
const PROJECT_VIEW_STATE_KEYS: ReadonlySet<string> = new Set(['selectedView', 'outputPaneVisible']);

/**
 * A project patch that changes nothing but view state (the Views tab's
 * choice, the Output pane). The scheduler reads `project.updatedAt` as
 * activity, and switching a view is not activity, so such a patch keeps it.
 */
export function isViewStateOnlyPatch(patch: object): boolean {
  const keys = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return keys.length > 0 && keys.every((key) => PROJECT_VIEW_STATE_KEYS.has(key));
}

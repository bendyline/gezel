/**
 * Paths reserved for task-internal working material rather than project
 * source. Keeping this convention in one authoring helper lets generated
 * gallery books and imported workflows make the same surface decision.
 *
 * A craftbook that genuinely intends one of these paths to ship as project
 * source should choose a source-oriented path instead of silently falling
 * back to the workspace drawer.
 */
export const ACCESSORY_ARTIFACT_PREFIXES = ['notes/', 'reviews/', 'reports/', 'tasks/'] as const;

/**
 * Authoring-time paths may still carry the per-task-folder template forms:
 * `{{task.dir}}` is the reserved runtime token (resolves to `tasks/<num>`)
 * and `{{workPath}}` is the conventional craftbook param whose default is
 * `{{task.dir}}`. Both name task-internal working material before
 * interpolation has run. Mirrors gilde's validator predicate — keep the
 * two in sync or the drawer discipline silently diverges between repos.
 */
const ACCESSORY_TEMPLATE_PREFIX = /^\{\{\s*(?:task\.dir|workPath)\s*\}\}\//;

/** True when a craftbook path names task-internal working material. */
export function isAccessoryArtifactPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (ACCESSORY_TEMPLATE_PREFIX.test(normalized)) return true;
  return ACCESSORY_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

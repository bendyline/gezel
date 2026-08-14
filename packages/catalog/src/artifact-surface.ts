/**
 * Paths reserved for task-internal working material rather than project
 * source. Keeping this convention in one authoring helper lets generated
 * gallery books and imported workflows make the same surface decision.
 *
 * A craftbook that genuinely intends one of these paths to ship as project
 * source should choose a source-oriented path instead of silently falling
 * back to the workspace drawer.
 */
export const ACCESSORY_ARTIFACT_PREFIXES = ['notes/', 'reviews/', 'reports/'] as const;

/** True when a craftbook path names task-internal working material. */
export function isAccessoryArtifactPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return ACCESSORY_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

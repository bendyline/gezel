/**
 * Provenance for projects gezel created by inferring a folder from a
 * document or a first-run pick (see `project-inference/`). Provenance only:
 * read-only behaviour comes from the ordinary write policy, because an
 * inferred project is created with `managedWorkspaceWritePolicy` unset and
 * an external `workingDir`, which `projectManagedWorkspaceWritable` already
 * treats as not writable.
 */

/** How the folder was chosen: `well-known`, `climb`, or `parent`. */
export const INFERRED_PROJECT_ORIGIN_PROPERTY = 'gezel.inferredOrigin';

/** Which client asked: `office`, `libreoffice`, `vscode`, `first-run`, … */
export const INFERRED_PROJECT_SOURCE_PROPERTY = 'gezel.inferredSource';

/** The well-known folder kind (`documents`, `pictures`, …) when there is one. */
export const INFERRED_PROJECT_WELL_KNOWN_PROPERTY = 'gezel.wellKnownKind';

export function isInferredProject(project: { properties?: Record<string, string> }): boolean {
  return Boolean(project.properties?.[INFERRED_PROJECT_ORIGIN_PROPERTY]);
}

export function inferredProjectOrigin(project: {
  properties?: Record<string, string>;
}): string | undefined {
  return project.properties?.[INFERRED_PROJECT_ORIGIN_PROPERTY];
}

export function inferredWellKnownKind(project: {
  properties?: Record<string, string>;
}): string | undefined {
  return project.properties?.[INFERRED_PROJECT_WELL_KNOWN_PROPERTY];
}

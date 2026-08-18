/**
 * The canonical `shared` project — the one whose workspace IS the shared
 * document library (`~/.gezel/documents/`, or wherever the user relocated
 * it). Making the library a project is what gives it the per-project service
 * stack: content index, office-document shadow conversion, enrichment,
 * the workspace watcher, and ranked search.
 *
 * The right-rail Documents area and the `*_document` tools are a facade over
 * this project, so its id has to be recognizable from the UI (which hides it
 * from the project list) and the service (which exempts it from jobsite
 * machinery like voorman recruitment and progress nudges).
 */

/** Default id. A pre-existing user project may own it — see the marker. */
export const SHARED_PROJECT_ID = 'shared';

/** Claimed when `shared` is already taken; the real id then lives in config. */
export const SHARED_PROJECT_FALLBACK_ID = 'shared-library';

/**
 * Property stamped on the project we created. A user's own project named
 * "Shared" slugifies to the same id, and adopting it would silently
 * repoint its workspace at the documents library, so identity is proven by
 * this marker rather than by the id alone.
 */
export const SHARED_PROJECT_MARKER = 'gezel.sharedLibrary';

/**
 * Whether this project is the shared library. Prefer this over comparing ids:
 * it is correct even when a collision pushed the library onto its fallback id.
 */
export function isSharedLibraryProject(project: {
  properties?: Record<string, string>;
}): boolean {
  return project.properties?.[SHARED_PROJECT_MARKER] === '1';
}

/**
 * Whether a project exists because a person made it, as opposed to the two
 * boot creates (`default` and the shared library). Any "has this install
 * been used?" heuristic must count these, not raw project totals.
 */
export function isUserCreatedProject(project: {
  id: string;
  properties?: Record<string, string>;
}): boolean {
  return project.id !== 'default' && !isSharedLibraryProject(project);
}

/** Resolve the effective id, honouring a collision redirect from config. */
export function resolveSharedProjectId(config?: { sharedProjectId?: string }): string {
  return config?.sharedProjectId ?? SHARED_PROJECT_ID;
}

/** True when this project is the shared library (by id, for a known config). */
export function isSharedProjectId(
  projectId: string | undefined,
  config?: { sharedProjectId?: string },
): boolean {
  return projectId !== undefined && projectId === resolveSharedProjectId(config);
}

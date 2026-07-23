/**
 * ─ Project-local gezel id codec ─────────────────────────────────────
 *
 * Project-local gezels live in a project's workspace `.gezel/` folder but
 * still flow through the *global* gezel id space — sessions, memories,
 * mentions, `voormanGezelId`, and `getGezel(id)` all key off a single
 * opaque string. To route those calls to the project-local store without
 * a parallel call graph, we give every project-local gezel an *encoded*
 * id that:
 *
 *   1. is a routing prefix (`tryGetGezel` checks it and delegates), and
 *   2. is a legal filesystem directory name AND a legal URL path segment,
 *      so all the existing app-data plumbing (poppetje.json, sessions/,
 *      memories/ under `~/.gezel/gezels/<id>/`) works UNCHANGED.
 *
 * Form: `proj__<projectId>__<localId>`.
 *
 * Both `projectId` and `localId` are `slugify()` output — `[a-z0-9-]`
 * only, never `_` — so `__` is an unambiguous delimiter and the first
 * `__` after the `proj__` prefix always separates the project from the
 * local id. A raw `:` / `/` scheme was rejected: `:` is illegal in
 * Windows paths and `/` would nest directories under the gezels root.
 */

/** Reserved local id for the canonical `@project` gezel (derived from AGENTS.md/CLAUDE.md). */
export const PROJECT_GEZEL_LOCAL_ID = 'project';

/** Prefix that marks an encoded project-local gezel id. */
export const PROJECT_GEZEL_ID_PREFIX = 'proj__';

const DELIM = '__';

/** Encode a project + local id into the global gezel id space. */
export function encodeProjectGezelId(projectId: string, localId: string): string {
  return `${PROJECT_GEZEL_ID_PREFIX}${projectId}${DELIM}${localId}`;
}

/** Convenience: the encoded id of a project's canonical `@project` gezel. */
export function projectGezelId(projectId: string): string {
  return encodeProjectGezelId(projectId, PROJECT_GEZEL_LOCAL_ID);
}

/**
 * Decode an encoded project-local gezel id. Returns null for any id that
 * isn't project-local (i.e. a normal global gezel id) so callers can use
 * it as a routing test: `const dec = decodeProjectGezelId(id); if (dec) …`.
 */
export function decodeProjectGezelId(id: string): { projectId: string; localId: string } | null {
  if (!id.startsWith(PROJECT_GEZEL_ID_PREFIX)) return null;
  const rest = id.slice(PROJECT_GEZEL_ID_PREFIX.length);
  const idx = rest.indexOf(DELIM);
  if (idx <= 0) return null;
  const projectId = rest.slice(0, idx);
  const localId = rest.slice(idx + DELIM.length);
  if (!projectId || !localId) return null;
  return { projectId, localId };
}

/** True when `id` belongs to the project-local namespace. */
export function isProjectGezelId(id: string): boolean {
  return decodeProjectGezelId(id) !== null;
}

/** True when `id` is the canonical `@project` gezel for some project. */
export function isCanonicalProjectGezelId(id: string): boolean {
  return decodeProjectGezelId(id)?.localId === PROJECT_GEZEL_LOCAL_ID;
}

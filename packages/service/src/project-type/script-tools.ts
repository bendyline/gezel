import type { Project, ProjectTypeManifest, ProjectTypeTool } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';

const log = createLogger('project-type');

/** Env var carrying the session's script-tool declarations to gezel-mcp. */
export const GEZEL_SCRIPT_TOOLS_ENV = 'GEZEL_SCRIPT_TOOLS';

/**
 * Resolve the applied type's manifest from a project's `projectType`
 * provenance. Version drift tolerance: when the pinned version is gone
 * (yanked, catalog updated), fall back to the type's current version.
 *
 * Non-throwing by design — a broken catalog must degrade to "no type
 * surface" (sessions still start; pages fall back to read-only), never
 * block the caller.
 */
export async function resolveProjectTypeManifest(
  catalog: CatalogService,
  project: Pick<Project, 'projectType'> | null | undefined,
): Promise<ProjectTypeManifest | null> {
  const provenance = project?.projectType;
  if (!provenance) return null;
  try {
    const detail =
      (await catalog.get('project-type', provenance.id, provenance.source, provenance.version)) ??
      (await catalog.get('project-type', provenance.id));
    if (!detail || detail.manifest.kind !== 'project-type') return null;
    return detail.manifest;
  } catch (err) {
    log.warn(
      `script-tools: failed to resolve type ${provenance.id}@${provenance.version}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * The script-backed tools a SESSION registers for the model. The
 * tool→script binding lives only in the type manifest (apply installs the
 * scripts to disk but persists nothing about tools), so sessions
 * re-resolve it from provenance at build time.
 *
 * Names listed in `pages.tools` are EXCLUDED: they are the page-only
 * surface — a checkers gezel must never see `user_move`. A tool needed on
 * both surfaces declares two names sharing one script + bind.
 */
export async function resolveProjectScriptTools(
  catalog: CatalogService,
  project: Pick<Project, 'projectType'> | null | undefined,
): Promise<ProjectTypeTool[]> {
  const manifest = await resolveProjectTypeManifest(catalog, project);
  if (!manifest) return [];
  const pageOnly = new Set(manifest.pages?.tools ?? []);
  return (manifest.tools ?? []).filter((t) => !pageOnly.has(t.name));
}

export interface ScriptToolReconciliation {
  /** The tool set to expose to the model this turn. */
  effective: ProjectTypeTool[];
  /** Update the session's persisted copy to `effective` (seed / refresh). */
  seed: boolean;
  /** Clear the persisted copy — the project's type is genuinely un-applied. */
  clear: boolean;
  /**
   * The fresh resolve came back empty but a persisted set was reused. Purely
   * diagnostic — the caller logs it so the transient failure leaves a trace
   * (the raw resolution failures upstream degrade to `[]` silently).
   */
  reused: boolean;
}

/**
 * Decide the script-tool surface for a session build, given the freshly
 * `resolved` set, the `persisted` last-known set from the session record, and
 * whether the project still declares a type (`typeStillApplied`).
 *
 * The invariant: a successful resolve is always the source of truth, but an
 * EMPTY resolve must never silently strip tools a session already had while
 * its project still declares a type — that empty is far more likely a
 * transient read/catalog failure than a real removal. Only a genuinely
 * un-applied type (provenance gone) clears the persisted copy. Pure so the
 * decision is unit-testable without a live session.
 */
export function reconcileScriptTools(
  resolved: ProjectTypeTool[],
  persisted: ProjectTypeTool[],
  typeStillApplied: boolean,
): ScriptToolReconciliation {
  if (resolved.length > 0) {
    const seed = JSON.stringify(resolved) !== JSON.stringify(persisted);
    return { effective: resolved, seed, clear: false, reused: false };
  }
  if (persisted.length > 0 && typeStillApplied) {
    return { effective: persisted, seed: false, clear: false, reused: true };
  }
  return { effective: [], seed: false, clear: persisted.length > 0, reused: false };
}

export interface ResolvedPageTools {
  /** Manifest display name — the reaction seed's envelope label. */
  typeName: string;
  /** Adoption params, for reaction template rendering. */
  params?: Record<string, unknown>;
  /** Only the tools listed in `pages.tools`, in declaration order. */
  tools: ProjectTypeTool[];
}

/**
 * The page-invokable tool surface for a project's applied type — the
 * server-side allowlist the page-invoke route enforces (the first-party
 * parent bridge checks the same names client-side as a fast-fail).
 */
export async function resolvePageTools(
  catalog: CatalogService,
  project: Pick<Project, 'projectType'> | null | undefined,
): Promise<ResolvedPageTools | null> {
  const manifest = await resolveProjectTypeManifest(catalog, project);
  if (!manifest) return null;
  const listed = new Set(manifest.pages?.tools ?? []);
  const params = project?.projectType?.params;
  return {
    typeName: manifest.name,
    ...(params ? { params } : {}),
    tools: (manifest.tools ?? []).filter((t) => listed.has(t.name)),
  };
}

export interface ResolvedPageReadScope {
  source: 'workspace' | 'artifacts';
  path: string;
  subtree: boolean;
}

/**
 * The declared read surface for a project's applied type pages — the
 * server-side scope list the first-party page-read route enforces per
 * request. The same declarations are also folded into the preview
 * capability at mint time (the v0 out-of-band fetch path); this resolver is
 * the in-bridge twin, re-derived fresh so it tolerates version drift and
 * never freezes at mint. `type`-source reads are excluded: the page tree
 * itself is served by the preview route, not readable as data.
 */
export async function resolvePageReads(
  catalog: CatalogService,
  project: Pick<Project, 'projectType'> | null | undefined,
): Promise<ResolvedPageReadScope[] | null> {
  const manifest = await resolveProjectTypeManifest(catalog, project);
  if (!manifest) return null;
  return (manifest.pages?.reads ?? [])
    .filter(
      (read): read is typeof read & { source: 'workspace' | 'artifacts' } =>
        read.source === 'workspace' || read.source === 'artifacts',
    )
    .map((read) => ({
      source: read.source,
      path: read.path,
      subtree: read.subtree === true,
    }));
}

/**
 * Names from a serialized `GEZEL_SCRIPT_TOOLS` payload. Used where the
 * resolved list isn't in scope (the codex-cli allowlist union) — parsing
 * the env we just wrote keeps the two session-build sites decoupled.
 */
export function scriptToolNamesFromEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((t) =>
        t && typeof (t as { name?: unknown }).name === 'string'
          ? (t as { name: string }).name
          : null,
      )
      .filter((n): n is string => n !== null);
  } catch {
    return [];
  }
}

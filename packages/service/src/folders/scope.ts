import { join } from 'node:path';
import { type ExternalFolders, gezelLocalDir, gezelPaths } from '@bendyline/gezel/paths';

/**
 * The three logical scopes a user can externalize from `~/.gezel/`.
 * - `documents`: the global shared library (one tree).
 * - `gezels`: every per-gezel folder (about.md, sessions, memories, icons).
 *   `toolsets/` and `toolsets.json` are filtered out — they stay local
 *   because syncing node_modules over cloud storage is hostile.
 * - `projects`: every per-project content folder (artifacts, tasks,
 *   memories, documents). The local-only set (`workspace/`, `gh/`,
 *   `scripts/`, `project.json`, `history.jsonl`, `questions.json`,
 *   `package.json`, `command-approvals.json`, `npm-allowlist.json`,
 *   `workspace-writes.jsonl`, `workdir/`) is filtered out.
 */
export type FolderScope = 'documents' | 'gezels' | 'projects';

export const FOLDER_SCOPES: FolderScope[] = ['documents', 'gezels', 'projects'];

/** Resolve the source root for a scope, honouring any *currently
 *  configured* external path (the move worker may be migrating from
 *  one external location to another). */
export function sourceRootForScope(
  home: string,
  scope: FolderScope,
  current: ExternalFolders | undefined,
): string {
  const p = gezelPaths(home, current);
  if (scope === 'documents') return p.documents;
  if (scope === 'gezels') return p.gezels;
  return p.projects;
}

/** Default (un-externalized) root for a scope — the path the source
 *  reverts to when the user picks "Reset to default". */
export function defaultRootForScope(home: string, scope: FolderScope): string {
  const p = gezelPaths(home);
  if (scope === 'documents') return p.documents;
  if (scope === 'gezels') return p.gezels;
  return p.projects;
}

/**
 * Per-scope filter for the move worker. Returns true when the given
 * absolute path INSIDE `sourceRoot` should be copied to the destination,
 * false when it should stay behind in the source location.
 *
 * The contract is "decide for ABSOLUTE paths inside `sourceRoot`" so
 * `node:fs` `cp({ filter })` can drop the predicate in directly
 * (`cp` invokes the filter with the source-side absolute path).
 */
export function makeScopeFilter(
  scope: FolderScope,
  sourceRoot: string,
  home: string,
): (src: string) => boolean {
  const root = sourceRoot;
  if (scope === 'documents') {
    return () => true;
  }
  if (scope === 'gezels') {
    // gezels/{id}/toolsets/ and gezels/{id}/toolsets.json stay local.
    return (src: string) => {
      const rel = relativeUnixPath(root, src);
      if (!rel) return true;
      const parts = rel.split('/');
      // root → keep
      // {id}/ → keep
      // {id}/toolsets/... → drop
      // {id}/toolsets.json → drop
      if (parts.length >= 2 && (parts[1] === 'toolsets' || parts[1] === 'toolsets.json')) {
        return false;
      }
      return true;
    };
  }
  // projects/{id}/<entry>/... — drop the local-only entries
  const localOnlyEntries = new Set([
    'workspace',
    'gh',
    'scripts',
    'workdir',
    'project.json',
    'history.jsonl',
    'questions.json',
    'package.json',
    'command-approvals.json',
    'npm-allowlist.json',
    'workspace-writes.jsonl',
  ]);
  return (src: string) => {
    const rel = relativeUnixPath(root, src);
    if (!rel) return true;
    const parts = rel.split('/');
    if (parts.length >= 2 && localOnlyEntries.has(parts[1] ?? '')) return false;
    return true;
  };
}

/** Absolute paths that should NEVER be cleaned up by the source-cleanup
 *  step at the end of a move. For `gezels`, this is the local toolsets
 *  dir of every gezel; for `projects`, it's each project's local-only
 *  set. The cleanup walker uses this to leave them alone when removing
 *  the moved-out tree from the source root. */
export function shouldKeepDuringCleanup(
  scope: FolderScope,
  sourceRoot: string,
  src: string,
): boolean {
  // Inverse of the scope filter: anything we did NOT copy stays put.
  return !makeScopeFilter(scope, sourceRoot, '')(src);
}

/** Returns the local-only paths (per gezel/project) that need to be
 *  preserved if the source root happens to be inside `~/.gezel/`. The
 *  caller (cleanup phase) iterates these and skips them when removing
 *  the source tree. */
export function localOnlyPathsUnder(scope: FolderScope, sourceRoot: string): string[] {
  // Returned for documentation/debug; the real cleanup uses the filter.
  return [sourceRoot];
}

/** Path inside `~/.gezel/` (always local) where this scope's pre-move
 *  backup lands. Format: `<home>/backup/<ISO-timestamp>/<scope>/`. */
export function backupRootForScope(home: string, scope: FolderScope, isoTimestamp: string): string {
  return join(home, 'backup', isoTimestamp, scope);
}

/** Convert an absolute child path to a forward-slash-relative path under
 *  base. Returns null when `child` is not under `base` (defensive — the
 *  cp filter should never call us otherwise).
 *
 *  Both inputs are normalized to forward slashes BEFORE comparison so
 *  we accept whatever separator the caller hands us. On Windows, `cp`'s
 *  filter callback passes backslash paths and most production callers
 *  build paths with `node:path` (also backslash). But internal callers
 *  and tests use forward slashes ("the platform's path the way the
 *  rest of gezel writes paths"). Normalizing up front means the
 *  filter works regardless — we don't bake the platform separator
 *  into the comparison. */
function relativeUnixPath(base: string, child: string): string | null {
  const baseUnix = base.replace(/\\/g, '/');
  const childUnix = child.replace(/\\/g, '/');
  if (childUnix === baseUnix) return '';
  if (!childUnix.startsWith(`${baseUnix}/`)) return null;
  return childUnix.slice(baseUnix.length + 1);
}

/** Reference to the always-local sibling for a single gezel id. The
 *  move worker uses this to KEEP the toolsets dir in place when
 *  cleaning up the source. Exported for symmetry with the scope
 *  filter. */
export function gezelLocalSiblingPath(home: string, gezelId: string): string {
  return gezelLocalDir(home, gezelId);
}

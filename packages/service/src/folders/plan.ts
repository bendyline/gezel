import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ExternalFolders } from '@bendyline/gezel/paths';
import { type FolderScope, makeScopeFilter, sourceRootForScope } from './scope.js';
import { type ValidationResult, validateExternalPath } from './validation.js';

export interface MovePlan {
  scope: FolderScope;
  sourcePath: string;
  destPath: string;
  /** Number of files (after applying scope filter) we'll copy. */
  files: number;
  /** Total bytes of those files. */
  bytes: number;
  /** How many of those files already exist at the destination. */
  conflicts: number;
  /** True when sourcePath exists on disk. */
  sourceExists: boolean;
  /** True when destPath exists on disk. */
  destExists: boolean;
  /** True when destPath has any entries (after the existence check). */
  destNonEmpty: boolean;
  validation: ValidationResult;
}

/**
 * Walk source + destination, return counts and conflict info. Cheap on
 * a typical install (< 10s of thousands of files); we don't bother
 * streaming partial counts.
 */
export async function planMove(opts: {
  home: string;
  scope: FolderScope;
  destPath: string;
  current: ExternalFolders | undefined;
}): Promise<MovePlan> {
  const { home, scope, destPath, current } = opts;
  const sourcePath = sourceRootForScope(home, scope, current);
  const validation = await validateExternalPath(scope, destPath, current);

  const sourceExists = await pathExists(sourcePath);
  const destExists = await pathExists(destPath);
  const destNonEmpty = destExists ? await dirNonEmpty(destPath) : false;

  if (!validation.ok || !sourceExists) {
    return {
      scope,
      sourcePath,
      destPath,
      files: 0,
      bytes: 0,
      conflicts: 0,
      sourceExists,
      destExists,
      destNonEmpty,
      validation,
    };
  }

  const filter = makeScopeFilter(scope, sourcePath, home);
  let files = 0;
  let bytes = 0;
  let conflicts = 0;
  await walk(sourcePath, async (abs) => {
    if (!filter(abs)) return false; // skip whole subtree
    const st = await stat(abs);
    if (st.isDirectory()) return true; // descend
    files += 1;
    bytes += st.size;
    if (destExists) {
      const rel = relative(sourcePath, abs);
      const destFile = join(destPath, rel);
      if (await pathExists(destFile)) conflicts += 1;
    }
    return true;
  });

  return {
    scope,
    sourcePath,
    destPath,
    files,
    bytes,
    conflicts,
    sourceExists,
    destExists,
    destNonEmpty,
    validation,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirNonEmpty(p: string): Promise<boolean> {
  try {
    const entries = await readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Recursive walker. Calls `visit(abs)` for every directory and file
 * (DFS, files first within a directory). When `visit` returns false
 * for a directory, its subtree is skipped — that's how the scope
 * filter prunes whole branches like `toolsets/`.
 *
 * Re-implemented inline (rather than reusing `Store.walkDir`) because
 * Store's walker returns ProjectFileEntry summaries; we want raw
 * absolute paths plus the early-prune contract.
 */
async function walk(root: string, visit: (abs: string) => Promise<boolean>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(root, name);
    let st: import('node:fs').Stats;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const descend = await visit(abs);
      if (descend) await walk(abs, visit);
    } else {
      await visit(abs);
    }
  }
}

export { sep };

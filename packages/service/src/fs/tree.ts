import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { ProjectFileEntry } from '@bendyline/gezel';
import { realpathContained, safeJoin } from './safe-paths.js';

export async function listDirEntries(
  base: string,
  subpath: string,
  opts: { includeHidden?: boolean } = {},
): Promise<ProjectFileEntry[]> {
  const safePath = await safeResolveRead(base, subpath);
  if (!safePath) return [];
  try {
    const entries = await readdir(safePath, { withFileTypes: true });
    return entries
      .filter((e) => opts.includeHidden || !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: subpath ? `${subpath}/${e.name}` : e.name,
        isDirectory: e.isDirectory(),
      }));
  } catch {
    return [];
  }
}

export interface WalkDirResult {
  entries: ProjectFileEntry[];
  /** True when `maxEntries` or `maxDepth` dropped part of the tree. */
  truncated: boolean;
}

export type IgnorePathResolver = (paths: readonly string[]) => Promise<ReadonlySet<string>>;

/**
 * Recursively list entries under `base`, breadth-first: a directory's
 * entries are all emitted before any subdirectory is entered, so shallow
 * files always survive the entry cap. This traversal was depth-first
 * once, and one large subtree early in readdir order (a 1000-file
 * `docs/` dir) could consume the whole budget before the walk returned
 * to its root-level siblings — the workspace's own `index.html` never
 * made it into the UI tree or the prompt listing. Bounded by `maxEntries`
 * and `maxDepth` so external workspaces cannot stall prompt construction.
 * Skips dotfiles, `node_modules`, and vendor/VCS metadata directories.
 *
 * Deliberately does not skip user-output dirs (`out`, `dist`, `build`):
 * gezels write deliverables wherever the task names them, and hiding those
 * dirs makes a model's own files invisible to listings, graders, and progress
 * tracking.
 */
export async function walkDirDetailed(
  base: string,
  opts: {
    maxEntries?: number;
    maxDepth?: number;
    withStats?: boolean;
    /**
     * Root-level directory names to skip entirely, checked before enqueue so a
     * large excluded subtree never consumes the entry budget. Scoped to depth
     * 0 on purpose: the artifacts walk must hide its reserved `shadow/` cache
     * without hiding a user folder that happens to share the name deeper in.
     * Ignored under `includeHidden`.
     */
    skipRootDirs?: ReadonlySet<string>;
    /**
     * Surface what the walk normally hides: dotfiles, the vendor/VCS
     * directories, and anything named by `skipRootDirs`. The vendor dirs are
     * listed but never entered — one `node_modules` would swallow the whole
     * entry budget and truncate the rest of the tree away, which is worse
     * than showing the folder without its contents.
     */
    includeHidden?: boolean;
  } = {},
): Promise<WalkDirResult> {
  const maxEntries = opts.maxEntries ?? 500;
  const maxDepth = opts.maxDepth ?? 6;
  const includeHidden = opts.includeHidden === true;
  const skipDirs = new Set(['node_modules', '.git', '.next', '.turbo', '.cache']);
  const results: ProjectFileEntry[] = [];
  let truncated = false;
  const queue: Array<{ dir: string; prefix: string; depth: number }> = [
    { dir: base, prefix: '', depth: 0 },
  ];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    let entries: Dirent[];
    try {
      entries = await readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!includeHidden) {
        if (e.name.startsWith('.')) continue;
        if (skipDirs.has(e.name)) continue;
        if (item.depth === 0 && e.isDirectory() && opts.skipRootDirs?.has(e.name)) continue;
      }
      if (results.length >= maxEntries) {
        return { entries: results, truncated: true };
      }
      const rel = item.prefix ? `${item.prefix}/${e.name}` : e.name;
      const entry: ProjectFileEntry = { name: e.name, path: rel, isDirectory: e.isDirectory() };
      // Opt-in per-file stat — the "what got written last night" reads
      // need mtimes; bounded by maxEntries so the extra lstat cost stays
      // capped.
      if (opts.withStats && !entry.isDirectory) {
        try {
          const stat = await lstat(join(item.dir, e.name));
          entry.mtimeMs = stat.mtimeMs;
        } catch {
          /* stat is best-effort */
        }
      }
      results.push(entry);
      if (e.isDirectory()) {
        if (includeHidden && skipDirs.has(e.name)) continue;
        if (item.depth + 1 > maxDepth) truncated = true;
        else queue.push({ dir: join(item.dir, e.name), prefix: rel, depth: item.depth + 1 });
      }
    }
  }
  return { entries: results, truncated };
}

/** {@link walkDirDetailed} for callers that only need the entries. */
export async function walkDir(
  base: string,
  opts: Parameters<typeof walkDirDetailed>[1] = {},
): Promise<ProjectFileEntry[]> {
  return (await walkDirDetailed(base, opts)).entries;
}

/**
 * Find previewable HTML pages without surveying the whole workspace.
 *
 * `maxDepth` counts containing folders from the workspace root: a page at
 * `one/two/three/four/index.html` is included at depth 4, while a page below
 * one more folder is not visited. Dot-prefixed entries and `node_modules`
 * are pruned before recursion so large dependency and metadata trees never
 * become part of output-page discovery. Breadth-first for the same reason
 * as {@link walkDirDetailed}: a root `index.html` must win the entry cap
 * over hundreds of pages inside a deep content directory. When an ignore
 * resolver is supplied, each level is filtered before its child directories
 * are queued, so an ignored subtree is never opened.
 */
export async function findHtmlPages(
  base: string,
  opts: {
    maxEntries?: number;
    maxDepth?: number;
    resolveIgnoredPaths?: IgnorePathResolver;
  } = {},
): Promise<ProjectFileEntry[]> {
  const maxEntries = opts.maxEntries ?? 500;
  const maxDepth = opts.maxDepth ?? 4;
  const results: ProjectFileEntry[] = [];
  let queue: Array<{ dir: string; prefix: string; depth: number }> = [
    { dir: base, prefix: '', depth: 0 },
  ];
  while (queue.length > 0) {
    const level = queue;
    queue = [];
    const listings: Array<{
      item: { dir: string; prefix: string; depth: number };
      entries: Dirent[];
    }> = [];

    for (const item of level) {
      try {
        const entries = await readdir(item.dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        listings.push({ item, entries });
      } catch {
        // A disappearing or unreadable directory contributes no pages.
      }
    }

    const candidates = listings.flatMap(({ item, entries }) =>
      entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => (item.prefix ? `${item.prefix}/${entry.name}` : entry.name)),
    );
    const ignored = opts.resolveIgnoredPaths
      ? await opts.resolveIgnoredPaths(candidates)
      : new Set<string>();

    for (const { item, entries } of listings) {
      for (const entry of entries) {
        if (results.length >= maxEntries) return results;
        if (entry.name.startsWith('.')) continue;
        const rel = item.prefix ? `${item.prefix}/${entry.name}` : entry.name;
        if (ignored.has(rel)) continue;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || item.depth >= maxDepth) continue;
          queue.push({ dir: join(item.dir, entry.name), prefix: rel, depth: item.depth + 1 });
        } else if (/\.html?$/i.test(entry.name)) {
          results.push({ name: entry.name, path: rel, isDirectory: false });
        }
      }
    }
  }
  return results;
}

/**
 * Resolve a read path under `base` with both logical containment and
 * symlink-realpath containment. Returns null on any escape so callers fail
 * closed.
 */
export async function safeResolveRead(base: string, relPath: string): Promise<string | null> {
  const full = relPath ? safeJoin(base, relPath) : normalize(base);
  if (!full) return null;
  if (!(await realpathContained(base, full))) return null;
  return full;
}

export async function safeReadTextFile(base: string, filePath: string): Promise<string | null> {
  const full = await safeResolveRead(base, filePath);
  if (!full) return null;
  try {
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Byte-exact sibling of {@link safeReadTextFile}, behind the same
 * containment fence. For consumers that must not UTF-8 round-trip —
 * image-signature checks read magic bytes, which text decoding mangles.
 */
export async function safeReadBinaryFile(
  base: string,
  filePath: string,
): Promise<Uint8Array | null> {
  const full = await safeResolveRead(base, filePath);
  if (!full) return null;
  try {
    return new Uint8Array(await readFile(full));
  } catch {
    return null;
  }
}

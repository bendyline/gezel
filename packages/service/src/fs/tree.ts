import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { ProjectFileEntry } from '@bendyline/gezel';
import { realpathContained, safeJoin } from './safe-paths.js';

export async function listDirEntries(base: string, subpath: string): Promise<ProjectFileEntry[]> {
  const safePath = await safeResolveRead(base, subpath);
  if (!safePath) return [];
  try {
    const entries = await readdir(safePath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: subpath ? `${subpath}/${e.name}` : e.name,
        isDirectory: e.isDirectory(),
      }));
  } catch {
    return [];
  }
}

/**
 * Recursively list entries under `base`. Bounded by `maxEntries` and
 * `maxDepth` so external workspaces cannot stall prompt construction.
 * Skips dotfiles, `node_modules`, and vendor/VCS metadata directories.
 *
 * Deliberately does not skip user-output dirs (`out`, `dist`, `build`):
 * gezels write deliverables wherever the task names them, and hiding those
 * dirs makes a model's own files invisible to listings, graders, and progress
 * tracking.
 */
export async function walkDir(
  base: string,
  opts: { maxEntries?: number; maxDepth?: number; withStats?: boolean } = {},
): Promise<ProjectFileEntry[]> {
  const maxEntries = opts.maxEntries ?? 500;
  const maxDepth = opts.maxDepth ?? 6;
  const skipDirs = new Set(['node_modules', '.git', '.next', '.turbo', '.cache']);
  const results: ProjectFileEntry[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string, depth: number) => {
    if (truncated) return;
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.name.startsWith('.')) continue;
      if (skipDirs.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const entry: ProjectFileEntry = { name: e.name, path: rel, isDirectory: e.isDirectory() };
      // Opt-in per-file stat — the "what got written last night" reads
      // need mtimes; bounded by maxEntries so the extra lstat cost stays
      // capped.
      if (opts.withStats && !entry.isDirectory) {
        try {
          const stat = await lstat(join(dir, e.name));
          entry.mtimeMs = stat.mtimeMs;
        } catch {
          /* stat is best-effort */
        }
      }
      results.push(entry);
      if (results.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (e.isDirectory()) await walk(join(dir, e.name), rel, depth + 1);
    }
  };
  await walk(base, '', 0);
  return results;
}

/**
 * Find previewable HTML pages without surveying the whole workspace.
 *
 * `maxDepth` counts containing folders from the workspace root: a page at
 * `one/two/three/four/index.html` is included at depth 4, while a page below
 * one more folder is not visited. Dot-prefixed entries and `node_modules`
 * are pruned before recursion so large dependency and metadata trees never
 * become part of output-page discovery.
 */
export async function findHtmlPages(
  base: string,
  opts: { maxEntries?: number; maxDepth?: number } = {},
): Promise<ProjectFileEntry[]> {
  const maxEntries = opts.maxEntries ?? 500;
  const maxDepth = opts.maxDepth ?? 4;
  const results: ProjectFileEntry[] = [];

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (results.length >= maxEntries) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxEntries) return;
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || depth >= maxDepth) continue;
        await walk(join(dir, entry.name), rel, depth + 1);
      } else if (/\.html?$/i.test(entry.name)) {
        results.push({ name: entry.name, path: rel, isDirectory: false });
      }
    }
  };

  await walk(base, '', 0);
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

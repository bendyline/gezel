import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { runGit } from '../git/git.js';

/** Directories that are never useful to either workspace index. */
const ALWAYS_SKIP_DIRS = new Set([
  '.git',
  '.gezel',
  'node_modules',
  '.next',
  '.cache',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
]);

export interface DiscoveredWorkspaceFile {
  /** Forward-slashed relative path from the requested workspace root. */
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export interface DiscoverWorkspaceFilesOptions {
  maxFiles: number;
  /**
   * Budget for the `git ls-files` discovery step. Callers on an interactive
   * path (project-type scan at create time) lower this so a slow repository
   * degrades to the filesystem walk instead of blocking the request.
   */
  gitTimeoutMs?: number;
}

/**
 * Enumerate files visible to the workspace indexes.
 *
 * Git workspaces use Git's own tracked + non-ignored-untracked view, which
 * gives us the complete `.gitignore` contract (nested files, negations,
 * `.git/info/exclude`, and global excludes) without maintaining a partial
 * parser. This is also materially faster than walking a multi-gigabyte ignored
 * build/output tree just to decide afterward that none of it was wanted.
 *
 * Plain folders and machines without Git retain the bounded filesystem walk.
 */
export async function discoverWorkspaceFiles(
  workspaceDir: string,
  opts: DiscoverWorkspaceFilesOptions,
): Promise<DiscoveredWorkspaceFile[]> {
  const gitPaths = await listGitVisiblePaths(workspaceDir, opts.maxFiles, opts.gitTimeoutMs);
  if (gitPaths) return statListedFiles(workspaceDir, gitPaths, opts.maxFiles);

  const out: DiscoveredWorkspaceFile[] = [];
  await walkFilesystem(workspaceDir, workspaceDir, out, opts.maxFiles);
  return out;
}

/**
 * Return null when the folder is not a Git worktree (or Git is unavailable),
 * versus [] for a valid empty repository.
 */
async function listGitVisiblePaths(
  workspaceDir: string,
  maxFiles: number,
  timeoutMs = 30_000,
): Promise<string[] | null> {
  try {
    const { stdout } = await runGit(
      [
        '-c',
        'core.quotepath=false',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ],
      { cwd: workspaceDir, timeoutMs },
    );
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const raw of stdout.split('\0')) {
      if (!raw) continue;
      const path = raw.replaceAll('\\', '/').replace(/^\.\//, '');
      if (!path || seen.has(path) || containsAlwaysSkippedDir(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length >= maxFiles) break;
    }
    return paths;
  } catch {
    return null;
  }
}

async function statListedFiles(
  workspaceDir: string,
  paths: readonly string[],
  maxFiles: number,
): Promise<DiscoveredWorkspaceFile[]> {
  const out: DiscoveredWorkspaceFile[] = [];
  // Keep disk parallelism bounded: a 50k-file repository should not enqueue
  // 50k simultaneous stat calls into libuv.
  const batchSize = 64;
  for (let start = 0; start < paths.length && out.length < maxFiles; start += batchSize) {
    const batch = paths.slice(start, start + batchSize);
    const rows = await Promise.all(
      batch.map(async (path): Promise<DiscoveredWorkspaceFile | null> => {
        const abs = join(workspaceDir, ...path.split('/'));
        try {
          const st = await lstat(abs);
          // Match the fallback walk: do not follow symlinks outside the
          // workspace merely because Git tracks the link itself.
          if (!st.isFile()) return null;
          return { path, abs, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          // A file can disappear between `git ls-files` and lstat.
          return null;
        }
      }),
    );
    for (const row of rows) {
      if (row) out.push(row);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

async function walkFilesystem(
  root: string,
  dir: string,
  out: DiscoveredWorkspaceFile[],
  maxFiles: number,
): Promise<void> {
  if (out.length >= maxFiles) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.isDirectory() && ALWAYS_SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFilesystem(root, abs, out, maxFiles);
    } else if (entry.isFile()) {
      try {
        const st = await lstat(abs);
        out.push({
          path: relative(root, abs).replaceAll('\\', '/'),
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* unreadable or removed mid-walk — skip */
      }
    }
  }
}

function containsAlwaysSkippedDir(path: string): boolean {
  const parts = path.split('/');
  // The last part is a filename; only directory segments apply here.
  return parts.slice(0, -1).some((part) => ALWAYS_SKIP_DIRS.has(part));
}

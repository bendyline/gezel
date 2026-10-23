import { createLogger } from '@bendyline/gezel';
import { isGitInstalled, runGit } from '../git/git.js';
import type { GitCommitRecord } from './git-history-table.js';
import type { IndexStore } from './index-store.js';

/**
 * Per-file git signal for the code map: commit count inside the churn window
 * and the last commit touching each path. One capped `git log --name-only`
 * pass over the whole workspace — never per-file invocations — parsed here
 * and written into the index's per-file metadata table under the reserved
 * `git:` key prefix (which `setMetadata` is contractually unable to clobber).
 * The same pass stores the commits themselves (time, subject, indexed files;
 * never the author) for the Timeline view.
 *
 * Runs on indexer ticks, not on the map-build request path. Every failure
 * mode (git missing, not a repo, empty repo, timeout) degrades to
 * `state: 'unavailable'` with neutral defaults — it never throws.
 */

const log = createLogger('index:git-stats');

export const GIT_META_COMMITS = 'git:commits365';
export const GIT_META_LAST_COMMIT = 'git:lastCommitAt';

const META_HEAD = 'git_stats:head';
const META_COMPUTED_AT = 'git_stats:computed_at';
const META_STATE = 'git_stats:state';
const META_WINDOW_DAYS = 'git_stats:window_days';
/** Which shape of stored history the last ingest wrote; an older one re-ingests at once. */
const META_HISTORY = 'git_stats:history';
const HISTORY_VERSION = '1';

export const GIT_CHURN_WINDOW_DAYS = 365;
/** History cap: bounds stdout (~4 MB at 5 files/commit) on huge monorepos. */
const MAX_COMMITS = 20_000;
const LOG_TIMEOUT_MS = 30_000;
/** Re-ingest at least daily even on an unchanged HEAD — the churn window's
 *  365-day boundary moves with wall-clock time. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface GitFileStats {
  commitsInWindow: number;
  lastCommitAtMs: number;
}

/**
 * Parse `git log --pretty=format:%x01%H%x02%ct%x02%s --name-only` output
 * into commits, newest first. Robust to blank lines landing anywhere:
 * SOH-prefixed lines are commit headers, empty lines are separators,
 * everything else is a path. A header of the bare `%x01%ct` form (no hash or
 * subject) still parses, with an empty sha. A commit whose time does not
 * parse is skipped with its files.
 */
export function parseGitLog(stdout: string): GitCommitRecord[] {
  const out: GitCommitRecord[] = [];
  let current: GitCommitRecord | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === 1) {
      const parts = line.slice(1).split('\x02');
      const [sha, ct, ...subject] = parts.length >= 2 ? parts : ['', parts[0]];
      const at = Number(ct) * 1000;
      current = Number.isNaN(at)
        ? null
        : { sha: sha ?? '', at, subject: subject.join(' '), files: [] };
      if (current) out.push(current);
      continue;
    }
    // A quoted path means control characters in the filename despite
    // quotepath=off — skip rather than unquote; cost is one file with
    // neutral defaults.
    if (!current || line.startsWith('"')) continue;
    current.files.push(line);
  }
  return out;
}

/**
 * Per-file churn from parsed commits: commits inside the window, and the
 * newest commit touching each path (log order is reverse-chronological, so
 * the first sighting wins). Window filtering happens here, not in git, so
 * one pass yields both signals.
 */
export function fileStatsFromCommits(
  commits: readonly GitCommitRecord[],
  windowStartMs: number,
): Map<string, GitFileStats> {
  const out = new Map<string, GitFileStats>();
  for (const commit of commits) {
    const inWindow = commit.at >= windowStartMs ? 1 : 0;
    for (const path of commit.files) {
      const prev = out.get(path);
      if (prev) prev.commitsInWindow += inWindow;
      else out.set(path, { commitsInWindow: inWindow, lastCommitAtMs: commit.at });
    }
  }
  return out;
}

/** {@link parseGitLog} then {@link fileStatsFromCommits}. */
export function parseGitLogNameOnly(
  stdout: string,
  windowStartMs: number,
): Map<string, GitFileStats> {
  return fileStatsFromCommits(parseGitLog(stdout), windowStartMs);
}

let gitProbe: Promise<boolean> | null = null;
function gitAvailable(): Promise<boolean> {
  if (!gitProbe) gitProbe = isGitInstalled();
  return gitProbe;
}

/** Test seam: reset the module-level git probe memo. */
export function resetGitProbeForTests(): void {
  gitProbe = null;
}

export interface GitStatsResult {
  state: 'ok' | 'unavailable' | 'fresh';
  files?: number;
}

export interface RefreshGitStatsOptions {
  now?: () => number;
  ttlMs?: number;
}

export async function refreshGitStats(
  index: IndexStore,
  workspaceDir: string,
  opts: RefreshGitStatsOptions = {},
): Promise<GitStatsResult> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const markUnavailable = (): GitStatsResult => {
    index.setMeta(META_STATE, 'unavailable');
    return { state: 'unavailable' };
  };

  try {
    if (!(await gitAvailable())) return markUnavailable();

    let head: string;
    try {
      const inTree = await runGit(['rev-parse', '--is-inside-work-tree'], {
        cwd: workspaceDir,
        timeoutMs: 5_000,
      });
      if (inTree.stdout.trim() !== 'true') return markUnavailable();
      // An empty repo has no HEAD and therefore no history to ingest.
      head = (
        await runGit(['rev-parse', 'HEAD'], { cwd: workspaceDir, timeoutMs: 5_000 })
      ).stdout.trim();
    } catch {
      return markUnavailable();
    }

    const computedAt = index.getMeta(META_COMPUTED_AT);
    const fresh =
      index.getMeta(META_HEAD) === head &&
      index.getMeta(META_WINDOW_DAYS) === String(GIT_CHURN_WINDOW_DAYS) &&
      index.getMeta(META_STATE) === 'ok' &&
      index.getMeta(META_HISTORY) === HISTORY_VERSION &&
      computedAt !== undefined &&
      now() - Date.parse(computedAt) < ttlMs;
    if (fresh) return { state: 'fresh' };

    const logOut = await runGit(
      [
        '-c',
        'core.quotepath=off',
        'log',
        '--no-renames',
        `--max-count=${MAX_COMMITS}`,
        '--pretty=format:%x01%H%x02%ct%x02%s',
        '--name-only',
        '--relative',
        '--',
        '.',
      ],
      { cwd: workspaceDir, timeoutMs: LOG_TIMEOUT_MS },
    );

    const windowStartMs = now() - GIT_CHURN_WINDOW_DAYS * 86_400_000;
    const commits = parseGitLog(logOut.stdout);
    const stats = fileStatsFromCommits(commits, windowStartMs);

    // Only store rows for files the index tracks — keeps the table tight and
    // self-prunes on the next ingest after deletions.
    const indexed = new Set(index.allFiles().map((f) => f.path));
    index.gitHistory.replace(
      commits.map((c) => ({ ...c, files: c.files.filter((p) => indexed.has(p)) })),
    );
    const rows: Array<{ path: string; key: string; value: string }> = [];
    let fileCount = 0;
    for (const [path, s] of stats) {
      if (!indexed.has(path)) continue;
      fileCount += 1;
      rows.push({ path, key: GIT_META_COMMITS, value: String(s.commitsInWindow) });
      rows.push({
        path,
        key: GIT_META_LAST_COMMIT,
        value: new Date(s.lastCommitAtMs).toISOString(),
      });
    }
    index.replaceMetadataForKeyPrefix('git:', rows);
    index.setMeta(META_HEAD, head);
    index.setMeta(META_COMPUTED_AT, new Date(now()).toISOString());
    index.setMeta(META_STATE, 'ok');
    index.setMeta(META_WINDOW_DAYS, String(GIT_CHURN_WINDOW_DAYS));
    index.setMeta(META_HISTORY, HISTORY_VERSION);
    return { state: 'ok', files: fileCount };
  } catch (err) {
    log.warn(`git stats ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    return markUnavailable();
  }
}

/** True when the last ingest for this index succeeded. */
export function gitStatsAvailable(index: IndexStore): boolean {
  return index.getMeta(META_STATE) === 'ok';
}

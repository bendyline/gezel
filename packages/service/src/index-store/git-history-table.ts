import type { SqliteDriver } from './sqlite-driver.js';

export interface GitCommitRecord {
  sha: string;
  /** Commit time, ms since the epoch. */
  at: number;
  subject: string;
  /** Indexed files the commit touched. */
  files: string[];
}

/**
 * The workspace's stored git history (`git_commits`, `git_commit_files`),
 * reached through `IndexStore.gitHistory`. The git-stats ingest replaces it
 * wholesale; the Timeline view reads it.
 */
export class GitHistoryTable {
  constructor(
    private readonly db: SqliteDriver,
    private readonly collectionId: string,
  ) {}

  replace(commits: readonly GitCommitRecord[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM git_commits WHERE collection_id = ?').run(this.collectionId);
      this.db
        .prepare('DELETE FROM git_commit_files WHERE collection_id = ?')
        .run(this.collectionId);
      const commit = this.db.prepare(
        'INSERT OR IGNORE INTO git_commits (collection_id, sha, committed_at, subject) VALUES (?, ?, ?, ?)',
      );
      const file = this.db.prepare(
        'INSERT OR IGNORE INTO git_commit_files (collection_id, sha, path) VALUES (?, ?, ?)',
      );
      for (const c of commits) {
        commit.run(this.collectionId, c.sha, c.at, c.subject);
        for (const path of c.files) file.run(this.collectionId, c.sha, path);
      }
    });
  }

  count(): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM git_commits WHERE collection_id = ?')
        .get<{ n: number }>(this.collectionId)?.n ?? 0
    );
  }

  /** Commits with `from <= at < to` (all when unbounded), oldest first, with their files. */
  commits(range: { from?: number; to?: number } = {}): GitCommitRecord[] {
    const from = range.from ?? Number.MIN_SAFE_INTEGER;
    const to = range.to ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        `SELECT c.sha, c.committed_at, c.subject, f.path FROM git_commits c
           LEFT JOIN git_commit_files f ON f.collection_id = c.collection_id AND f.sha = c.sha
          WHERE c.collection_id = ? AND c.committed_at >= ? AND c.committed_at < ?
          ORDER BY c.committed_at, c.sha, f.path`,
      )
      .all<{ sha: string; committed_at: number; subject: string; path: string | null }>(
        this.collectionId,
        from,
        to,
      );
    const out: GitCommitRecord[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.sha === r.sha) {
        if (r.path) last.files.push(r.path);
      } else {
        out.push({
          sha: r.sha,
          at: r.committed_at,
          subject: r.subject,
          files: r.path ? [r.path] : [],
        });
      }
    }
    return out;
  }
}

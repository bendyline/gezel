import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

/**
 * Evaluation only. `GEZEL_EVAL_INDEX_ALLOWLIST` names a file of absolute
 * paths, one per line; when it is set, the indexer skips every workspace file
 * not on it. The issue-triage evaluation indexes and reviews a fixed sample of
 * a repository while the coding app under test still sees the whole tree on
 * disk, which a `.gitignore` or `.git/info/exclude` cannot do: the app's own
 * search honors those too. Unset, nothing changes.
 */
let cached: { file: string; paths: Set<string> } | null = null;

const key = (path: string) => normalize(path).toLowerCase();

export function evalIndexAllowlist(workspaceDir: string): {
  ignorePath?: (relPath: string) => boolean;
} {
  const file = process.env.GEZEL_EVAL_INDEX_ALLOWLIST;
  if (!file) return {};
  if (cached?.file !== file) {
    const text = readFileSync(file, 'utf8');
    cached = { file, paths: new Set(text.split(/\r?\n/).filter(Boolean).map(key)) };
  }
  const paths = cached.paths;
  return { ignorePath: (relPath) => !paths.has(key(join(workspaceDir, relPath))) };
}

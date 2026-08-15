import { isAbsolute, join } from 'node:path';
import { repoRoot } from './native-bin.ts';

function defaultRunsDir(): string {
  return join(repoRoot(), 'evals', 'runs');
}

/**
 * Resolve user-supplied eval output roots against the repository, never the
 * package process cwd. pnpm runs filtered scripts from `evals/`, so leaving a
 * relative `evals/runs/...` untouched creates `evals/evals/runs/...`.
 */
export function resolveEvalRunsDir(
  runsDir: string | undefined,
  fallback: () => string = defaultRunsDir,
): string {
  if (!runsDir) return fallback();
  return isAbsolute(runsDir) ? runsDir : join(repoRoot(), runsDir);
}

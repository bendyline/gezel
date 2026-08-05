import { runGit } from './git.js';

export type GitIgnoreResolver = (paths: readonly string[]) => Promise<ReadonlySet<string>>;

/**
 * Build a workspace-scoped Git ignore resolver.
 *
 * Git is the source of truth rather than a partial `.gitignore` parser: this
 * honors nested ignore files, negations, `.git/info/exclude`, and the user's
 * normal global excludes. `--no-index` deliberately applies matching rules
 * even to an accidentally tracked generated file — exclusion is about the
 * declared path policy, not Git's tracked/untracked distinction.
 *
 * A non-Git workspace (or a machine without Git) resolves every path as
 * visible. After the first Git failure the resolver stays disabled so a
 * bounded directory walk does not repeatedly launch a command that cannot
 * succeed.
 */
export function createGitIgnoreResolver(workspaceDir: string): GitIgnoreResolver {
  let available = true;

  return async (paths) => {
    if (!available || paths.length === 0) return new Set();

    try {
      const { stdout } = await runGit(['check-ignore', '--no-index', '-z', '--stdin'], {
        cwd: workspaceDir,
        stdin: `${paths.join('\0')}\0`,
        timeoutMs: 10_000,
        // Exit 1 means no supplied path matched an ignore rule.
        acceptExitCodes: [1],
      });
      return new Set(
        stdout
          .split('\0')
          .filter(Boolean)
          .map((path) => path.replaceAll('\\', '/')),
      );
    } catch {
      available = false;
      return new Set();
    }
  };
}

/** Resolve one batch of paths against the workspace's Git ignore rules. */
export async function gitIgnoredPaths(
  workspaceDir: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  return createGitIgnoreResolver(workspaceDir)(paths);
}

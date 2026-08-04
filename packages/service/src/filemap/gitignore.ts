import { runGit } from '../git/git.js';

/**
 * Resolve paths hidden from the Village by the workspace's Git ignore rules.
 *
 * Git is the source of truth here rather than a partial `.gitignore` parser:
 * this honors nested ignore files, negations, `.git/info/exclude`, and the
 * user's normal global excludes. `--no-index` deliberately applies matching
 * rules even to an accidentally tracked generated file — Village exclusion is
 * about the declared path policy, not Git's tracked/untracked distinction.
 *
 * A non-Git workspace (or a machine without Git) simply keeps the Village's
 * built-in exclusions. Village must remain available for ordinary folders.
 */
export async function gitIgnoredVillagePaths(
  workspaceDir: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();

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
    return new Set();
  }
}

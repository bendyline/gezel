import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Files loaded directly by evals. App source is compiled; its build is checked separately. */
export function isEvalInputPath(path: string): boolean {
  const name = path.replaceAll('\\', '/');
  if (
    /(^|\/)(__tests__|__pycache__|tmp|temp)(\/|$)/.test(name) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    /(?:\.(tmp|bak|swp|pyc)|~)$/.test(name)
  )
    return false;
  return (
    name.startsWith('evals/src/') ||
    name.startsWith('evals/user-scripts/') ||
    name.startsWith('packages/script-stdlib/scripts/') ||
    name === 'evals/tsconfig.json' ||
    name === 'tsconfig.base.json' ||
    name === 'scripts/run-with-dependency-lease.mjs' ||
    name === 'scripts/dependency-lease.mjs' ||
    name === 'scripts/pnpm-cli.mjs'
  );
}

/** Git selects source paths; file bytes, not index/commit bookkeeping, identify them. */
export async function sourceIdentity(root: string, scope: 'repository' | 'eval' = 'repository') {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString();
  const head = git('rev-parse', 'HEAD').trim();
  const paths = [
    ...new Set(
      git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        .split('\0')
        .filter((path) => path && (scope === 'repository' || isEvalInputPath(path))),
    ),
  ].sort();
  const manifest: Record<string, string> = {};
  const checkedParents = new Set(['.']);
  async function checkParent(path: string): Promise<void> {
    if (checkedParents.has(path)) return;
    await checkParent(dirname(path));
    if (!(await lstat(join(root, path))).isDirectory())
      throw new Error(`Source parent is not a directory: ${path}`);
    checkedParents.add(path);
  }
  for (const path of paths) {
    try {
      await checkParent(dirname(path));
      const stat = await lstat(join(root, path));
      const entry = createHash('sha256');
      if (stat.isSymbolicLink()) entry.update('symlink\0').update(await readlink(join(root, path)));
      else if (stat.isFile())
        entry
          .update(stat.mode & 0o111 ? 'executable\0' : 'file\0')
          .update(await readFile(join(root, path)));
      else throw new Error(`Unsupported source entry: ${path}`);
      manifest[path] = entry.digest('hex');
    } catch (error) {
      // An unstaged deletion and a committed deletion describe the same tree.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return {
    algorithm: scope === 'eval' ? 'eval-inputs-v1' : 'worktree-content-v1',
    head,
    sha256,
    files: Object.keys(manifest).length,
    manifest,
  };
}

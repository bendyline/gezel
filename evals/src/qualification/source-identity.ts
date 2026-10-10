import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Git selects source paths; file bytes, not index/commit bookkeeping, identify them. */
export async function sourceIdentity(root: string) {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString();
  const head = git('rev-parse', 'HEAD').trim();
  const paths = [
    ...new Set(
      git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
        .split('\0')
        .filter(Boolean),
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
    algorithm: 'worktree-content-v1',
    head,
    sha256,
    files: Object.keys(manifest).length,
    manifest,
  };
}

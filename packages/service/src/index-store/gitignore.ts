import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectLocalIndexDir } from '@bendyline/gezel/paths';

/**
 * The content index lives under the workspace `.gezel/` (so it travels with
 * the repo folder), but it's a regenerable cache — a binary sqlite DB — that
 * must never be committed. We drop a `.gitignore` containing `*` into the dir
 * so the whole subtree is ignored regardless of the repo's own ignore rules.
 * Idempotent and best-effort: a read-only workspace just skips this (the
 * caller falls back to the home-local index dir). Converted-document shadows
 * moved out of the workspace entirely (`artifacts/shadow/`), so only the
 * index dir needs the guard now.
 */
export async function ensureIndexGitignore(workspaceDir: string): Promise<void> {
  const dir = projectLocalIndexDir(workspaceDir);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'w' });
  } catch {
    // read-only workspace / permissions — non-fatal; index falls back to ~/.gezel
  }
}

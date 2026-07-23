import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectLocalFilesDir, projectLocalIndexDir } from '@bendyline/gezel/paths';

/**
 * The content index + converted-document artifacts live under the workspace
 * `.gezel/` (so they travel with the repo folder), but they're a regenerable
 * cache — a binary sqlite DB and derived markdown — that must never be
 * committed. We drop a `.gitignore` containing `*` into each dir so the whole
 * subtree is ignored regardless of the repo's own ignore rules. Idempotent and
 * best-effort: a read-only workspace just skips this (the caller falls back to
 * the home-local index dir).
 */
export async function ensureIndexGitignore(workspaceDir: string): Promise<void> {
  const dirs = [projectLocalIndexDir(workspaceDir), projectLocalFilesDir(workspaceDir)];
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'w' });
    } catch {
      // read-only workspace / permissions — non-fatal; index falls back to ~/.gezel
    }
  }
}

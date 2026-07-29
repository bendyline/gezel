import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from './git.js';

/**
 * Result of probing a directory for git provenance. `originUrl` is
 * present only when the dir is a git repo AND has an `origin` remote
 * configured.
 */
export interface InspectedGit {
  isRepo: boolean;
  originUrl?: string;
}

/**
 * Cheap "is this folder a git repo, and where does its origin point?"
 * probe. Used both by the GitManager (to adopt a workingDir whose
 * origin matches the project's configured URL) and by the project-
 * update path (to auto-link a github URL when the user sets a
 * workingDir at an existing clone).
 *
 * Lives in its own module so callers in `fs/store.ts` can use it
 * without dragging in the rest of `github/manager.ts` and creating
 * a circular import.
 */
export async function inspectGitWorkdir(dir: string): Promise<InspectedGit> {
  try {
    const s = await stat(join(dir, '.git'));
    if (!s.isDirectory() && !s.isFile()) return { isRepo: false };
  } catch {
    return { isRepo: false };
  }
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], { cwd: dir });
    return { isRepo: true, originUrl: stdout.trim() };
  } catch {
    return { isRepo: true };
  }
}

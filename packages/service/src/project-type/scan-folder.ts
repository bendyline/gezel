import { classifyFile } from '../index-store/classify.js';
import { discoverWorkspaceFiles } from '../workspace/file-walk.js';
import type { LanguageProfile } from './detect.js';

/**
 * Bounded static folder scan producing the same {@link LanguageProfile} shape
 * the content index exposes — extension and modality histograms over a
 * project's files.
 *
 * Exists because {@link detectProjectType} was gated on the content index
 * having already run: a folder opened for the first time (the CLI's `npx gezel`
 * path) had no profile until the index tick fired, so `detectedProjectType`
 * stayed unset for the whole first session and every consumer — the craftbook
 * rail, the gezel-role affinity lists — behaved as if the folder had no shape.
 * This runs off nothing but a directory walk, so a type is available the moment
 * the project exists.
 *
 * Reuses `discoverWorkspaceFiles` (git-visible paths when the folder is a
 * worktree, bounded filesystem walk otherwise) rather than walking here, so the
 * `.gitignore` contract and skip-list stay identical to what the real index
 * sees. Reuses `classifyFile` for the same reason: the modality vocabulary has
 * to match the indexed profile or the taxonomy's `detect.modalities` would
 * score differently depending on which producer ran.
 */

/**
 * File cap for the scan. Detection reads *proportions*, not totals, so a few
 * thousand files characterize a tree as well as a hundred thousand — and this
 * runs on the project-create path, where an unbounded walk of a monorepo would
 * be felt.
 */
export const FOLDER_SCAN_MAX_FILES = 4_000;

/**
 * Git timeout for the scan's discovery step. Deliberately far below
 * `discoverWorkspaceFiles`' 30s default: a create-time scan that stalls is
 * worse than one that falls back to the plain filesystem walk.
 */
const SCAN_GIT_TIMEOUT_MS = 4_000;

/**
 * Build the histograms from an already-discovered file list. Pure — the
 * scoring half of detection is unit-tested against this without touching disk.
 *
 * Extensions are derived the same way `IndexStore.extensionCounts` derives
 * them (lowercase, no dot, dotfiles excluded) so a profile from this scan and
 * one from the index are interchangeable inputs to `scoreProjectTypes`.
 */
export function profileFromFiles(
  files: ReadonlyArray<{ path: string; size: number }>,
): LanguageProfile {
  const extensions: Record<string, number> = {};
  const modalities: Record<string, number> = {};
  for (const file of files) {
    const dot = file.path.lastIndexOf('.');
    const slash = Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\'));
    if (dot > slash + 1) {
      const ext = file.path.slice(dot + 1).toLowerCase();
      if (ext) extensions[ext] = (extensions[ext] ?? 0) + 1;
    }
    const modality = classifyFile(file.path, file.size).modality;
    modalities[modality] = (modalities[modality] ?? 0) + 1;
  }
  return { fileCount: files.length, extensions, modalities };
}

/**
 * Walk `dir` and return its profile, or null when the folder is unreadable or
 * empty. Never throws — every caller treats detection as best-effort.
 */
export async function scanFolderProfile(
  dir: string,
  opts?: { maxFiles?: number },
): Promise<LanguageProfile | null> {
  try {
    const { files } = await discoverWorkspaceFiles(dir, {
      maxFiles: opts?.maxFiles ?? FOLDER_SCAN_MAX_FILES,
      gitTimeoutMs: SCAN_GIT_TIMEOUT_MS,
    });
    if (files.length === 0) return null;
    return profileFromFiles(files);
  } catch {
    return null;
  }
}

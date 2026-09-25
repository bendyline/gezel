/**
 * Shared primitives for the Store's surgical-edit methods
 * (replaceInProjectWorkspaceFile, applyPatchToProjectWorkspaceFile,
 * insertAtMarkerInProjectWorkspaceFile).
 *
 * Lives separate from store.ts so the helpers are unit-testable
 * without spinning up a Store + filesystem.
 */
import { readFile } from 'node:fs/promises';
import { TOOL_CALL_DIFF_MAX_BYTES } from '@bendyline/gezel';
import { createPatch } from 'diff';
import { WorkspaceEditError } from './errors.js';

/**
 * The shape every surgical-edit Store method returns. Mirrors the
 * `WorkspaceEditResponse` schema from core but without the literal
 * `ok: true` — that's added at the HTTP boundary.
 */
export interface WorkspaceEditResult {
  path: string;
  diff: string;
  addedLines: number;
  removedLines: number;
  diffTruncated?: boolean;
}

export {
  findAllOccurrences,
  findFlexibleMatch,
  computeReplaceInFile,
  computeReplaceLines,
  computeInsertAtMarker,
  type FlexibleMatch,
} from '@bendyline/gezel';

/**
 * Read a file's UTF-8 content for editing, mapping any read failure
 * (ENOENT, EISDIR, EACCES, etc.) to a `WorkspaceEditError` whose
 * message is shaped for the model — telling it the file isn't there
 * and suggesting `write_file` for net-new files.
 */
export async function readFileForEditOrThrow(fullPath: string, relPath: string): Promise<string> {
  try {
    return await readFile(fullPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new WorkspaceEditError(
      `Cannot edit ${relPath}: file does not exist (${reason}). Use \`write_file\` to create it first.`,
      'file-not-found',
    );
  }
}

/**
 * Build the response shape every surgical-edit method returns: a
 * unified diff (capped at TOOL_CALL_DIFF_MAX_BYTES) plus pre-computed
 * line counts so the UI doesn't need to re-parse the diff to show
 * `+12 −5`.
 */
export function buildWorkspaceEditResult(
  path: string,
  oldContent: string,
  newContent: string,
): WorkspaceEditResult {
  const fullDiff = createPatch(path, oldContent, newContent, '', '', { context: 3 });
  const { addedLines, removedLines } = countDiffLines(fullDiff);
  const truncated = Buffer.byteLength(fullDiff, 'utf8') > TOOL_CALL_DIFF_MAX_BYTES;
  const diff = truncated
    ? `${fullDiff.slice(0, TOOL_CALL_DIFF_MAX_BYTES)}\n[runtime] diff truncated — exceeded ${TOOL_CALL_DIFF_MAX_BYTES} bytes`
    : fullDiff;
  const result: WorkspaceEditResult = { path, diff, addedLines, removedLines };
  if (truncated) result.diffTruncated = true;
  return result;
}

/**
 * Count `+`/`-` body lines in a unified diff. Skips the file header
 * (`--- a/...`, `+++ b/...`) so renames of a file's header don't
 * inflate the count.
 */
function countDiffLines(diff: string): { addedLines: number; removedLines: number } {
  let added = 0;
  let removed = 0;
  let inHeader = true;
  for (const line of diff.split('\n')) {
    if (inHeader) {
      if (line.startsWith('@@')) inHeader = false;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    else if (line.startsWith('@@')) {
      // next hunk header — stay in body mode
    }
  }
  return { addedLines: added, removedLines: removed };
}

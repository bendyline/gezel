/**
 * Files that cloud-sync clients and desktop apps leave lying in a folder.
 *
 * The shared document library is explicitly relocatable onto OneDrive /
 * Dropbox / iCloud (Settings → Folders), so its content root is not a tidy
 * workspace: it receives lock files while a document is open in Word, partial
 * downloads mid-sync, and per-folder OS metadata. Indexing those produces
 * search hits for files the user cannot see and re-index churn every time a
 * sync client touches one.
 *
 * Deliberately name-based and conservative. A real document is never named
 * `~$report.docx`, but this predicate must never swallow something a person
 * actually filed, so it matches only well-known machine-generated shapes.
 */

import { isOutsideInInternalPath } from '@bendyline/gezel';

const EXACT_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'Icon\r',
  '.dropbox',
  '.dropbox.attr',
]);

const SUFFIXES = ['.tmp', '.temp', '.partial', '.crdownload', '.download', '.lnk'];

/** Office/LibreOffice owner-lock files: `~$doc.docx`, `.~lock.doc.odt#`. */
function isOfficeLock(name: string): boolean {
  return name.startsWith('~$') || (name.startsWith('.~lock.') && name.endsWith('#'));
}

/** OneDrive/Dropbox staging directories that appear mid-sync. */
const SYNC_STAGING_DIRS = new Set(['.tmp.drivedownload', '.tmp.driveupload', '.dropbox.cache']);

/** True when this single path segment is sync/app droppings. */
export function isSyncJunkName(name: string): boolean {
  if (EXACT_NAMES.has(name) || SYNC_STAGING_DIRS.has(name)) return true;
  if (isOfficeLock(name)) return true;
  const lower = name.toLowerCase();
  return SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** True when any segment of a forward-slashed relative path is sync junk. */
export function isSyncJunkPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => segment.length > 0 && isSyncJunkName(segment));
}

/**
 * Sync-conflict copies — the file a sync client writes when two devices edited
 * the same document. They are real user content, so they are indexed like any
 * other file; this only recognizes them so surfaces can flag them rather than
 * silently presenting two near-identical answers to the same question.
 */
const CONFLICT_PATTERNS: RegExp[] = [
  /\(conflicted copy[^)]*\)/i,
  /\(.*'s conflicted copy.*\)/i,
  /-conflict(ed)?-\d{4}-\d{2}-\d{2}/i,
  /\(case conflict[^)]*\)/i,
  / \(\d+\)\.[^.]+$/,
];

export function isSyncConflictCopy(relPath: string): boolean {
  const name = relPath.split('/').pop() ?? '';
  return CONFLICT_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Paths inside the shared document library that the content index must not
 * treat as documents in their own right.
 *
 * Outside-in editing stores an editable markdown twin plus version history and
 * a recovery copy beside a binary document (`brief.docx` →
 * `brief.docx_files/…`). The document itself is already indexed through its
 * conversion, so indexing the companion too yields two hits for one document —
 * and the model, offered both, may open the stale one. `.versions/` is the
 * editor's undo history, which is never an answer to a question.
 */
export function isLibraryInternalPath(relPath: string): boolean {
  if (isOutsideInInternalPath(relPath)) return true;
  if (isSyncJunkPath(relPath)) return true;
  return relPath.split('/').includes('.versions');
}

/**
 * Files that cloud-sync clients and desktop apps leave lying in a folder:
 * OS metadata, Office owner-locks, partial downloads, sync staging folders.
 *
 * Deliberately name-based and conservative. A real document is never named
 * `~$report.docx`, but this predicate must never swallow something a person
 * actually filed, so it matches only well-known machine-generated shapes.
 * Lives in core so the browser can filter a picked folder before uploading
 * the same files the service would refuse; the service re-exports it.
 */

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
export function isOfficeLockName(name: string): boolean {
  return name.startsWith('~$') || (name.startsWith('.~lock.') && name.endsWith('#'));
}

/** OneDrive/Dropbox staging directories that appear mid-sync. */
const SYNC_STAGING_DIRS = new Set(['.tmp.drivedownload', '.tmp.driveupload', '.dropbox.cache']);

/** True when this single path segment is sync/app droppings. */
export function isSyncJunkName(name: string): boolean {
  if (EXACT_NAMES.has(name) || SYNC_STAGING_DIRS.has(name)) return true;
  if (isOfficeLockName(name)) return true;
  const lower = name.toLowerCase();
  return SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** True when any segment of a forward-slashed relative path is sync junk. */
export function isSyncJunkPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => segment.length > 0 && isSyncJunkName(segment));
}

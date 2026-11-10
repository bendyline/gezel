/** Characters a file name cannot carry on Windows, macOS or Linux. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g;

export const SAVE_COPY_NAME_MAX_LENGTH = 80;

/**
 * The name "Save a copy…" offers for a finished file: the work's title with
 * the file's own extension ("One-page catering proposal for Harbor
 * Books.docx"), where the dialog used to offer `report.docx`. `suggested` may
 * already end in that extension, so the renderer and the desktop shell run the
 * same function and agree. Undefined when nothing nameable is left; the caller
 * then offers the file's base name.
 */
export function saveCopyFileName(suggested: string | undefined, path: string): string | undefined {
  const base = path.replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot) : '';
  let stem = suggested ?? '';
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) {
    stem = stem.slice(0, -extension.length);
  }
  const safe = stem
    .normalize('NFC')
    .replace(UNSAFE_FILE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SAVE_COPY_NAME_MAX_LENGTH)
    // Windows drops a trailing dot or space, then cannot find the file.
    .replace(/[. ]+$/, '');
  return safe ? `${safe}${extension}` : undefined;
}

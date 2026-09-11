/**
 * The user-facing name of the operating system's file browser.
 *
 * `platform` is Electron's `process.platform`, exposed to the renderer by
 * `window.__GEZEL__.platform`. Plain web builds and unfamiliar platforms use
 * the generic term rather than guessing at a desktop-specific application.
 */
export function fileManagerLabel(platform?: string): string {
  if (platform === 'darwin') return 'Finder';
  if (platform === 'win32') return 'File Explorer';
  return 'file manager';
}

/** The standard label for a button that reveals a path outside Gezel. */
export function openInFileManagerLabel(platform?: string): string {
  return `Open in ${fileManagerLabel(platform)}`;
}

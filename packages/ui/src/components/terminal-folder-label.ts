/**
 * Format a terminal `workingDir` / `cwd` value for display in the
 * folder pill / picker trigger. Rules:
 *
 *   - `''` (project root) → `/`
 *   - Project-relative paths get a leading `/` so the pill reads as
 *     `/packages/ui` instead of `packages/ui`. Server-side these are
 *     always forward-slash-separated regardless of OS.
 *   - Absolute paths the server emits when the shell cd'd outside
 *     the workspace are returned untouched in their native form
 *     (`/tmp/foo` on POSIX, `C:\Users\foo` on Windows) so they can
 *     be copy-pasted into other tools.
 */
export function formatFolderLabel(dir: string): string {
  if (dir === '') return '/';
  if (dir.startsWith('/')) return dir;
  if (/^[A-Za-z]:[\\/]/.test(dir)) return dir;
  return `/${dir}`;
}

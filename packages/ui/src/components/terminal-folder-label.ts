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
  // New terminal messages are sanitized at the PTY boundary, but older
  // persisted rows may still carry PowerShell/PSReadLine's prompt-color
  // suffix (e.g. `D:\repo\x1b[93m`). Clean at the display boundary too so
  // upgrading repairs existing timeline bubbles without rewriting history.
  const cleanDir = stripTerminalControls(dir);
  if (cleanDir === '') return '/';
  if (cleanDir.startsWith('/')) return cleanDir;
  if (/^[A-Za-z]:[\\/]/.test(cleanDir)) return cleanDir;
  return `/${cleanDir}`;
}

const TERMINAL_ESCAPE_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape bytes are the input.
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|\uFFFD\[[0-9;?]*[ -/]*[@-~]/g;

function stripTerminalControls(value: string): string {
  let clean = '';
  for (const char of value.replace(TERMINAL_ESCAPE_RE, '')) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) clean += char;
  }
  return clean.trim();
}

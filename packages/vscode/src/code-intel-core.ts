import { type FileContextResponse, type GezelHref, rewriteGezelHrefs } from '@bendyline/gezel';

/**
 * The vscode-free half of the code-intel provider (see code-intel.ts):
 * pure helpers unit-testable without an extension host.
 */

export const OPEN_FILE_COMMAND = 'gezel.codeIntel.openFile';
export const REVEAL_LINE_COMMAND = 'gezel.codeIntel.revealLine';
export const SHOW_SYMBOL_COMMAND = 'gezel.codeIntel.showSymbol';
export const TOGGLE_COMMAND = 'gezel.codeIntel.toggle';

/** Workspace-relative posix path for a doc inside `folder`, else null. */
export function relPathIn(folderFsPath: string, docFsPath: string): string | null {
  const sep = folderFsPath.includes('\\') ? '\\' : '/';
  const base =
    folderFsPath.endsWith('/') || folderFsPath.endsWith('\\') ? folderFsPath : folderFsPath + sep;
  if (!docFsPath.startsWith(base)) return null;
  const rel = docFsPath.slice(base.length).replace(/\\/g, '/');
  return rel || null;
}

/** Innermost symbol (smallest range) containing a 1-based line. */
export function symbolAt(
  response: FileContextResponse,
  line: number,
): FileContextResponse['symbols'][number] | null {
  let best: FileContextResponse['symbols'][number] | null = null;
  for (const s of response.symbols) {
    if (line < s.lineStart || line > s.lineEnd) continue;
    if (!best || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) best = s;
  }
  return best;
}

/** One gezel href → a vscode command URI (argument array JSON-encoded). */
export function toCommandHref(href: GezelHref): string {
  if (href.kind === 'line') {
    return `command:${REVEAL_LINE_COMMAND}?${encodeURIComponent(JSON.stringify([{ line: href.line }]))}`;
  }
  return `command:${OPEN_FILE_COMMAND}?${encodeURIComponent(
    JSON.stringify([{ path: href.path, ...(href.line ? { line: href.line } : {}) }]),
  )}`;
}

/** Composed markdown with every gezel link rewritten to a command URI. */
export function toCommandMarkdown(markdown: string): string {
  return rewriteGezelHrefs(markdown, toCommandHref);
}

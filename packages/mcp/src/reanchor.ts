/**
 * Post-edit re-anchoring for line-addressed edits.
 *
 * A successful `replace_lines` used to report only `Edited f.ts (+12 −8)`. The
 * model's only line-number anchor was the `read_file` gutter it saw BEFORE the
 * edit, and every line below the edit has now moved by (added − removed). To
 * aim a second edit it has to do that arithmetic itself — and measurably does
 * not: gemma4-e4b-q8 issued two `replace_lines` against one stale read, missed,
 * then abandoned surgical editing for full-file `write_file` rewrites
 * (bookstore-openapi and codebase-evolution, 2026-08-02).
 *
 * So state the shift and show the edited region re-numbered.
 */

/** Context lines shown either side of an edit in the re-anchor window. */
export const REANCHOR_CONTEXT_LINES = 4;
/** Hard cap so a large replacement can't flood the turn with its own echo. */
export const REANCHOR_MAX_CHARS = 1400;

/**
 * Prefix each line with a right-aligned line number and a `→` gutter, so the
 * model can target edits by line. The gutter is a display aid only — the edit
 * tools never see it. A trailing newline is preserved without numbering a
 * phantom final empty line. `startAt` numbers a window cut from mid-file.
 */
export function withLineNumbers(content: string, startAt = 1): string {
  if (content === '') return '';
  const hadTrailingNewline = content.endsWith('\n');
  const body = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = body.split('\n');
  const width = String(startAt + lines.length - 1).length;
  const numbered = lines
    .map((line, i) => `${String(startAt + i).padStart(width)}→${line}`)
    .join('\n');
  return hadTrailingNewline ? `${numbered}\n` : numbered;
}

/** Kill switch / A-B lever for {@link reanchorAfterEdit}. */
export function editReanchorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GEZEL_DISABLE_EDIT_REANCHOR;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Build the re-anchor suffix appended to a successful edit's tool result.
 *
 * Best-effort: any failure returns '' and the edit still reports success — a
 * re-anchor problem must never turn a good edit into a failed tool call.
 */
export async function reanchorAfterEdit(args: {
  path: string;
  startLine: number;
  addedLines: number;
  removedLines: number;
  readFile: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  if (editReanchorDisabled(args.env ?? process.env)) return '';
  try {
    const content = await args.readFile();
    if (content === '') return '';
    const body = content.endsWith('\n') ? content.slice(0, -1) : content;
    const lines = body.split('\n');
    const delta = args.addedLines - args.removedLines;
    const from = Math.max(1, args.startLine - REANCHOR_CONTEXT_LINES);
    const through = Math.min(
      lines.length,
      args.startLine + Math.max(args.addedLines, 1) - 1 + REANCHOR_CONTEXT_LINES,
    );
    if (through < from) return '';
    let window = withLineNumbers(lines.slice(from - 1, through).join('\n'), from);
    if (window.length > REANCHOR_MAX_CHARS) {
      window = `${window.slice(0, REANCHOR_MAX_CHARS)}\n… (window truncated; re-read for the rest)`;
    }
    const shift =
      delta === 0
        ? 'Line numbers elsewhere in the file are unchanged.'
        : `Every line after ${args.startLine} shifted by ${delta > 0 ? '+' : ''}${delta} — line numbers from an earlier read_file are stale past that point.`;
    return `\n\n${shift}\n${args.path} now reads:\n${window}`;
  } catch {
    return '';
  }
}

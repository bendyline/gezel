import { reanchorText } from '@bendyline/gezel';
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

export { REANCHOR_CONTEXT_LINES, REANCHOR_MAX_CHARS, withLineNumbers } from '@bendyline/gezel';

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
    return reanchorText({
      path: args.path,
      startLine: args.startLine,
      addedLines: args.addedLines,
      removedLines: args.removedLines,
      content: await args.readFile(),
    });
  } catch {
    return '';
  }
}

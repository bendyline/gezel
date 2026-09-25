/**
 * Which recorded tool call counts as "the assignee opened the exact supplied
 * source" for a `researchEvidence` gate.
 *
 * Extracted because the rule had started to exist in three places with three
 * different answers: the eval harness's seeded-read recognizer, the step tool
 * kit's read core, and this gate's matcher. The gate was the one that still
 * believed `read_file` was the only way to open a source file, so a book that
 * says "use `read_doc_as_markdown` for DOCX/PPTX/PDF/XLSX" had a gate that
 * refused the tool its own procedure mandates — the researcher opened the
 * .docx correctly and was told three times that no source acquisition ran,
 * until the step plateaued and the task paused with no deck.
 */

/**
 * Tools that open a named workspace source. `read_doc_as_markdown` is the
 * only one that can open a binary office document at all, so for a `.docx`
 * source it is not an alternative to `read_file` — it is the sole option.
 */
export const EXACT_SOURCE_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'read_artifact',
  'read_doc_as_markdown',
]);

/** Batch readers report their targets in `paths` rather than `path`. */
export const BATCH_SOURCE_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_files',
  'read_artifacts',
]);

/**
 * Compare two workspace paths the way the gate must: separator- and
 * case-insensitively, with the optional `workspace/` and `./` prefixes that
 * different tools report stripped.
 */
export function normalizeSourcePath(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^workspace\//i, '')
    .replace(/^\.\//, '')
    .toLocaleLowerCase();
}

export interface RecordedReadCall {
  tool: string;
  path?: string;
  paths?: readonly string[];
}

/**
 * True when `opened` is the expected source or, for a source that is a
 * folder (a craftbook input), a file inside it. A file source can never
 * prefix-match `file/…`, so the folder rule costs single-file sources nothing.
 */
function opensSource(opened: string | undefined, expected: string): boolean {
  if (opened === undefined) return false;
  const path = normalizeSourcePath(opened);
  return path === expected || path.startsWith(`${expected.replace(/\/+$/, '')}/`);
}

/** True when `call` opened `expectedPath` (or a file in it). Empty expectation never matches. */
export function isExactLocalSourceRead(call: RecordedReadCall, expectedPath: string): boolean {
  const expected = normalizeSourcePath(expectedPath);
  if (expected.length === 0) return false;
  if (EXACT_SOURCE_READ_TOOLS.has(call.tool)) return opensSource(call.path, expected);
  if (BATCH_SOURCE_READ_TOOLS.has(call.tool)) {
    return (call.paths ?? []).some((value) => opensSource(value, expected));
  }
  return false;
}

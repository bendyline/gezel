/** Pure text-edit semantics shared by desktop and portable hosts. */
import { WorkspaceEditError } from './workspace-edit-error.js';

/**
 * Find every occurrence of `needle` in `haystack`, returning a list
 * of start indices. Overlapping matches are skipped by advancing by
 * `needle.length` so `findAllOccurrences("aaaa", "aa") === [0, 2]`.
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/**
 * Whitespace-flexible, line-based fallback for `replace_in_file` when an
 * exact substring match finds nothing. Small models routinely botch the
 * indentation or internal spacing of a `find` snippet they copied from a
 * read — and they sometimes paste a line-number gutter (`  12→…`) from a
 * numbered `read_file`. Rather than bounce them into a full-file rewrite
 * (where they stomp their own work), we match on *normalized whole
 * lines*: strip a leading `N→` gutter, collapse internal whitespace, and
 * trim. The needle's leading/trailing blank lines are ignored so the
 * model can be sloppy about surrounding context.
 *
 * Returns the char range of the matched region (whole lines, excluding
 * the trailing newline of the last line) so the caller can splice in the
 * replacement. Ambiguous (>1 normalized match) is reported rather than
 * guessed — editing the wrong block is the failure mode we avoid.
 */
export type FlexibleMatch =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' };

function normalizeEditLine(line: string): string {
  return line
    .replace(/^\s*\d+→/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface LineSpan {
  text: string;
  start: number;
  end: number;
}

function lineSpans(text: string): LineSpan[] {
  const out: LineSpan[] = [];
  const re = /\r?\n/g;
  let start = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(start, m.index), start, end: m.index });
    start = re.lastIndex;
  }
  out.push({ text: text.slice(start), start, end: text.length });
  return out;
}

export function findFlexibleMatch(haystack: string, needle: string): FlexibleMatch {
  const rawNeedle = needle.split(/\r?\n/).map(normalizeEditLine);
  let lo = 0;
  let hi = rawNeedle.length;
  while (lo < hi && rawNeedle[lo] === '') lo++;
  while (hi > lo && rawNeedle[hi - 1] === '') hi--;
  const needleLines = rawNeedle.slice(lo, hi);
  if (needleLines.length === 0) return { kind: 'none' };

  const spans = lineSpans(haystack);
  const norm = spans.map((s) => normalizeEditLine(s.text));

  // Linear sequence matching keeps repetitive, model-supplied snippets from
  // monopolizing a foreground host. Retain overlapping whole-line matches.
  const prefix = new Array<number>(needleLines.length).fill(0);
  for (let i = 1, matched = 0; i < needleLines.length; i++) {
    while (matched > 0 && needleLines[i] !== needleLines[matched]) matched = prefix[matched - 1]!;
    if (needleLines[i] === needleLines[matched]) matched++;
    prefix[i] = matched;
  }
  let count = 0;
  let first = 0;
  for (let i = 0, matched = 0; i < norm.length; i++) {
    while (matched > 0 && norm[i] !== needleLines[matched]) matched = prefix[matched - 1]!;
    if (norm[i] === needleLines[matched]) matched++;
    if (matched === needleLines.length) {
      if (count++ === 0) first = i + 1 - matched;
      matched = prefix[matched - 1]!;
    }
  }
  if (count === 0) return { kind: 'none' };
  if (count > 1) return { kind: 'ambiguous', count };
  return {
    kind: 'range',
    start: spans[first]!.start,
    end: spans[first + needleLines.length - 1]!.end,
  };
}

/**
 * The `replace_in_file` transform, as a pure function of the old content.
 *
 * Lives here rather than inline in the Store method because the diffpack
 * draft store needs the identical semantics — including the whitespace-
 * flexible fallback and every error string, which models are trained on by
 * repetition. Two copies would drift, and the copy the model hit would be
 * the one nobody tested.
 *
 * `occurrence` defaults to "exactly one match required"; multi-match paths
 * require an explicit 1-based index or `'all'`. Deliberately strict —
 * silently editing a different match than the model intended is the failure
 * mode this avoids.
 */
export function computeReplaceInFile(
  oldContent: string,
  args: { path: string; find: string; replace: string; occurrence?: number | 'all' },
): string {
  const matches = findAllOccurrences(oldContent, args.find);
  const notFound = () =>
    new WorkspaceEditError(
      `pattern not found in ${args.path}. The file's content may have changed since you last read it — re-read and try again.`,
      'pattern-not-found',
    );

  let newContent: string;
  if (args.occurrence === 'all') {
    if (matches.length === 0) throw notFound();
    newContent = oldContent.split(args.find).join(args.replace);
  } else if (typeof args.occurrence === 'number') {
    const pos = matches[args.occurrence - 1];
    if (pos === undefined) {
      if (matches.length === 0) throw notFound();
      throw new WorkspaceEditError(
        `occurrence ${args.occurrence} out of range — found ${matches.length} match(es) in ${args.path}`,
        'occurrence-out-of-range',
      );
    }
    newContent = oldContent.slice(0, pos) + args.replace + oldContent.slice(pos + args.find.length);
  } else if (matches.length === 1) {
    const pos = matches[0]!;
    newContent = oldContent.slice(0, pos) + args.replace + oldContent.slice(pos + args.find.length);
  } else if (matches.length > 1) {
    throw new WorkspaceEditError(
      `pattern matches ${matches.length} places in ${args.path}; specify occurrence=<1-based index> or 'all'.`,
      'ambiguous-match',
    );
  } else {
    // No exact match. Fall back to a whitespace-flexible, line-based
    // match so a botched-indentation or gutter-pasted `find` still
    // lands instead of bouncing the model into a full-file rewrite.
    const flexible = findFlexibleMatch(oldContent, args.find);
    if (flexible.kind === 'ambiguous') {
      throw new WorkspaceEditError(
        `pattern matches ${flexible.count} places in ${args.path} (ignoring whitespace); add more surrounding lines to \`find\` so it is unique, or use \`replace_lines\`.`,
        'ambiguous-match',
      );
    }
    if (flexible.kind === 'none') throw notFound();
    newContent =
      oldContent.slice(0, flexible.start) + args.replace + oldContent.slice(flexible.end);
  }

  if (newContent === oldContent) {
    throw new WorkspaceEditError(
      `replace_in_file is a no-op on ${args.path} — \`find\` and \`replace\` produced identical content.`,
      'identity-edit',
    );
  }
  return newContent;
}

/**
 * The `replace_lines` transform. Preserves the file's newline style and
 * trailing-newline presence; `endLine` is clamped to the file length and
 * `content` may be empty (deletes the range).
 */
export function computeReplaceLines(
  oldContent: string,
  args: { path: string; startLine: number; endLine: number; content: string },
): string {
  if (args.endLine < args.startLine) {
    throw new WorkspaceEditError(
      `endLine (${args.endLine}) is before startLine (${args.startLine}) in ${args.path}.`,
      'invalid-range',
    );
  }

  const newlineStyle = oldContent.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = oldContent.endsWith('\n');
  const body = hadTrailingNewline ? oldContent.slice(0, -newlineStyle.length) : oldContent;
  const lines = body === '' ? [] : body.split(/\r?\n/);
  const total = lines.length;

  if (args.startLine > total) {
    throw new WorkspaceEditError(
      `startLine ${args.startLine} is past the end of ${args.path} (${total} line(s)). Re-read the file for current line numbers, or use \`append_to_file\` to add to the end.`,
      'line-out-of-range',
    );
  }
  const endLine = Math.min(args.endLine, total);

  const inserted = args.content === '' ? [] : args.content.replace(/\r?\n$/, '').split(/\r?\n/);
  const next = [...lines.slice(0, args.startLine - 1), ...inserted, ...lines.slice(endLine)];
  let newContent = next.join(newlineStyle);
  if (hadTrailingNewline && newContent !== '') newContent += newlineStyle;

  if (newContent === oldContent) {
    throw new WorkspaceEditError(
      `replace_lines is a no-op on ${args.path} — the new content matches lines ${args.startLine}-${endLine}.`,
      'identity-edit',
    );
  }
  return newContent;
}

/** The `insert_at_marker` transform. The marker must appear exactly once. */
export function computeInsertAtMarker(
  oldContent: string,
  args: { path: string; marker: string; content: string; where?: 'before' | 'after' },
): string {
  const where = args.where ?? 'after';
  const matches = findAllOccurrences(oldContent, args.marker);
  if (matches.length === 0) {
    throw new WorkspaceEditError(
      `marker not found in ${args.path}. Re-read the file and pass a literal substring that appears exactly once.`,
      'marker-not-found',
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceEditError(
      `marker matches ${matches.length} places in ${args.path}; pick a longer literal substring that's unique.`,
      'marker-ambiguous',
    );
  }
  const pos = matches[0]!;
  return where === 'after'
    ? oldContent.slice(0, pos + args.marker.length) +
        args.content +
        oldContent.slice(pos + args.marker.length)
    : oldContent.slice(0, pos) + args.content + oldContent.slice(pos);
}

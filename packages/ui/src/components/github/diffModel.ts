/**
 * Pure unified-diff parser for `GitDiffView`. Dependency-free per the
 * UI's convention (see ToolDiffBlock); exported separately so the
 * hunk/line-number math is unit-testable without rendering.
 */

export interface DiffLine {
  kind: 'add' | 'rem' | 'ctx';
  /** Line text without the leading +/-/space marker. */
  text: string;
  /** 1-based line number in the old file (absent for additions). */
  oldNo?: number;
  /** 1-based line number in the new file (absent for removals). */
  newNo?: number;
}

export interface DiffHunk {
  lines: DiffLine[];
  /** Unchanged lines between the previous hunk (or file start) and this one. */
  skippedBefore: number;
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** Total +/- across all hunks. */
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse unified-diff text into hunks with per-line old/new numbers.
 * Everything before the first `@@` header (git's `diff --git`/index/
 * `---`/`+++` preamble, or createPatch's `Index:`/`===` lines) is
 * skipped. `\ No newline at end of file` markers are dropped.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let oldNo = 0;
  let newNo = 0;
  let current: DiffHunk | null = null;
  let prevOldEnd = 0;

  const lines = diff.split('\n');
  // Drop the empty artifact a trailing newline leaves behind, so it
  // doesn't read as one extra context line at the end of the last hunk.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    const header = line.match(HUNK_RE);
    if (header) {
      const oldStart = Number.parseInt(header[1]!, 10);
      const newStart = Number.parseInt(header[3]!, 10);
      current = {
        lines: [],
        skippedBefore: Math.max(0, oldStart - prevOldEnd - 1),
      };
      hunks.push(current);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (!current) continue; // preamble before the first hunk
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1), newNo });
      newNo++;
      additions++;
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'rem', text: line.slice(1), oldNo });
      oldNo++;
      deletions++;
    } else if (line.startsWith(' ') || line === '') {
      // A bare empty line inside a hunk is an empty context line.
      current.lines.push({ kind: 'ctx', text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    } else {
      // A new file's preamble mid-stream (multi-file diff): close the
      // hunk and reset the between-hunks counter for the next file.
      current = null;
      prevOldEnd = 0;
      continue;
    }
    prevOldEnd = oldNo - 1;
  }

  return { hunks, additions, deletions };
}

export interface DiffFileSection {
  /** New-side path parsed from the `diff --git` header. */
  path: string;
  /** The full per-file slice, preamble included. */
  diff: string;
}

/**
 * Split a multi-file diff (e.g. one whole commit) into per-file
 * sections so each can render under its own header.
 */
export function splitMultiFileDiff(diff: string): DiffFileSection[] {
  const out: DiffFileSection[] = [];
  const lines = diff.split('\n');
  let currentPath: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentPath !== null) out.push({ path: currentPath, diff: buffer.join('\n') });
    buffer = [];
  };
  for (const line of lines) {
    const m = line.match(/^diff --git .* "?b\/(.+?)"?$/);
    if (m) {
      flush();
      currentPath = m[1] ?? '';
    }
    buffer.push(line);
  }
  flush();
  // No `diff --git` headers at all → single unnamed section.
  if (out.length === 0 && diff.trim().length > 0) return [{ path: '', diff }];
  return out;
}

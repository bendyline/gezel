/**
 * Pure parsers for the "changes" surface of the GitHub tab: porcelain
 * status, numstat, and log output. No I/O here — `GitManager` runs
 * the git commands and feeds the raw stdout through these so the gnarly
 * NUL-separated formats stay unit-testable without a real repo.
 */

/** SHA of git's well-known empty tree — diff base when HEAD is unborn. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Hard cap on entries returned to the UI from one changes listing. */
export const MAX_CHANGE_ENTRIES = 1_000;

/** Diff text beyond this many chars is cut at a line boundary. */
export const MAX_DIFF_CHARS = 200_000;

/** Untracked files larger than this are listed without line stats. */
export const MAX_UNTRACKED_STAT_BYTES = 1_024 * 1_024;

/** Conflict sides larger than this are flagged tooLarge, content omitted. */
export const MAX_CONFLICT_SIDE_CHARS = 512 * 1_024;

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted';

export interface ParsedStatusEntry {
  path: string;
  /** For renames: where the file lived before. */
  oldPath?: string;
  kind: ChangeKind;
  /** True for `??` entries — files git has never tracked. */
  untracked: boolean;
  /** Raw two-char porcelain code — conflict kinds need the detail. */
  xy: string;
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse `git status --porcelain=v1 -z` output. Entries are NUL-separated
 * `XY <path>`; rename entries are followed by one extra NUL-separated
 * field holding the ORIGINAL path. The index/worktree distinction is
 * deliberately collapsed — the UI never exposes a staging area.
 */
export function parseStatusZ(stdout: string): ParsedStatusEntry[] {
  const fields = stdout.split('\0');
  const out: ParsedStatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const xy = field.slice(0, 2);
    const path = field.slice(3);
    if (CONFLICT_CODES.has(xy)) {
      out.push({ path, kind: 'conflicted', untracked: false, xy });
      continue;
    }
    if (xy === '??') {
      out.push({ path, kind: 'added', untracked: true, xy });
      continue;
    }
    if (xy.includes('R') || xy.includes('C')) {
      // Renames/copies consume the next field as the original path.
      const oldPath = fields[++i];
      out.push({
        path,
        ...(oldPath ? { oldPath } : {}),
        kind: 'renamed',
        untracked: false,
        xy,
      });
      continue;
    }
    if (xy.includes('D')) {
      out.push({ path, kind: 'deleted', untracked: false, xy });
      continue;
    }
    if (xy.includes('A')) {
      out.push({ path, kind: 'added', untracked: false, xy });
      continue;
    }
    // Everything left (M, T, and mixed M/T states) reads as "edited".
    out.push({ path, kind: 'modified', untracked: false, xy });
  }
  return out;
}

export interface NumstatEntry {
  additions?: number;
  deletions?: number;
  binary: boolean;
}

/**
 * Parse `git diff --numstat -z -M` output into a path → stats map.
 * Plain entries are `add\tdel\tpath\0`; rename entries carry an EMPTY
 * path followed by `\0old\0new\0` — stats land under the NEW path.
 * Binary files report `-\t-`.
 */
export function parseNumstatZ(stdout: string): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>();
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const m = field.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const [, addRaw, delRaw, inlinePath] = m;
    const binary = addRaw === '-' || delRaw === '-';
    const entry: NumstatEntry = binary
      ? { binary: true }
      : {
          additions: Number.parseInt(addRaw!, 10),
          deletions: Number.parseInt(delRaw!, 10),
          binary: false,
        };
    if (inlinePath && inlinePath.length > 0) {
      out.set(inlinePath, entry);
    } else {
      // Rename record: the next two fields are old path then new path.
      i++; // old path — stats are keyed by the new one
      const newPath = fields[++i];
      if (newPath) out.set(newPath, entry);
    }
  }
  return out;
}

export interface ParsedLogEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** `--format` for `parseLog` — records split on \x01, fields on \x00. */
export const LOG_FORMAT = '%x01%H%x00%h%x00%an%x00%ae%x00%aI%x00%s';

/**
 * Parse `git log --format=<LOG_FORMAT> --numstat` output. Each \x01-
 * prefixed record is the header fields followed (after a newline) by
 * that commit's numstat lines (`add\tdel\tpath`).
 */
export function parseLog(stdout: string): ParsedLogEntry[] {
  const out: ParsedLogEntry[] = [];
  for (const record of stdout.split('\x01')) {
    if (!record.trim()) continue;
    const newline = record.indexOf('\n');
    const headerLine = newline === -1 ? record : record.slice(0, newline);
    const body = newline === -1 ? '' : record.slice(newline + 1);
    const [sha, shortSha, author, email, date, subject] = headerLine.split('\x00');
    if (!sha || !shortSha) continue;
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of body.split('\n')) {
      const m = line.match(/^(-|\d+)\t(-|\d+)\t/);
      if (!m) continue;
      filesChanged++;
      if (m[1] !== '-') additions += Number.parseInt(m[1]!, 10);
      if (m[2] !== '-') deletions += Number.parseInt(m[2]!, 10);
    }
    out.push({
      sha,
      shortSha,
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      subject: subject ?? '',
      filesChanged,
      additions,
      deletions,
    });
  }
  return out;
}

export interface NumstatFileEntry {
  path: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

/**
 * Parse plain (non `-z`) numstat lines, e.g. from `git show --numstat`.
 * Rename paths keep git's display form (`old => new`, `{a => b}/c`).
 */
export function parseNumstatLines(text: string): NumstatFileEntry[] {
  const out: NumstatFileEntry[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const [, addRaw, delRaw, path] = m;
    if (addRaw === '-' || delRaw === '-') {
      out.push({ path: path!, binary: true });
    } else {
      out.push({
        path: path!,
        additions: Number.parseInt(addRaw!, 10),
        deletions: Number.parseInt(delRaw!, 10),
      });
    }
  }
  return out;
}

/**
 * Heuristic binary sniff matching git's own: any NUL byte in the first
 * 8000 bytes means "not text".
 */
export function sniffBinary(buf: Uint8Array): boolean {
  const limit = Math.min(buf.length, 8_000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Count lines the way diff stats do: trailing newline doesn't add one. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Cut diff text at a line boundary at-or-before `maxChars`. Returns the
 * original string untouched when it fits.
 */
export function truncateDiff(
  diff: string,
  maxChars = MAX_DIFF_CHARS,
): { text: string; truncated: boolean } {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  const cut = diff.lastIndexOf('\n', maxChars);
  return { text: diff.slice(0, cut > 0 ? cut : maxChars), truncated: true };
}

/**
 * Whole-snapshot cap for code-review diffs (reviews/<id>/changes.diff).
 * 2× the per-file MAX_DIFF_CHARS: the reviewer reads it via read_artifact
 * slices, so bigger is fine — unbounded is not.
 */
export const REVIEW_DIFF_MAX_CHARS = 400_000;

export interface NameStatusEntry {
  kind: ChangeKind;
  oldPath?: string;
}

/**
 * Parse `git diff --name-status -z -M` output into path → change kind.
 * NUL framing: `STATUS\0path\0` per entry, except renames/copies which are
 * `RNNN\0old\0new\0`. Copies read as "added" (a new file from the review's
 * point of view); typechange reads as "modified".
 */
export function classifyNameStatus(stdout: string): Map<string, NameStatusEntry> {
  const out = new Map<string, NameStatusEntry>();
  const parts = stdout.split('\0');
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) break;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      i += 3;
      if (!oldPath || !newPath) break;
      if (code === 'R') out.set(newPath, { kind: 'renamed', oldPath });
      else out.set(newPath, { kind: 'added' });
      continue;
    }
    const path = parts[i + 1];
    i += 2;
    if (!path) break;
    const kind: ChangeKind =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'U' ? 'conflicted' : 'modified';
    out.set(path, { kind });
  }
  return out;
}

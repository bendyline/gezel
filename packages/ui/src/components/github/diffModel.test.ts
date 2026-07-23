import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, splitMultiFileDiff } from './diffModel.js';

const SIMPLE = [
  'diff --git a/notes.md b/notes.md',
  'index 111..222 100644',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -2,3 +2,3 @@',
  ' context line',
  '-old line',
  '+new line',
  ' trailing context',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('skips the preamble and numbers lines from the hunk header', () => {
    const parsed = parseUnifiedDiff(SIMPLE);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
    const lines = parsed.hunks[0]!.lines;
    expect(lines).toEqual([
      { kind: 'ctx', text: 'context line', oldNo: 2, newNo: 2 },
      { kind: 'rem', text: 'old line', oldNo: 3 },
      { kind: 'add', text: 'new line', newNo: 3 },
      { kind: 'ctx', text: 'trailing context', oldNo: 4, newNo: 4 },
    ]);
  });

  it('computes skipped-line counts between hunks', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,2 +10,2 @@', ' j', '-k', '+K'].join(
      '\n',
    );
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0]!.skippedBefore).toBe(0);
    // Hunk 1 ends at old line 2; hunk 2 starts at old line 10 → 7 skipped.
    expect(parsed.hunks[1]!.skippedBefore).toBe(7);
  });

  it('drops no-newline markers and handles a missing trailing newline', () => {
    const diff =
      '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file';
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.hunks[0]!.lines).toEqual([
      { kind: 'rem', text: 'old', oldNo: 1 },
      { kind: 'add', text: 'new', newNo: 1 },
    ]);
  });

  it('returns no hunks for empty or preamble-only input', () => {
    expect(parseUnifiedDiff('').hunks).toEqual([]);
    expect(parseUnifiedDiff('Binary files a/x and b/x differ\n').hunks).toEqual([]);
  });

  it('parses single-line hunk headers without counts (@@ -1 +1 @@)', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n');
    expect(parsed.hunks[0]!.lines).toHaveLength(2);
  });
});

describe('splitMultiFileDiff', () => {
  it('splits a whole-commit diff into per-file sections', () => {
    const diff = [
      'diff --git a/one.txt b/one.txt',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.txt b/two.txt',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ].join('\n');
    const sections = splitMultiFileDiff(diff);
    expect(sections.map((s) => s.path)).toEqual(['one.txt', 'two.txt']);
    expect(sections[0]!.diff).toContain('+b');
    expect(sections[1]!.diff).toContain('+d');
  });

  it('returns one unnamed section when there are no diff --git headers', () => {
    const sections = splitMultiFileDiff('@@ -1 +1 @@\n-a\n+b\n');
    expect(sections).toHaveLength(1);
    expect(sections[0]!.path).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(splitMultiFileDiff('')).toEqual([]);
  });
});

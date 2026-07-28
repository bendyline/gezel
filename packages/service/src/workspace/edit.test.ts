import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWorkspaceEditResult,
  findAllOccurrences,
  findFlexibleMatch,
  readFileForEditOrThrow,
} from './edit.js';
import { WorkspaceEditError } from './errors.js';

describe('findAllOccurrences', () => {
  it('returns every start index for a literal needle', () => {
    expect(findAllOccurrences('abc abc abc', 'abc')).toEqual([0, 4, 8]);
  });

  it('skips overlaps by advancing by needle.length', () => {
    expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 2]);
  });

  it('returns an empty array when the needle is empty', () => {
    expect(findAllOccurrences('hello', '')).toEqual([]);
  });

  it('returns an empty array when the needle is absent', () => {
    expect(findAllOccurrences('hello world', 'xyz')).toEqual([]);
  });

  it('handles multi-line literals', () => {
    expect(findAllOccurrences('a\nb\nc\na\nb\nc', 'a\nb')).toEqual([0, 6]);
  });
});

describe('findFlexibleMatch', () => {
  const file = 'function draw() {\n    ctx.clearRect(0, 0, 10, 10);\n    return true;\n}\n';

  it('matches a whole line despite wrong indentation', () => {
    // Model copied the line but lost the 4-space indent.
    const res = findFlexibleMatch(file, 'ctx.clearRect(0, 0, 10, 10);');
    expect(res.kind).toBe('range');
    if (res.kind === 'range') {
      expect(file.slice(res.start, res.end)).toBe('    ctx.clearRect(0, 0, 10, 10);');
    }
  });

  it('matches despite collapsed internal whitespace', () => {
    const res = findFlexibleMatch(file, 'ctx.clearRect(0,  0,   10, 10);');
    expect(res.kind).toBe('range');
  });

  it('strips a pasted `N→` line-number gutter from the needle', () => {
    const res = findFlexibleMatch(file, '  2→    ctx.clearRect(0, 0, 10, 10);');
    expect(res.kind).toBe('range');
    if (res.kind === 'range') {
      expect(file.slice(res.start, res.end)).toBe('    ctx.clearRect(0, 0, 10, 10);');
    }
  });

  it('matches a multi-line block and ignores surrounding blank lines in the needle', () => {
    const res = findFlexibleMatch(file, '\nctx.clearRect(0, 0, 10, 10);\nreturn true;\n');
    expect(res.kind).toBe('range');
    if (res.kind === 'range') {
      expect(file.slice(res.start, res.end)).toBe(
        '    ctx.clearRect(0, 0, 10, 10);\n    return true;',
      );
    }
  });

  it('reports ambiguity rather than guessing', () => {
    const dup = 'a();\nx();\nb();\nx();\n';
    const res = findFlexibleMatch(dup, 'x();');
    expect(res).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('returns none when no line matches', () => {
    expect(findFlexibleMatch(file, 'nonexistent.call();').kind).toBe('none');
  });

  it('returns none for a whitespace-only needle', () => {
    expect(findFlexibleMatch(file, '   ').kind).toBe('none');
  });
});

describe('readFileForEditOrThrow', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-edit-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns file content when the file exists', async () => {
    const path = join(dir, 'a.txt');
    await writeFile(path, 'hello', 'utf8');
    expect(await readFileForEditOrThrow(path, 'a.txt')).toBe('hello');
  });

  it('throws WorkspaceEditError(file-not-found) when missing', async () => {
    const path = join(dir, 'nope.txt');
    await expect(readFileForEditOrThrow(path, 'nope.txt')).rejects.toThrow(WorkspaceEditError);
    try {
      await readFileForEditOrThrow(path, 'nope.txt');
    } catch (err) {
      expect((err as WorkspaceEditError).code).toBe('file-not-found');
      expect((err as Error).message).toContain('nope.txt');
      expect((err as Error).message).toContain('write_file');
    }
  });
});

describe('buildWorkspaceEditResult', () => {
  it('produces a parseable unified diff with hunk headers', () => {
    const result = buildWorkspaceEditResult('a.txt', 'foo\nbar\n', 'foo\nBAR\n');
    expect(result.diff).toMatch(/@@.*@@/);
    expect(result.diff).toContain('-bar');
    expect(result.diff).toContain('+BAR');
  });

  it('counts added and removed lines correctly', () => {
    const oldContent = 'a\nb\nc\nd\n';
    const newContent = 'a\nB\nC\nD\nE\n';
    const result = buildWorkspaceEditResult('x.txt', oldContent, newContent);
    expect(result.addedLines).toBe(4);
    expect(result.removedLines).toBe(3);
  });

  it('marks diffTruncated when payload exceeds TOOL_CALL_DIFF_MAX_BYTES', () => {
    // Force a >100KB unified diff: 1500 changed lines × ~80 chars
    // each on both sides puts the diff well past the cap. Smaller
    // than this was tempting (faster!) but the `diff` library's
    // `createPatch` collapses small change-runs into hunks with
    // shared context, so we need enough churn to fill the budget.
    const big = (prefix: string) =>
      Array.from({ length: 1500 })
        .map((_, i) => `${prefix}-${'x'.repeat(60)}-line-${i}`)
        .join('\n');
    const result = buildWorkspaceEditResult('big.txt', `${big('old')}\n`, `${big('new')}\n`);
    expect(result.diffTruncated).toBe(true);
    expect(result.diff).toContain('[runtime] diff truncated');
    expect(result.diff.length).toBeLessThanOrEqual(100_200);
  });

  it('does not flag diffTruncated for ordinary edits', () => {
    const result = buildWorkspaceEditResult('a.txt', 'foo\n', 'bar\n');
    expect(result.diffTruncated).toBeUndefined();
  });
});

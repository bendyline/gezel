import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_READ_MAX_RANGE_LINES,
  WORKSPACE_READ_MAX_RESULT_BYTES,
  type WorkspaceReadFileSuccess,
} from '../schemas/api.js';
import {
  REANCHOR_MAX_CHARS,
  artifactCompletionHint,
  countLineChanges,
  formatWorkspaceRead,
  readArtifactText,
  reanchorText,
  sliceWorkspaceText,
  stepCompletionMode,
  toolErrorText,
  withLineNumbers,
  workspaceReadRangeError,
} from './results.js';

const lines = (n: number, text = (i: number) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => text(i + 1)).join('\n');

function ok(result: ReturnType<typeof sliceWorkspaceText>): WorkspaceReadFileSuccess {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result;
}

describe('toolErrorText', () => {
  it('prefixes the code and appends retryability and the next step only when given', () => {
    expect(toolErrorText('boom')).toBe('boom');
    expect(toolErrorText('boom', { code: 'E1', retryable: false, hint: 'read it first' })).toBe(
      '[E1] boom\nRetryable: false\nNext: read it first',
    );
  });
});

describe('withLineNumbers', () => {
  it('right-aligns numbers to the widest one and keeps a trailing newline unnumbered', () => {
    expect(withLineNumbers('a\nb\n', 9)).toBe(' 9→a\n10→b\n');
    expect(withLineNumbers('only')).toBe('1→only');
    expect(withLineNumbers('')).toBe('');
  });
});

describe('sliceWorkspaceText', () => {
  it('returns a whole small file as complete, keeping its final newline', () => {
    const result = ok(sliceWorkspaceText('a.txt', 'one\ntwo\n', {}));
    expect(result).toMatchObject({
      content: 'one\ntwo\n',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      completeFile: true,
      eof: true,
      hasMore: false,
      truncated: false,
    });
    expect(result.bytesReturned).toBe(8);
  });

  it('drops a carriage return before each newline', () => {
    expect(ok(sliceWorkspaceText('a.txt', 'one\r\ntwo\r\n', {})).content).toBe('one\ntwo\n');
  });

  it('reports no total and points at the next line when a range ends before the file does', () => {
    const result = ok(sliceWorkspaceText('a.txt', lines(10), { startLine: 2, endLine: 4 }));
    expect(result).toMatchObject({
      content: 'line 2\nline 3\nline 4',
      endLine: 4,
      completeFile: false,
      hasMore: true,
      nextStartLine: 5,
      truncated: false,
    });
    expect(result.totalLines).toBeUndefined();
  });

  it('caps an open-ended read at the range limit and says the line limit stopped it', () => {
    const result = ok(sliceWorkspaceText('big.txt', lines(WORKSPACE_READ_MAX_RANGE_LINES + 5), {}));
    expect(result.linesReturned).toBe(WORKSPACE_READ_MAX_RANGE_LINES);
    expect(result.nextStartLine).toBe(WORKSPACE_READ_MAX_RANGE_LINES + 1);
    expect(result.truncationReason).toBe('line-limit');
  });

  it('stops early at the output budget and refuses a single line larger than it', () => {
    const wide = 'x'.repeat(Math.ceil(WORKSPACE_READ_MAX_RESULT_BYTES / 3));
    const result = ok(
      sliceWorkspaceText(
        'wide.txt',
        lines(6, () => wide),
        {},
      ),
    );
    expect(result.linesReturned).toBeLessThan(6);
    expect(result.truncationReason).toBe('output-limit');
    expect(result.nextStartLine).toBe(result.linesReturned + 1);

    const huge = sliceWorkspaceText(
      'huge.txt',
      'y'.repeat(WORKSPACE_READ_MAX_RESULT_BYTES + 1),
      {},
    );
    expect(huge).toMatchObject({ status: 'error', code: 'line-too-long' });
  });

  it('refuses a start past the end, but reads an empty file from line one', () => {
    expect(sliceWorkspaceText('a.txt', 'one\n', { startLine: 3 })).toMatchObject({
      status: 'error',
      code: 'range-out-of-bounds',
    });
    expect(ok(sliceWorkspaceText('empty.txt', '', {}))).toMatchObject({
      content: '',
      linesReturned: 0,
      completeFile: true,
    });
  });
});

describe('formatWorkspaceRead', () => {
  it('heads a numbered slice with its range and names the exact call for the rest', () => {
    const slice = ok(sliceWorkspaceText('src/a.ts', lines(10), { startLine: 2, endLine: 3 }));
    const text = formatWorkspaceRead(slice, false);
    expect(text.split('\n')[0]).toBe('[read_file path="src/a.ts" lines=2-3 totalLines=?]');
    expect(text).toContain('2→line 2\n3→line 3');
    expect(text).toContain(
      `next: read_file({"path":"src/a.ts","startLine":4,"endLine":${4 + WORKSPACE_READ_MAX_RANGE_LINES - 1}})`,
    );
  });

  it('marks a whole file complete with no hint, and returns raw content unframed', () => {
    const whole = ok(sliceWorkspaceText('a.txt', 'one\n', {}));
    expect(formatWorkspaceRead(whole, false)).toBe(
      '[read_file path="a.txt" lines=1-1 totalLines=1 complete]\n1→one\n',
    );
    expect(formatWorkspaceRead(whole, true)).toBe('one\n');
  });

  it('says when no lines came back and names the truncation reason', () => {
    const empty = ok(sliceWorkspaceText('empty.txt', '', {}));
    expect(formatWorkspaceRead(empty, false)).toContain('lines=none totalLines=0');
    expect(formatWorkspaceRead(empty, false)).toContain('(no lines returned)');
    const capped = ok(sliceWorkspaceText('big.txt', lines(WORKSPACE_READ_MAX_RANGE_LINES + 1), {}));
    expect(formatWorkspaceRead(capped, false)).toContain('truncated=line-limit');
  });
});

describe('workspaceReadRangeError', () => {
  it('refuses reversed and oversized ranges and allows the rest', () => {
    expect(workspaceReadRangeError({ startLine: 5, endLine: 4 })).toContain(
      'must be greater than or equal to startLine (5)',
    );
    expect(workspaceReadRangeError({ endLine: WORKSPACE_READ_MAX_RANGE_LINES + 1 })).toContain(
      `at most ${WORKSPACE_READ_MAX_RANGE_LINES} lines`,
    );
    expect(workspaceReadRangeError({ startLine: 1, endLine: WORKSPACE_READ_MAX_RANGE_LINES })).toBe(
      null,
    );
    expect(workspaceReadRangeError({})).toBe(null);
  });
});

describe('readArtifactText', () => {
  it('returns a complete read untouched', () => {
    expect(readArtifactText('a.md', 'body')).toBe('body');
    expect(
      readArtifactText('a.md', 'body', { startLine: 1, linesReturned: 3, totalLines: 3 }),
    ).toBe('body');
  });

  it('places a partial slice and names the exact call for the next one', () => {
    const text = readArtifactText('notes.md', 'middle', {
      startLine: 11,
      linesReturned: 10,
      totalLines: 30,
    });
    expect(text).toContain('[lines 11-20 of 30. Earlier lines are not included in this slice.');
    expect(text).toContain('Next: read_artifact({"path":"notes.md","startLine":21,"endLine":30})]');
  });

  it('says a final slice ends the file', () => {
    expect(
      readArtifactText('notes.md', 'tail', { startLine: 21, linesReturned: 10, totalLines: 30 }),
    ).toContain('End of file; no later lines.');
  });
});

describe('countLineChanges', () => {
  it('counts the lines a unified diff would add and remove', () => {
    expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ addedLines: 1, removedLines: 1 });
    expect(countLineChanges('a\nc\n', 'a\nb\nc\n')).toEqual({ addedLines: 1, removedLines: 0 });
    expect(countLineChanges('', 'x\ny\n')).toEqual({ addedLines: 2, removedLines: 0 });
    expect(countLineChanges('same\n', 'same\n')).toEqual({ addedLines: 0, removedLines: 0 });
  });

  it('keeps unchanged lines inside a rewritten middle out of the count', () => {
    expect(countLineChanges('h\n1\nk\n2\nt\n', 'h\nA\nk\nB\nt\n')).toEqual({
      addedLines: 2,
      removedLines: 2,
    });
  });

  it('treats a line with and without its final newline as different', () => {
    expect(countLineChanges('a\nb', 'a\nb\n')).toEqual({ addedLines: 1, removedLines: 1 });
  });
});

describe('reanchorText', () => {
  const content = `${lines(20)}\n`;

  it('reports the shift and re-numbers the edited region with context', () => {
    const text = reanchorText({
      path: 'f.txt',
      startLine: 10,
      addedLines: 2,
      removedLines: 1,
      content,
    });
    expect(text).toContain(
      'Every line after 10 shifted by +1 — line numbers from an earlier read_file are stale past that point.',
    );
    expect(text).toContain('f.txt now reads:\n 6→line 6');
    expect(text).toContain('15→line 15');
    expect(text).not.toContain('16→');
  });

  it('says nothing moved when the edit kept its length, and shows negative shifts', () => {
    expect(
      reanchorText({ path: 'f.txt', startLine: 1, addedLines: 1, removedLines: 1, content }),
    ).toContain('Line numbers elsewhere in the file are unchanged.');
    expect(
      reanchorText({ path: 'f.txt', startLine: 3, addedLines: 0, removedLines: 2, content }),
    ).toContain('shifted by -2');
  });

  it('truncates a window larger than its cap and stays silent with nothing to show', () => {
    const wide = `${lines(12, () => 'w'.repeat(400))}\n`;
    const text = reanchorText({
      path: 'w.txt',
      startLine: 1,
      addedLines: 12,
      removedLines: 0,
      content: wide,
    });
    expect(text).toContain('… (window truncated; re-read for the rest)');
    expect(text.length).toBeLessThan(REANCHOR_MAX_CHARS + 400);
    expect(
      reanchorText({ path: 'f.txt', startLine: 1, addedLines: 0, removedLines: 0, content: '' }),
    ).toBe('');
    expect(
      reanchorText({ path: 'f.txt', startLine: 50, addedLines: 0, removedLines: 3, content }),
    ).toBe('');
  });
});

describe('artifact completion hints', () => {
  it('reads automatic completion from a gated step and manual from an ungated one', () => {
    expect(stepCompletionMode(undefined)).toBe('unknown');
    expect(stepCompletionMode({ advanceWhen: { artifact: 'report.md' } })).toBe('automatic');
    expect(stepCompletionMode({})).toBe('manual');
  });

  it('tells the model whether saving submits the step', () => {
    expect(artifactCompletionHint(undefined)).toBe('');
    expect(artifactCompletionHint('automatic')).toContain(
      'the runtime will run its completion gate',
    );
    expect(artifactCompletionHint('manual')).toContain('call advance_task_step');
    expect(artifactCompletionHint('unknown')).toContain(
      'Follow the active craftbook completion rule',
    );
  });
});

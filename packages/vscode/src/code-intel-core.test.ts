import type { FileContextResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { relPathIn, symbolAt, toCommandMarkdown } from './code-intel-core.js';

describe('relPathIn', () => {
  it('returns the workspace-relative posix path', () => {
    expect(relPathIn('/Users/me/repo', '/Users/me/repo/src/a.ts')).toBe('src/a.ts');
    expect(relPathIn('/Users/me/repo/', '/Users/me/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('normalizes windows separators', () => {
    expect(relPathIn('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  it('rejects documents outside the folder (incl. prefix cousins)', () => {
    expect(relPathIn('/Users/me/repo', '/Users/me/repo-two/src/a.ts')).toBeNull();
    expect(relPathIn('/Users/me/repo', '/tmp/x.ts')).toBeNull();
    expect(relPathIn('/Users/me/repo', '/Users/me/repo')).toBeNull();
  });
});

describe('symbolAt', () => {
  const sym = (name: string, lineStart: number, lineEnd: number) => ({
    name,
    kind: 'function',
    lineStart,
    lineEnd,
    importedBy: [],
    importedByTruncated: false,
    uses: [],
    usedInFileBy: [],
    findings: [],
  });
  const res = {
    symbols: [sym('outer', 1, 30), sym('inner', 5, 10), sym('later', 40, 45)],
  } as unknown as FileContextResponse;

  it('picks the innermost containing symbol', () => {
    expect(symbolAt(res, 7)?.name).toBe('inner');
    expect(symbolAt(res, 20)?.name).toBe('outer');
    expect(symbolAt(res, 42)?.name).toBe('later');
    expect(symbolAt(res, 35)).toBeNull();
  });
});

describe('toCommandMarkdown', () => {
  it('rewrites gezel-nav and #L links to argument-carrying command URIs', () => {
    const md = 'See [`a`](gezel-nav:src%2Fa.ts#L3) and [line 9](#L9).';
    const out = toCommandMarkdown(md);
    expect(out).toContain(
      `command:gezel.codeIntel.openFile?${encodeURIComponent(JSON.stringify([{ path: 'src/a.ts', line: 3 }]))}`,
    );
    expect(out).toContain(
      `command:gezel.codeIntel.revealLine?${encodeURIComponent(JSON.stringify([{ line: 9 }]))}`,
    );
  });

  it('leaves ordinary links untouched', () => {
    const md = '[web](https://example.com)';
    expect(toCommandMarkdown(md)).toBe(md);
  });
});

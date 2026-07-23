import { describe, expect, it } from 'vitest';
import {
  countLines,
  parseLog,
  parseNumstatLines,
  parseNumstatZ,
  parseStatusZ,
  sniffBinary,
  truncateDiff,
} from './changes.js';

describe('parseStatusZ', () => {
  it('maps the common single-file states', () => {
    const out = parseStatusZ(' M edited.ts\0?? brand-new.md\0 D gone.txt\0A  staged-new.js\0');
    expect(out).toEqual([
      { path: 'edited.ts', kind: 'modified', untracked: false, xy: ' M' },
      { path: 'brand-new.md', kind: 'added', untracked: true, xy: '??' },
      { path: 'gone.txt', kind: 'deleted', untracked: false, xy: ' D' },
      { path: 'staged-new.js', kind: 'added', untracked: false, xy: 'A ' },
    ]);
  });

  it('consumes the extra NUL field for renames and keeps the old path', () => {
    const out = parseStatusZ('R  new/name.ts\0old/name.ts\0 M after.ts\0');
    expect(out[0]).toEqual({
      path: 'new/name.ts',
      oldPath: 'old/name.ts',
      kind: 'renamed',
      untracked: false,
      xy: 'R ',
    });
    // The rename's second field must not desync the following entry.
    expect(out[1]?.path).toBe('after.ts');
  });

  it('maps every conflict XY code to conflicted', () => {
    const codes = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
    const input = codes.map((c, i) => `${c} f${i}.txt`).join('\0');
    const out = parseStatusZ(`${input}\0`);
    expect(out).toHaveLength(codes.length);
    for (const entry of out) expect(entry.kind).toBe('conflicted');
  });

  it('collapses index/worktree mixed states to one edited entry', () => {
    const out = parseStatusZ('MM both.ts\0');
    expect(out).toEqual([{ path: 'both.ts', kind: 'modified', untracked: false, xy: 'MM' }]);
  });

  it('handles paths with spaces (no quoting in -z mode)', () => {
    const out = parseStatusZ(' M my file with spaces.md\0');
    expect(out[0]?.path).toBe('my file with spaces.md');
  });

  it('returns empty for empty output', () => {
    expect(parseStatusZ('')).toEqual([]);
  });
});

describe('parseNumstatZ', () => {
  it('parses plain entries', () => {
    const out = parseNumstatZ('3\t1\tsrc/a.ts\0');
    expect(out.get('src/a.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
  });

  it('flags binary entries (-\\t-)', () => {
    const out = parseNumstatZ('-\t-\timg/logo.png\0');
    expect(out.get('img/logo.png')).toEqual({ binary: true });
  });

  it('keys rename records (empty inline path + old + new) by the new path', () => {
    // Concatenated so `\0` + `2` doesn't read as a legacy octal escape.
    const out = parseNumstatZ('5\t2\t\0old/path.ts\0new/path.ts\0' + '2\t0\tother.ts\0');
    expect(out.get('new/path.ts')).toEqual({ additions: 5, deletions: 2, binary: false });
    expect(out.has('old/path.ts')).toBe(false);
    expect(out.get('other.ts')).toEqual({ additions: 2, deletions: 0, binary: false });
  });
});

describe('parseLog', () => {
  const FMT = (sha: string, subject: string) =>
    `\x01${sha}\x00${sha.slice(0, 7)}\x00Mike\x00m@x.com\x002026-06-01T10:00:00-07:00\x00${subject}\n`;

  it('parses records with numstat aggregation', () => {
    const stdout = `${FMT('a'.repeat(40), 'first save')}\n3\t1\tsrc/a.ts\n2\t0\tREADME.md\n${FMT(
      'b'.repeat(40),
      'second save',
    )}\n-\t-\tlogo.png\n`;
    const out = parseLog(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      author: 'Mike',
      email: 'm@x.com',
      subject: 'first save',
      filesChanged: 2,
      additions: 5,
      deletions: 1,
    });
    // Binary numstat lines count as a changed file with no +/-.
    expect(out[1]).toMatchObject({ subject: 'second save', filesChanged: 1, additions: 0 });
  });

  it('returns empty for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseNumstatLines', () => {
  it('parses per-file entries including binary and rename display paths', () => {
    const out = parseNumstatLines('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n1\t1\tsrc/{old => new}/b.ts\n');
    expect(out).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'logo.png', binary: true },
      { path: 'src/{old => new}/b.ts', additions: 1, deletions: 1 },
    ]);
  });
});

describe('sniffBinary / countLines / truncateDiff', () => {
  it('sniffs NUL bytes as binary', () => {
    expect(sniffBinary(new Uint8Array([104, 105, 0, 33]))).toBe(true);
    expect(sniffBinary(new TextEncoder().encode('plain text\n'))).toBe(false);
  });

  it('counts lines the diff-stat way (trailing newline adds nothing)', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\ntwo\n')).toBe(2);
    expect(countLines('one\ntwo')).toBe(2);
  });

  it('truncates on a line boundary and flags it', () => {
    const diff = 'aaaa\nbbbb\ncccc\n';
    const { text, truncated } = truncateDiff(diff, 10);
    expect(truncated).toBe(true);
    expect(text).toBe('aaaa\nbbbb');
    expect(truncateDiff(diff, 1000)).toEqual({ text: diff, truncated: false });
  });
});

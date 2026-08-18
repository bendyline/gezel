import type { BoekwachterIssue, FileReviewIssueSeverity } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type FileEntry, buildTree } from './FileTree.js';
import {
  aggregateIssuesByFile,
  coerceFileViewMode,
  compareFilesByMtimeDesc,
  describeSeverities,
  fileEntryFromPath,
  formatFileSize,
  parentDirOf,
  sortAggregates,
  sortTreeNodes,
} from './file-view-modes.js';

function entry(path: string, isDirectory = false, mtimeMs?: number): FileEntry {
  const slash = path.lastIndexOf('/');
  return {
    name: slash >= 0 ? path.slice(slash + 1) : path,
    path,
    isDirectory,
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
}

let issueSeq = 0;
function issue(path: string, severity: FileReviewIssueSeverity): BoekwachterIssue {
  issueSeq += 1;
  return {
    ref: `BW-${issueSeq}`,
    id: `issue-${issueSeq}`,
    fingerprint: `fp-${issueSeq}`,
    path,
    severity,
    category: 'correctness',
    message: 'a problem',
    status: 'open',
    seen: false,
    stale: false,
    createdAt: '2026-08-01T00:00:00Z',
    lastSeenAt: '2026-08-01T00:00:00Z',
  };
}

describe('sortTreeNodes', () => {
  const entries: FileEntry[] = [
    entry('zeta.txt', false, 100),
    entry('docs', true),
    entry('docs/old.md', false, 50),
    entry('docs/new.md', false, 900),
    entry('alpha.txt', false, 500),
    entry('build', true),
    entry('no-stamp.txt'),
  ];

  it('alpha mode puts directories first, then everything alphabetical', () => {
    const sorted = sortTreeNodes(buildTree(entries), 'alpha');
    expect(sorted.map((n) => n.path)).toEqual([
      'build',
      'docs',
      'alpha.txt',
      'no-stamp.txt',
      'zeta.txt',
    ]);
    expect(sorted[1]?.children.map((n) => n.path)).toEqual(['docs/new.md', 'docs/old.md']);
  });

  it('modified mode keeps directories alphabetical, files newest-first, unstamped last', () => {
    const sorted = sortTreeNodes(buildTree(entries), 'modified');
    expect(sorted.map((n) => n.path)).toEqual([
      'build',
      'docs',
      'alpha.txt',
      'zeta.txt',
      'no-stamp.txt',
    ]);
    expect(sorted[1]?.children.map((n) => n.path)).toEqual(['docs/new.md', 'docs/old.md']);
  });

  it('falls back to name order for mtime ties', () => {
    const sorted = sortTreeNodes(
      buildTree([entry('b.txt', false, 100), entry('a.txt', false, 100)]),
      'modified',
    );
    expect(sorted.map((n) => n.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('does not mutate its input', () => {
    const tree = buildTree(entries);
    const before = JSON.stringify(tree);
    sortTreeNodes(tree, 'modified');
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('compareFilesByMtimeDesc', () => {
  it('orders newest first and sinks missing stamps', () => {
    const files = [entry('old.txt', false, 1), entry('none.txt'), entry('new.txt', false, 9)];
    files.sort(compareFilesByMtimeDesc);
    expect(files.map((f) => f.name)).toEqual(['new.txt', 'old.txt', 'none.txt']);
  });
});

describe('aggregateIssuesByFile + sortAggregates', () => {
  it('groups by path and weights severities (one major beats three minors)', () => {
    const aggs = aggregateIssuesByFile([
      issue('a.ts', 'minor'),
      issue('a.ts', 'minor'),
      issue('a.ts', 'minor'),
      issue('b.ts', 'major'),
      issue('c.ts', 'info'),
    ]);
    const byPath = new Map(aggs.map((a) => [a.path, a]));
    expect(byPath.get('a.ts')).toMatchObject({
      total: 3,
      score: 9,
      bySeverity: { major: 0, minor: 3, info: 0 },
    });
    expect(byPath.get('b.ts')).toMatchObject({ total: 1, score: 10 });

    expect(sortAggregates(aggs, 'count').map((a) => a.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(sortAggregates(aggs, 'score').map((a) => a.path)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });

  it('breaks ties by path alphabetically', () => {
    const aggs = aggregateIssuesByFile([issue('z.ts', 'info'), issue('a.ts', 'info')]);
    expect(sortAggregates(aggs, 'score').map((a) => a.path)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('describeSeverities', () => {
  it('lists only non-zero buckets, worst first', () => {
    expect(describeSeverities({ major: 2, minor: 1, info: 0 })).toBe('2 major · 1 minor');
    expect(describeSeverities({ major: 0, minor: 0, info: 3 })).toBe('3 info');
  });
});

describe('coerceFileViewMode', () => {
  it('accepts valid modes for the tab', () => {
    expect(coerceFileViewMode('flat-issues', 'workspace')).toBe('flat-issues');
    expect(coerceFileViewMode('flat-modified', 'artifacts')).toBe('flat-modified');
  });

  it('coerces workspace-only modes on artifacts and unknown values to tree-alpha', () => {
    expect(coerceFileViewMode('flat-issues', 'artifacts')).toBe('tree-alpha');
    expect(coerceFileViewMode('flat-criticality', 'artifacts')).toBe('tree-alpha');
    expect(coerceFileViewMode('nonsense', 'workspace')).toBe('tree-alpha');
    expect(coerceFileViewMode(null, 'workspace')).toBe('tree-alpha');
  });
});

describe('path helpers', () => {
  it('fileEntryFromPath derives the basename', () => {
    expect(fileEntryFromPath('docs/deep/note.md', 5)).toEqual({
      name: 'note.md',
      path: 'docs/deep/note.md',
      isDirectory: false,
      mtimeMs: 5,
    });
    expect(fileEntryFromPath('root.md')).toEqual({
      name: 'root.md',
      path: 'root.md',
      isDirectory: false,
    });
  });

  it('parentDirOf returns the containing folder or empty at root', () => {
    expect(parentDirOf('docs/deep/note.md')).toBe('docs/deep');
    expect(parentDirOf('root.md')).toBe('');
  });
});

describe('formatFileSize', () => {
  it('spells out bytes below a kilobyte', () => {
    expect(formatFileSize(0)).toBe('0 bytes');
    expect(formatFileSize(1)).toBe('1 byte');
    expect(formatFileSize(1023)).toBe('1023 bytes');
  });

  it('keeps one decimal from kilobytes up so sizes stay distinguishable', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(3.7 * 1024)).toBe('3.7 KB');
    expect(formatFileSize(1.4 * 1024 ** 2)).toBe('1.4 MB');
    expect(formatFileSize(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(formatFileSize(3 * 1024 ** 4)).toBe('3.0 TB');
    // No unit beyond TB — a petabyte file counts in thousands of them.
    expect(formatFileSize(2048 * 1024 ** 4)).toBe('2048.0 TB');
  });

  it('returns nothing for values that are not a size', () => {
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize(Number.NaN)).toBe('');
  });
});

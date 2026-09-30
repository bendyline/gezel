import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countLineChanges, sliceWorkspaceText } from '@bendyline/gezel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkspaceEditResult } from './edit.js';
import { readWorkspaceFiles } from './read-files.js';

/**
 * The portable runtime renders tool results from text it holds in memory;
 * these pin its numbers to the daemon's own reader and patch counter, which
 * are what desktop models read.
 */
const files: Record<string, string> = {
  'empty.txt': '',
  'one.txt': 'only line',
  'one-nl.txt': 'only line\n',
  'lines.txt': `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
  'long.txt': Array.from({ length: 450 }, (_, i) => `row ${i + 1}`).join('\n'),
  'blank-tail.txt': 'a\n\n',
};

const ranges: Array<{ startLine?: number; endLine?: number }> = [
  {},
  { startLine: 1 },
  { startLine: 3, endLine: 5 },
  { startLine: 1, endLine: 12 },
  { startLine: 10, endLine: 40 },
  { startLine: 2 },
  { startLine: 401 },
];

describe('portable result parity with the daemon', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-result-parity-'));
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('slices a line range exactly as the workspace reader does', async () => {
    for (const [name, content] of Object.entries(files)) {
      for (const range of ranges) {
        const { results } = await readWorkspaceFiles({
          workspaceDir: dir,
          files: [{ path: name, ...range }],
        });
        const daemon = results[0]!;
        const portable = sliceWorkspaceText(name, content, range);
        if (daemon.status === 'error') {
          expect(portable.status, `${name} ${JSON.stringify(range)}`).toBe('error');
          continue;
        }
        expect(portable, `${name} ${JSON.stringify(range)}`).toEqual(daemon);
      }
    }
  });

  it('counts changed lines exactly as a unified patch does', () => {
    const pairs: Array<[string, string]> = [
      ['', ''],
      ['', 'new\n'],
      ['a\nb\nc\n', 'a\nB\nc\n'],
      ['a\nb\nc\n', 'a\nb\nc\nd\n'],
      ['a\nb\nc', 'a\nb\nc\n'],
      ['x\ny\nz\n', 'z\ny\nx\n'],
      ['1\n2\n3\n4\n5\n', '1\n3\n5\n7\n'],
      [files['lines.txt']!, files['lines.txt']!.replace('line 6\n', 'line six\nline 6b\n')],
    ];
    for (const [before, after] of pairs) {
      const { addedLines, removedLines } = buildWorkspaceEditResult('f.txt', before, after);
      expect(countLineChanges(before, after), JSON.stringify([before, after])).toEqual({
        addedLines,
        removedLines,
      });
    }
  });
});

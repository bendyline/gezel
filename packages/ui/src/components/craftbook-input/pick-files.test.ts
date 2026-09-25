import { describe, expect, it } from 'vitest';
import {
  type PickedSet,
  filterPick,
  pickFromDirectoryInput,
  pickFromFileInput,
} from './pick-files.js';

function fileList(files: Array<{ name: string; relPath?: string; size?: number }>): FileList {
  const list = files.map(({ name, relPath, size = 10 }) => {
    const file = new File(['x'.repeat(size)], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: relPath ?? '' });
    return file;
  });
  return list as unknown as FileList;
}

describe('picks', () => {
  it('drops the picked folder’s own name from each path and uses it as the label', () => {
    const pick = pickFromDirectoryInput(
      fileList([
        { name: 'a.md', relPath: 'Blog drafts/a.md' },
        { name: 'b.md', relPath: 'Blog drafts/2024/b.md' },
      ]),
    );
    expect(pick.label).toBe('Blog drafts');
    expect(pick.files.map((f) => f.relPath)).toEqual(['a.md', '2024/b.md']);
  });

  it('labels loose files by name or count', () => {
    expect(pickFromFileInput(fileList([{ name: 'one.md' }])).label).toBe('one.md');
    expect(pickFromFileInput(fileList([{ name: 'a.md' }, { name: 'b.md' }])).label).toBe('2 files');
  });
});

describe('filterPick', () => {
  const pick = (files: Array<{ relPath: string; size?: number }>): PickedSet => ({
    label: 'Notes',
    files: files.map(({ relPath, size = 10 }) => ({
      relPath,
      file: new File(['x'.repeat(size)], relPath.split('/').pop()!),
    })),
  });

  it('skips junk silently and lists unaccepted files', () => {
    const result = filterPick(
      { kind: 'folder', accept: ['.md'] },
      pick([{ relPath: 'a.md' }, { relPath: '.DS_Store' }, { relPath: 'cover.png' }]),
    );
    expect(result.error).toBeUndefined();
    expect(result.accepted.map((f) => f.relPath)).toEqual(['a.md']);
    expect(result.skipped).toEqual([{ path: 'cover.png', reason: 'not-accepted' }]);
    expect(result.totalBytes).toBe(10);
  });

  it('refuses a pick over the file limit instead of cutting it short', () => {
    const result = filterPick(
      { kind: 'folder', maxFiles: 1 },
      pick([{ relPath: 'a.md' }, { relPath: 'b.md' }]),
    );
    expect(result.error).toMatch(/more than the 1 files/);
  });

  it('holds a single-file input to one file, and says when nothing fits', () => {
    expect(
      filterPick({ kind: 'file' }, pick([{ relPath: 'a.md' }, { relPath: 'b.md' }])).error,
    ).toMatch(/single file/);
    expect(
      filterPick({ kind: 'folder', accept: ['.md'] }, pick([{ relPath: 'x.png' }])).error,
    ).toMatch(/Nothing here is a file this craftbook reads \(\.md\)/);
  });
});

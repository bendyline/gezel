import { describe, expect, it, vi } from 'vitest';
import {
  deriveContainerScope,
  documentVersionBasename,
  markdownCompanionDirectory,
  moveFileWithCompanion,
} from './document-companion.js';

describe('document companion paths', () => {
  it('uses a sibling <stem>_files directory and extensionless version basename', () => {
    expect(deriveContainerScope('reports/quarterly.review.md')).toEqual({
      root: 'reports/quarterly.review_files',
      parentDirectory: 'reports',
      companionName: 'quarterly.review_files',
      primaryDocumentFilename: 'quarterly.review.md',
    });
    expect(documentVersionBasename('reports/quarterly.review.md')).toBe('quarterly.review');
    expect(markdownCompanionDirectory('notes')).toBe('notes_files');
    expect(markdownCompanionDirectory('image.png')).toBeNull();
  });
});

describe('moveFileWithCompanion', () => {
  it('moves the companion first and then the visible file', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);

    await moveFileWithCompanion(rename, 'notes.md', 'meeting.md', {
      from: 'notes_files',
      to: 'meeting_files',
    });

    expect(rename.mock.calls).toEqual([
      ['notes_files', 'meeting_files'],
      ['notes.md', 'meeting.md'],
    ]);
  });

  it('restores the companion when the visible-file rename fails', async () => {
    const failure = new Error('destination exists');
    const rename = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    await expect(
      moveFileWithCompanion(rename, 'notes.md', 'meeting.md', {
        from: 'notes_files',
        to: 'meeting_files',
      }),
    ).rejects.toBe(failure);
    expect(rename.mock.calls).toEqual([
      ['notes_files', 'meeting_files'],
      ['notes.md', 'meeting.md'],
      ['meeting_files', 'notes_files'],
    ]);
  });
});

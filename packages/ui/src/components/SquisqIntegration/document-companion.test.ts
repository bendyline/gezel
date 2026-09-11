import { describe, expect, it, vi } from 'vitest';
import {
  deriveContainerScope,
  documentVersionBasename,
  markdownCompanionDirectory,
  moveFileWithCompanion,
  rewriteDocumentCompanionRefs,
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

describe('rewriteDocumentCompanionRefs', () => {
  it('retargets Markdown, HTML, and reference-definition destinations', () => {
    const source = [
      '![Hero](quarterly.review_files/hero.png)',
      '[Appendix](<./quarterly.review_files/Appendix A.pdf>)',
      '<img src="quarterly.review_files/chart.png">',
      '[logo]: quarterly.review_files/logo.svg',
    ].join('\n');

    expect(
      rewriteDocumentCompanionRefs(
        source,
        'reports/quarterly.review.md',
        'reports/annual review.md',
      ),
    ).toBe(
      [
        '![Hero](annual%20review_files/hero.png)',
        '[Appendix](<./annual review_files/Appendix A.pdf>)',
        '<img src="annual review_files/chart.png">',
        '[logo]: annual%20review_files/logo.svg',
      ].join('\n'),
    );
  });

  it('preserves percent encoding and leaves prose and fenced examples alone', () => {
    const ticks = '```';
    const source = [
      'The assets live in My Notes_files/.',
      '![real](My%20Notes_files/hero.png)',
      ticks,
      '![example](My Notes_files/example.png)',
      ticks,
    ].join('\n');

    expect(rewriteDocumentCompanionRefs(source, 'My Notes.md', 'Final Notes.md')).toBe(
      [
        'The assets live in My Notes_files/.',
        '![real](Final%20Notes_files/hero.png)',
        ticks,
        '![example](My Notes_files/example.png)',
        ticks,
      ].join('\n'),
    );
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

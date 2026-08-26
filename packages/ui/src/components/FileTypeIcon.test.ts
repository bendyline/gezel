import { describe, expect, it } from 'vitest';
import { fileTypeIconFor } from './FileTypeIcon.js';

describe('fileTypeIconFor', () => {
  it.each([
    ['report.PDF', 'fa-regular', 'fa-file-pdf'],
    ['brief.docx', 'fa-regular', 'fa-file-word'],
    ['deck.pptx', 'fa-regular', 'fa-file-powerpoint'],
    ['budget.xlsx', 'fa-regular', 'fa-file-excel'],
    ['data.csv', 'fa-solid', 'fa-file-csv'],
    ['photo.webp', 'fa-regular', 'fa-file-image'],
    ['bundle.tar.gz', 'fa-regular', 'fa-file-zipper'],
    ['song.flac', 'fa-regular', 'fa-file-audio'],
    ['clip.webm', 'fa-regular', 'fa-file-video'],
    ['src/component.tsx', 'fa-regular', 'fa-file-code'],
    ['README', 'fa-regular', 'fa-file-lines'],
  ] as const)('maps %s to %s %s', (name, style, icon) => {
    expect(fileTypeIconFor(name)).toEqual({ style, icon });
  });
});

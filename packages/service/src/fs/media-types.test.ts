import { describe, expect, it } from 'vitest';
import { extForMimeType, mimeTypeForFilename } from './media-types.js';

describe('attachment media types', () => {
  it('recognizes common document and text attachment types', () => {
    expect(extForMimeType('application/pdf')).toBe('.pdf');
    expect(mimeTypeForFilename('brief.pdf')).toBe('application/pdf');
    expect(mimeTypeForFilename('notes.md')).toBe('text/markdown');
    expect(mimeTypeForFilename('workbook.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('keeps unknown files inert', () => {
    expect(extForMimeType('application/x-custom')).toBe('.bin');
    expect(mimeTypeForFilename('payload.custom')).toBe('application/octet-stream');
  });
});

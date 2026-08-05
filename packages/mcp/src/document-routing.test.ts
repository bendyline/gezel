import { describe, expect, it } from 'vitest';
import {
  binaryDocumentCraftbookRoute,
  isBinaryDocumentOutputPath,
  normalizeDocumentOutputPath,
} from './document-routing.js';

describe('binary document craftbook routing', () => {
  it.each([
    ['brief.pptx', 'powerpoint-deck'],
    ['report.docx', 'research-to-document'],
    ['report.pdf', 'report-pdf'],
    ['launch.mp4', 'narrated-slideshow'],
    ['launch.gif', 'narrated-slideshow'],
  ])('routes %s by production capability', (path, craftbookId) => {
    expect(binaryDocumentCraftbookRoute(path)?.craftbookId).toBe(craftbookId);
  });

  it('recognizes unsupported binary documents without inventing a Builder route', () => {
    expect(isBinaryDocumentOutputPath('model.xlsx')).toBe(true);
    expect(binaryDocumentCraftbookRoute('model.xlsx')).toBeNull();
  });

  it('preserves the requested name while normalizing workspace prefixes', () => {
    expect(normalizeDocumentOutputPath('workspace/presentations/D-Day.pptx')).toBe(
      'presentations/D-Day.pptx',
    );
  });
});

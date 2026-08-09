import { BINARY_DOCUMENT_EXTENSIONS } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  ROUTED_DOCUMENT_EXTENSIONS,
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

  it('only routes extensions core also recognizes as binary documents', () => {
    // A routable extension core does not know is a silent hole: the handoff
    // guard would wave the path through to a Builder that hand-writes bytes.
    for (const ext of ROUTED_DOCUMENT_EXTENSIONS) {
      expect(BINARY_DOCUMENT_EXTENSIONS, `routed extension "${ext}"`).toContain(ext);
    }
  });

  it('recognizes unsupported binary documents without inventing a Builder route', () => {
    expect(isBinaryDocumentOutputPath('model.xlsx')).toBe(true);
    expect(binaryDocumentCraftbookRoute('model.xlsx')).toBeNull();
  });

  it('preserves the requested name while normalizing workspace and artifact drawer prefixes', () => {
    expect(normalizeDocumentOutputPath('workspace/presentations/D-Day.pptx')).toBe(
      'presentations/D-Day.pptx',
    );
    expect(normalizeDocumentOutputPath('artifacts/marne-battle.pptx')).toBe('marne-battle.pptx');
  });
});

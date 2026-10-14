import { describe, expect, it } from 'vitest';
import { documentFocusParams, readDocumentFocus } from './document-focus.js';

const saved = {
  key: 'file:c:/docs/report.docx',
  kind: 'document' as const,
  app: 'Word',
  title: 'Report.docx',
};

describe('document focus in the frame URL', () => {
  it('round-trips the document, listing its path and its pane', () => {
    const params = new URLSearchParams(documentFocusParams(saved));
    expect(readDocumentFocus(params, 'pane-12345')).toEqual({
      subject: saved,
      keys: ['file:c:/docs/report.docx', 'surface:pane-12345'],
    });
  });

  it('lists an unsaved document once', () => {
    const unsaved = { ...saved, key: 'surface:pane-12345', title: 'Untitled document' };
    const params = new URLSearchParams(documentFocusParams(unsaved));
    expect(readDocumentFocus(params, 'pane-12345')?.keys).toEqual(['surface:pane-12345']);
  });

  it('is absent for an ordinary embedded chat or a malformed one', () => {
    expect(readDocumentFocus(new URLSearchParams('embedded=chat'), null)).toBeNull();
    const bad = new URLSearchParams(documentFocusParams(saved));
    bad.set('subjectKind', 'novel');
    expect(readDocumentFocus(bad, null)).toBeNull();
  });
});

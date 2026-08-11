import { describe, expect, it, vi } from 'vitest';

const { importDroppedDocumentFiles } = await import('./document-import.js');

function client() {
  return {
    writeDocument: vi.fn(async (path: string) => ({ ok: true as const, path })),
    writeDocumentBinary: vi.fn(async (path: string) => ({ ok: true as const, path })),
  };
}

describe('document drop import', () => {
  it('numbers a text document instead of overwriting an existing name', async () => {
    const api = client();
    const file = new File(['# New'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { value: vi.fn(async () => '# New') });

    const result = await importDroppedDocumentFiles({
      client: api as never,
      files: [file],
      existingPaths: ['notes.md'],
    });

    expect(result.importedPaths).toEqual(['notes 2.md']);
    expect(api.writeDocument).toHaveBeenCalledWith('notes 2.md', '# New');
  });

  it('stores an Office drop byte-for-byte without creating or enabling its companion', async () => {
    const api = client();
    const file = new File(['docx'], 'brief.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const result = await importDroppedDocumentFiles({
      client: api as never,
      files: [file],
      existingPaths: ['brief_files', 'brief_files/old.md'],
    });

    expect(result.importedPaths).toEqual(['brief 2.docx']);
    expect(api.writeDocumentBinary).toHaveBeenCalledWith('brief 2.docx', file, file.type);
    expect(api.writeDocumentBinary).toHaveBeenCalledTimes(1);
    expect(api.writeDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['handout.pdf', 'application/pdf'],
    ['page.html', 'text/html'],
    ['legacy.htm', 'text/html'],
  ])('keeps a dropped %s raw until outside-in editing is enabled', async (name, mimeType) => {
    const api = client();
    const file = new File(['original bytes'], name, { type: mimeType });

    const result = await importDroppedDocumentFiles({
      client: api as never,
      files: [file],
      existingPaths: [],
    });

    expect(result.importedPaths).toEqual([name]);
    expect(api.writeDocumentBinary).toHaveBeenCalledWith(name, file, mimeType);
    expect(api.writeDocumentBinary).toHaveBeenCalledTimes(1);
    expect(api.writeDocument).not.toHaveBeenCalled();
  });

  it('rejects unsupported file types without writing them', async () => {
    const api = client();
    const result = await importDroppedDocumentFiles({
      client: api as never,
      files: [new File(['zip'], 'archive.zip')],
      existingPaths: [],
    });

    expect(result.importedPaths).toEqual([]);
    expect(result.rejected).toEqual([{ name: 'archive.zip', reason: 'Unsupported document type' }]);
    expect(api.writeDocument).not.toHaveBeenCalled();
    expect(api.writeDocumentBinary).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { FOLDER_KIND_PROPERTY, folderKindOf, inferFolderKind } from './folder-kind.js';

describe('inferFolderKind', () => {
  it('trusts a well-known Pictures or Documents folder over its file mix', () => {
    expect(inferFolderKind({ wellKnownKind: 'pictures', modalities: { doc: 50 } })).toBe(
      'pictures',
    );
    expect(inferFolderKind({ wellKnownKind: 'documents', coding: true })).toBe('documents');
  });

  it('calls a codebase code even when most files are not source', () => {
    expect(inferFolderKind({ coding: true })).toBe('code');
    expect(inferFolderKind({ modalities: { code: 40, text: 50, image: 10 } })).toBe('code');
  });

  it('reads a clear majority of pictures or documents, and calls the rest mixed', () => {
    expect(inferFolderKind({ modalities: { image: 70, video: 10, doc: 20 } })).toBe('pictures');
    expect(inferFolderKind({ modalities: { doc: 50, text: 20, image: 30 } })).toBe('documents');
    expect(inferFolderKind({ modalities: { doc: 40, image: 40, audio: 20 } })).toBe('mixed');
    expect(inferFolderKind({ wellKnownKind: 'desktop', modalities: {} })).toBe('mixed');
  });
});

describe('folderKindOf', () => {
  it('reads only a known kind', () => {
    expect(folderKindOf({ properties: { [FOLDER_KIND_PROPERTY]: 'pictures' } })).toBe('pictures');
    expect(
      folderKindOf({ properties: { [FOLDER_KIND_PROPERTY]: 'spreadsheets' } }),
    ).toBeUndefined();
    expect(folderKindOf({})).toBeUndefined();
  });
});

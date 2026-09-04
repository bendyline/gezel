import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from './FileTree.js';
import {
  DOCUMENT_QUICK_LIST_STORAGE_KEY,
  documentQuickListEntries,
  readDocumentQuickListState,
  recordDocumentUsed,
  removeDocumentQuickListPath,
  renameDocumentQuickListPath,
  setDocumentPinned,
} from './document-quick-list.js';

const FILES: FileEntry[] = [
  { name: 'Zulu.md', path: 'Zulu.md', isDirectory: false, mtimeMs: 100 },
  { name: 'alpha.md', path: 'notes/alpha.md', isDirectory: false, mtimeMs: 600 },
  { name: 'Bravo.md', path: 'Bravo.md', isDirectory: false, mtimeMs: 500 },
  { name: 'charlie.md', path: 'charlie.md', isDirectory: false, mtimeMs: 400 },
  { name: 'delta.md', path: 'delta.md', isDirectory: false, mtimeMs: 300 },
  { name: 'echo.md', path: 'echo.md', isDirectory: false, mtimeMs: 200 },
  { name: 'old.md', path: 'old.md', isDirectory: false, mtimeMs: 50 },
  { name: 'notes', path: 'notes', isDirectory: true, mtimeMs: 700 },
];

describe('document quick list', () => {
  beforeEach(() => window.localStorage.clear());

  it('chooses five recent files by use or modification time, then displays them alphabetically', () => {
    const entries = documentQuickListEntries(FILES, {
      pinnedPaths: [],
      lastUsedAt: { 'old.md': 1_000 },
    });

    expect(entries.map((entry) => entry.name)).toEqual([
      'alpha.md',
      'Bravo.md',
      'charlie.md',
      'delta.md',
      'old.md',
    ]);
  });

  it('adds pins without consuming recent slots and never includes folders', () => {
    const entries = documentQuickListEntries(FILES, {
      pinnedPaths: ['Zulu.md', 'notes'],
      lastUsedAt: {},
    });

    expect(entries.map((entry) => entry.name)).toEqual([
      'alpha.md',
      'Bravo.md',
      'charlie.md',
      'delta.md',
      'echo.md',
      'Zulu.md',
    ]);
  });

  it('persists pin/use state and carries it through folder renames and deletes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    setDocumentPinned('notes/alpha.md', true);
    recordDocumentUsed('notes/alpha.md');
    renameDocumentQuickListPath('notes', 'archive');

    expect(readDocumentQuickListState()).toEqual({
      pinnedPaths: ['archive/alpha.md'],
      lastUsedAt: { 'archive/alpha.md': 1234 },
    });

    removeDocumentQuickListPath('archive');
    expect(readDocumentQuickListState()).toEqual({ pinnedPaths: [], lastUsedAt: {} });
    expect(window.localStorage.getItem(DOCUMENT_QUICK_LIST_STORAGE_KEY)).not.toBeNull();
  });
});

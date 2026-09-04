import { GezelApiError, type GezelClient } from '@bendyline/gezel-client';
import { describe, expect, it, vi } from 'vitest';
import {
  createDocumentMediaProvider,
  createDocumentsContentContainer,
  deriveContainerScope,
} from './documents-container.js';

function fakeClient(overrides: Record<string, unknown> = {}): GezelClient {
  return {
    listDocuments: vi.fn().mockResolvedValue({ files: [] }),
    readDocument: vi.fn(),
    fetchDocumentBlob: vi.fn(),
    writeDocument: vi.fn(),
    writeDocumentBinary: vi.fn(),
    deleteDocument: vi.fn(),
    ...overrides,
  } as unknown as GezelClient;
}

describe('document companion scope', () => {
  it.each([
    [
      'mission.md',
      {
        root: 'mission_files',
        parentDirectory: '',
        companionName: 'mission_files',
        primaryDocumentFilename: 'mission.md',
      },
    ],
    [
      'notes/diary.md',
      {
        root: 'notes/diary_files',
        parentDirectory: 'notes',
        companionName: 'diary_files',
        primaryDocumentFilename: 'diary.md',
      },
    ],
    [
      'test',
      {
        root: 'test_files',
        parentDirectory: '',
        companionName: 'test_files',
        primaryDocumentFilename: 'test',
      },
    ],
  ])('gives %s its own <stem>_files directory', (path, expected) => {
    expect(deriveContainerScope(path)).toEqual(expected);
  });

  it('lists and writes only inside the active document companion', async () => {
    const listDocuments = vi.fn().mockResolvedValue({
      files: [
        { path: 'test_files/hero.png', name: 'hero.png', isDirectory: false },
        { path: 'test_files/.versions/test.123.md', name: 'test.123.md', isDirectory: false },
      ],
    });
    const writeDocumentBinary = vi.fn().mockResolvedValue({ ok: true });
    const client = fakeClient({ listDocuments, writeDocumentBinary });
    const container = createDocumentsContentContainer({
      root: 'test_files',
      client,
      referencePrefix: 'test_files',
    });
    const provider = createDocumentMediaProvider(container, 'test_files');

    await expect(provider.listMedia()).resolves.toEqual([
      { name: 'test_files/hero.png', mimeType: 'image/png', size: 0 },
    ]);
    expect(listDocuments).toHaveBeenCalledWith('test_files', true);

    const bytes = new Uint8Array([1, 2, 3]);
    await expect(provider.addMedia('photo.png', bytes, 'image/png')).resolves.toBe(
      'test_files/photo.png',
    );
    expect(writeDocumentBinary).toHaveBeenCalledWith('test_files/photo.png', bytes, 'image/png');
  });

  it('accepts the portable companion prefix when resolving media bytes', async () => {
    const fetchDocumentBlob = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' }));
    const container = createDocumentsContentContainer({
      root: 'notes/diary_files',
      client: fakeClient({ fetchDocumentBlob }),
      referencePrefix: 'diary_files',
    });

    await expect(container.readFile('diary_files/images/figure.jpg')).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    expect(fetchDocumentBlob).toHaveBeenCalledWith('notes/diary_files/images/figure.jpg');
  });

  it('does not leak a sibling document companion into the active provider', async () => {
    const listDocuments = vi.fn().mockResolvedValue({ files: [] });
    const client = fakeClient({ listDocuments });
    const first = createDocumentMediaProvider(
      createDocumentsContentContainer({ root: 'first_files', client }),
      'first_files',
    );
    const second = createDocumentMediaProvider(
      createDocumentsContentContainer({ root: 'second_files', client }),
      'second_files',
    );

    await first.listMedia();
    await second.listMedia();

    expect(listDocuments).toHaveBeenNthCalledWith(1, 'first_files', true);
    expect(listDocuments).toHaveBeenNthCalledWith(2, 'second_files', true);
  });

  it('falls back for legacy loose media without resolving a sibling companion', async () => {
    const scopedRead = vi.fn().mockResolvedValue(null);
    const legacyRead = vi.fn().mockResolvedValue(null);
    const container = {
      readFile: scopedRead,
      writeFile: vi.fn(),
      removeFile: vi.fn(),
      listFiles: vi.fn().mockResolvedValue([]),
      exists: vi.fn(),
      getDocumentPath: vi.fn(),
      readDocument: vi.fn(),
      writeDocument: vi.fn(),
    };
    const legacyParent = { ...container, readFile: legacyRead };
    const provider = createDocumentMediaProvider(container, 'test_files', legacyParent);

    await expect(provider.resolveUrl('old-upload.png')).resolves.toBe('old-upload.png');
    expect(legacyRead).toHaveBeenCalledWith('old-upload.png');

    legacyRead.mockClear();
    await expect(provider.resolveUrl('other_files/image.png')).resolves.toBe(
      'other_files/image.png',
    );
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it('suppresses typed not-found errors but propagates storage failures', async () => {
    const missing = createDocumentsContentContainer({
      root: 'test_files',
      client: fakeClient({
        readDocument: vi.fn().mockRejectedValue(new GezelApiError('missing', 404)),
        deleteDocument: vi.fn().mockRejectedValue(new GezelApiError('missing', 404)),
      }),
    });
    await expect(missing.readFile('notes.md')).resolves.toBeNull();
    await expect(missing.removeFile('notes.md')).resolves.toBeUndefined();

    const denied = createDocumentsContentContainer({
      root: 'test_files',
      client: fakeClient({
        readDocument: vi.fn().mockRejectedValue(new GezelApiError('denied', 403)),
        deleteDocument: vi.fn().mockRejectedValue(new GezelApiError('denied', 403)),
      }),
    });
    await expect(denied.readFile('notes.md')).rejects.toMatchObject({ status: 403 });
    await expect(denied.removeFile('notes.md')).rejects.toMatchObject({ status: 403 });
  });
});

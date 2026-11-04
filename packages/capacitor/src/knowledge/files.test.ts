import { describe, expect, it, vi } from 'vitest';
import { FileMissingError, type RawFiles, archiveFiles } from './files.js';
import { catalogArchive } from './test-archive.js';

const ARCHIVE = '/regional-test/2026.1.0/catalog.gezk';

function store(files: Record<string, Uint8Array>): RawFiles {
  const file = (path: string) => {
    const bytes = files[path];
    if (!bytes) throw new FileMissingError(path);
    return bytes;
  };
  return {
    size: vi.fn((path: string) => file(path).length),
    read: vi.fn((path: string, offset: number, length: number) =>
      file(path).subarray(offset, offset + length),
    ),
  };
}

describe('archiveFiles', () => {
  it('serves the files inside an archive as its root directory', () => {
    const raw = store({
      [ARCHIVE]: catalogArchive([{ name: 'index/router.db', data: 'router bytes' }]),
    });
    const files = archiveFiles(raw);
    expect(files.size(`${ARCHIVE}/index/router.db`)).toBe(12);
    expect(new TextDecoder().decode(files.read(`${ARCHIVE}/index/router.db`, 7, 5))).toBe('bytes');
    // Reads stop at the entry's end, never running into the next entry.
    expect(new TextDecoder().decode(files.read(`${ARCHIVE}/index/router.db`, 7, 100))).toBe(
      'bytes',
    );
    expect(files.read(`${ARCHIVE}/index/router.db`, 50, 10)).toHaveLength(0);
  });

  it('reports missing entries and paths outside an archive as ENOENT', () => {
    const files = archiveFiles(store({ [ARCHIVE]: catalogArchive() }));
    expect(() => files.size(`${ARCHIVE}/index/router.db`)).toThrow(FileMissingError);
    expect(() => files.size('/regional-test/2026.1.0/index/router.db')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('indexes each archive once until it is forgotten', () => {
    const raw = store({
      [ARCHIVE]: catalogArchive([{ name: 'a.db', data: 'a' }]),
    });
    const files = archiveFiles(raw);
    files.size(`${ARCHIVE}/a.db`);
    files.size(`${ARCHIVE}/a.db`);
    expect(raw.size).toHaveBeenCalledTimes(1);
    files.forget(ARCHIVE);
    files.size(`${ARCHIVE}/a.db`);
    expect(raw.size).toHaveBeenCalledTimes(2);
  });
});

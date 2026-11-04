import { describe, expect, it } from 'vitest';
import { catalogArchive, storedZip } from './test-archive.js';
import { ArchiveFormatError, readArchiveIndex } from './zip.js';

const reader = (bytes: Uint8Array) => (offset: number, length: number) =>
  bytes.subarray(offset, offset + length);
const index = (bytes: Uint8Array) => readArchiveIndex(reader(bytes), bytes.length);
const text = (bytes: Uint8Array, entry: { offset: number; size: number } | undefined) =>
  new TextDecoder().decode(bytes.subarray(entry!.offset, entry!.offset + entry!.size));

describe('readArchiveIndex', () => {
  it('locates each stored entry in place', () => {
    const archive = catalogArchive([
      { name: 'index/', data: '' },
      { name: 'index/router.db', data: 'router bytes' },
      { name: 'shards/0.db', data: 'shard zero' },
    ]);
    const entries = index(archive);
    expect([...entries.keys()]).toEqual([
      'mimetype',
      'manifest.json',
      'index/router.db',
      'shards/0.db',
    ]);
    expect(text(archive, entries.get('index/router.db'))).toBe('router bytes');
    expect(text(archive, entries.get('shards/0.db'))).toBe('shard zero');
  });

  it('reads ZIP64 directories and entry fields', () => {
    const archive = catalogArchive([{ name: 'index/router.db', data: 'zip64 router' }], {
      zip64: true,
    });
    expect(text(archive, index(archive).get('index/router.db'))).toBe('zip64 router');
  });

  it.each([
    ['a compressed entry', { name: 'a.db', data: 'x', method: 8 }, 'compressed entry'],
    ['a size mismatch', { name: 'a.db', data: 'x', compressedSize: 2 }, 'compressed entry'],
    ['a parent path', { name: 'index/../../a.db', data: 'x' }, 'unsafe path'],
    ['an absolute path', { name: '/a.db', data: 'x' }, 'unsafe path'],
    ['a backslash path', { name: 'index\\a.db', data: 'x' }, 'unsafe path'],
    ['a drive path', { name: 'C:a.db', data: 'x' }, 'unsafe path'],
    ['an encrypted entry', { name: 'a.db', data: 'x', flags: 1 }, 'encrypted entry'],
    ['a symlink', { name: 'a.db', data: '/etc/passwd', mode: 0o120777 }, 'symlink entry'],
    ['a case-folded duplicate', { name: 'MANIFEST.json', data: '{}' }, 'duplicate entry'],
  ])('refuses %s', (_, entry, message) => {
    expect(() => index(catalogArchive([entry]))).toThrow(message);
  });

  it('requires the catalog mimetype first and a manifest', () => {
    expect(() =>
      index(
        storedZip([
          { name: 'manifest.json', data: '{}' },
          { name: 'mimetype', data: 'application/vnd.gezk+zip' },
        ]),
      ),
    ).toThrow('not a knowledge catalog archive');
    expect(() =>
      index(
        storedZip([
          { name: 'mimetype', data: 'application/zip' },
          { name: 'manifest.json', data: '{}' },
        ]),
      ),
    ).toThrow('not a knowledge catalog archive');
    expect(() =>
      index(storedZip([{ name: 'mimetype', data: 'application/vnd.gezk+zip' }])),
    ).toThrow('catalog archive has no manifest');
  });

  it('refuses bytes that are not a zip, or a truncated one', () => {
    expect(() => index(new TextEncoder().encode('not an archive'.repeat(4)))).toThrow(
      ArchiveFormatError,
    );
    const archive = catalogArchive([{ name: 'a.db', data: 'x'.repeat(64) }]);
    // A download cut short loses the end record.
    expect(() => readArchiveIndex(reader(archive), archive.length - 40)).toThrow(
      ArchiveFormatError,
    );
  });
});

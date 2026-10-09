import { describe, expect, it } from 'vitest';
import {
  type AlbumCopyStore,
  type AlbumMediaDeps,
  type PhotoAlbumStore,
  copyAlbumToFolder,
  isPhotoAlbumPath,
  listPhotoAlbums,
  parsePhotoAlbum,
  storeAlbumPhotos,
} from './photo-albums.js';

const BEACH = `---
title: Beach afternoon
squisq-theme: gezellig
album-from: 2026-09-20T14:00:00
album-to: 2026-09-20T17:10:00
---
# Beach afternoon

A long, lazy afternoon by the water.

## The sandcastle {[imageWithCaption caption="Where the day began" ambientMotion=zoomIn transition=dissolve]}

![The sandcastle](Camera/IMG_0001.HEIC)

## Late swim {[photoGrid caption="The water was cold"]}

![Jumping in](<Camera/IMG 0009.jpg>)
![Shivering](Camera/IMG_0010.jpg)
`;

function memoryStore(
  files: Record<string, string>,
  workspace: Set<string>,
): AlbumMediaDeps['store'] & AlbumCopyStore & { binaries: Map<string, Buffer> } {
  const binaries = new Map<string, Buffer>();
  return {
    binaries,
    listProjectArtifacts: async (_id, subpath) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${subpath}/`))
        .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false })),
    readProjectArtifact: async (_id, path) => files[path] ?? null,
    statProjectArtifactPath: async (_id, path) =>
      files[path] !== undefined || binaries.has(path)
        ? { kind: 'file', mtime: '2026-10-08T04:00:00.000Z' }
        : { kind: 'missing' },
    writeProjectArtifact: async (_id, path, content) => {
      files[path] = content;
    },
    writeProjectArtifactBinary: async (_id, path, data) => {
      binaries.set(path, data);
      return path;
    },
    statProjectWorkspacePath: async (_id, path) =>
      workspace.has(path) ? { kind: 'file' } : { kind: 'missing' },
    copyProjectWorkspacePath: async () => undefined,
  };
}

describe('album documents', () => {
  it('reads a Squisq slideshow album: title, span, story, and every photo with its caption', () => {
    const album = parsePhotoAlbum('albums/2026-09-20-beach-afternoon.md', BEACH);
    expect(album).toMatchObject({
      title: 'Beach afternoon',
      from: '2026-09-20T14:00:00',
      to: '2026-09-20T17:10:00',
      story: 'A long, lazy afternoon by the water.',
    });
    expect(album?.photos).toEqual([
      {
        src: 'Camera/IMG_0001.HEIC',
        original: 'Camera/IMG_0001.HEIC',
        caption: 'Where the day began',
      },
      {
        src: 'Camera/IMG 0009.jpg',
        original: 'Camera/IMG 0009.jpg',
        caption: 'The water was cold',
      },
      {
        src: 'Camera/IMG_0010.jpg',
        original: 'Camera/IMG_0010.jpg',
        caption: 'The water was cold',
      },
    ]);
  });

  it('is not an album without a photo, or outside albums/', () => {
    expect(parsePhotoAlbum('albums/notes.md', '# Notes\n\nNothing here.')).toBeNull();
    expect(isPhotoAlbumPath('albums/2026-09-20-beach.md')).toBe(true);
    expect(isPhotoAlbumPath('albums/2026-09-20-beach.json')).toBe(false);
    expect(isPhotoAlbumPath('albums/sub/x.md')).toBe(false);
    expect(isPhotoAlbumPath('albums/../reports/x.md')).toBe(false);
  });
});

describe('storeAlbumPhotos', () => {
  it('stores a copy of each linked photo with the album and records where it came from', async () => {
    const path = 'albums/2026-09-20-beach-afternoon.md';
    const files: Record<string, string> = { [path]: BEACH };
    const store = memoryStore(
      files,
      new Set(['Camera/IMG_0001.HEIC', 'Camera/IMG 0009.jpg', 'Camera/IMG_0010.jpg']),
    );
    const copied: string[] = [];
    const deps: AlbumMediaDeps = {
      store,
      copyPhoto: async (_id, src) => {
        copied.push(src);
        return Buffer.from(`jpeg of ${src}`);
      },
    };

    const result = await storeAlbumPhotos(deps, 'pics', path);

    expect(result).toEqual({ stored: 3, skipped: [] });
    const md = files[path]!;
    expect(md).toContain('![The sandcastle](2026-09-20-beach-afternoon_files/img_0001.jpg)');
    expect(md).toContain('![Jumping in](2026-09-20-beach-afternoon_files/img-0009.jpg)');
    expect(md).toContain('squisq-theme: gezellig');
    expect([...store.binaries.keys()].sort()).toEqual([
      'albums/2026-09-20-beach-afternoon_files/img-0009.jpg',
      'albums/2026-09-20-beach-afternoon_files/img_0001.jpg',
      'albums/2026-09-20-beach-afternoon_files/img_0010.jpg',
    ]);
    const album = parsePhotoAlbum(path, md);
    expect(album?.photos[0]).toEqual({
      src: '2026-09-20-beach-afternoon_files/img_0001.jpg',
      original: 'Camera/IMG_0001.HEIC',
      caption: 'Where the day began',
    });

    // Stored once: a second pass changes nothing and copies nothing.
    const before = files[path];
    expect(await storeAlbumPhotos(deps, 'pics', path)).toEqual({ stored: 0, skipped: [] });
    expect(files[path]).toBe(before);
    expect(copied).toHaveLength(3);
  });

  it('keeps the link, and says why, for a photo it cannot copy', async () => {
    const path = 'albums/a.md';
    const files: Record<string, string> = {
      [path]:
        '# A\n\n## One {[imageWithCaption]}\n\n![x](Camera/x.heic)\n\n## Two\n\n![y](gone.jpg)\n',
    };
    const store = memoryStore(files, new Set(['Camera/x.heic']));
    const result = await storeAlbumPhotos({ store, copyPhoto: async () => null }, 'pics', path);
    expect(result.stored).toBe(0);
    expect(result.skipped.map((s) => s.src).sort()).toEqual(['Camera/x.heic', 'gone.jpg']);
    expect(files[path]).toContain('![x](Camera/x.heic)');
  });

  it('lists albums newest first, with a workspace cover and what is still to be stored', async () => {
    const store = memoryStore(
      {
        'albums/2026-09-20-beach-afternoon.md': BEACH,
        'albums/2026-09-28-birthday.md':
          '---\nalbum-from: 2026-09-28T15:00:00\n---\n# Birthday\n\n## Cake {[imageWithCaption]}\n\n![Cake](Party/cake.jpg)\n',
        'albums/readme.md': '# Albums\n\nNothing to see.',
      },
      new Set(),
    );
    const albums = await listPhotoAlbums(store as PhotoAlbumStore, 'pics');
    expect(albums.map((a) => [a.title, a.count, a.pending, a.cover])).toEqual([
      ['Birthday', 1, 1, 'Party/cake.jpg'],
      ['Beach afternoon', 3, 3, 'Camera/IMG_0001.HEIC'],
    ]);
  });
});

describe('copyAlbumToFolder', () => {
  it('copies the full-size originals, not the stored copies, and never replaces a file', async () => {
    const path = 'albums/a.md';
    const files: Record<string, string> = {
      [path]: `---\ngezel-photo-originals: {"a_files/img_0001.jpg":"Camera/IMG_0001.HEIC"}\n---\n# A\n\n## One {[imageWithCaption]}\n\n![one](a_files/img_0001.jpg)\n\n## Two {[imageWithCaption]}\n\n![two](a_files/uploaded.png)\n`,
    };
    const workspace = new Set(['Camera/IMG_0001.HEIC', 'Albums/A/IMG_0001.HEIC']);
    const copies: string[][] = [];
    const store: AlbumCopyStore = {
      ...memoryStore(files, workspace),
      copyProjectWorkspacePath: async (_id, from, to, _ctx, opts) => {
        expect(opts?.userInitiated).toBe(true);
        copies.push([from, to]);
      },
    };

    const result = await copyAlbumToFolder(store, 'pics', path, '/Albums/A/');

    expect(copies).toEqual([['Camera/IMG_0001.HEIC', 'Albums/A/IMG_0001 (2).HEIC']]);
    expect(result).toEqual({
      folder: 'Albums/A',
      copied: 1,
      skipped: [{ path: 'a_files/uploaded.png', reason: 'not a photo from this folder' }],
    });
    await expect(copyAlbumToFolder(store, 'pics', path, '../Desktop')).rejects.toThrow(
      /inside this project/,
    );
  });
});

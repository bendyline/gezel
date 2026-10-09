import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readImageMeta, readImageStaticMeta } from './image-meta.js';
import {
  makePhotoRendition,
  pruneThumbnailCache,
  snapThumbWidth,
  thumbnailFor,
} from './thumbnails.js';

const jpeg = createRequire(import.meta.url)('jpeg-js') as typeof import('jpeg-js');

function photo(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i % 255;
    data[i * 4 + 1] = 120;
    data[i * 4 + 2] = 200;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
}

let dir: string;
let cacheDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-thumbs-'));
  cacheDir = join(dir, 'cache');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function shardFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(cacheDir).catch(() => [])) {
    for (const name of await readdir(join(cacheDir, shard))) out.push(name);
  }
  return out;
}

describe('thumbnailFor', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    if (platform === 'darwin' && process.platform !== 'darwin') continue;
    it(`shrinks a large photo once and serves the cached copy after (${platform})`, async () => {
      const abs = join(dir, 'IMG_0001.jpg');
      await writeFile(abs, photo(800, 600));

      const first = await thumbnailFor({
        cacheDir,
        absPath: abs,
        relPath: 'IMG_0001.jpg',
        width: 300,
        platform,
      });
      expect(first?.mimeType).toBe('image/jpeg');
      const meta = readImageMeta(first!.bytes);
      expect(Math.max(meta!.width, meta!.height)).toBe(320);
      expect(await shardFiles()).toHaveLength(1);

      const again = await thumbnailFor({
        cacheDir,
        absPath: abs,
        relPath: 'IMG_0001.jpg',
        width: 320,
        platform,
      });
      expect(again?.etag).toBe(first?.etag);
    });
  }

  it('serves a photo already smaller than the width as it is, without caching it', async () => {
    const abs = join(dir, 'small.jpg');
    const bytes = photo(40, 30);
    await writeFile(abs, bytes);

    const thumb = await thumbnailFor({ cacheDir, absPath: abs, relPath: 'small.jpg', width: 160 });

    expect(thumb?.bytes.equals(bytes)).toBe(true);
    expect(await shardFiles()).toEqual([]);
  });

  it('answers null for a file it cannot read as a photo', async () => {
    const abs = join(dir, 'notes.txt');
    await writeFile(abs, 'not a photo');
    expect(
      await thumbnailFor({
        cacheDir,
        absPath: abs,
        relPath: 'notes.txt',
        width: 160,
        platform: 'linux',
      }),
    ).toBeNull();
    expect(
      await thumbnailFor({
        cacheDir,
        absPath: join(dir, 'gone.jpg'),
        relPath: 'gone.jpg',
        width: 160,
      }),
    ).toBeNull();
  });

  it('snaps widths to the few it caches', () => {
    expect([undefined, 10, 160, 200, 640, 4000].map((w) => snapThumbWidth(w))).toEqual([
      320, 160, 160, 320, 640, 640,
    ]);
  });
});

describe('pruneThumbnailCache', () => {
  it('drops the least recently served thumbnails first', async () => {
    await mkdir(join(cacheDir, 'aa'), { recursive: true });
    const names = ['old', 'mid', 'new'];
    for (const [i, name] of names.entries()) {
      const path = join(cacheDir, 'aa', `${name}.jpg`);
      await writeFile(path, Buffer.alloc(1000));
      const at = new Date(Date.now() - (names.length - i) * 60_000);
      await utimes(path, at, at);
    }

    expect(await pruneThumbnailCache(cacheDir, 2500)).toBe(1);
    expect((await readdir(join(cacheDir, 'aa'))).sort()).toEqual(['mid.jpg', 'new.jpg']);
  });
});

/** An Exif APP1 segment: Orientation 6 (rotate 90° clockwise) and a GPS position. */
function exifSegment(): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 2 + 4 * 12 + 4 + 48);
  tiff.write('II*\0', 0, 'latin1');
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  const gps = 8 + 2 + 24 + 4;
  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(gps, 30);
  const data = gps + 2 + 48 + 4;
  tiff.writeUInt16LE(4, gps);
  const entry = (i: number, tag: number, type: number, count: number, value: number | string) => {
    const at = gps + 2 + i * 12;
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (typeof value === 'string') tiff.write(value, at + 8, 'latin1');
    else tiff.writeUInt32LE(value, at + 8);
  };
  entry(0, 0x0001, 2, 2, 'N\0');
  entry(1, 0x0002, 5, 3, data);
  entry(2, 0x0003, 2, 2, 'E\0');
  entry(3, 0x0004, 5, 3, data + 24);
  for (const [i, v] of [52, 22, 0, 4, 53, 0].entries()) {
    tiff.writeUInt32LE(v, data + i * 8);
    tiff.writeUInt32LE(1, data + i * 8 + 4);
  }
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([marker, body]);
}

describe('makePhotoRendition', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    if (platform === 'darwin' && process.platform !== 'darwin') continue;
    it(`stores a photo upright, at most 2048 on the long side, with no location (${platform})`, async () => {
      const original = photo(3000, 2000);
      const withExif = Buffer.concat([
        original.subarray(0, 2),
        exifSegment(),
        original.subarray(2),
      ]);
      expect(readImageStaticMeta(withExif, { includeLocation: true }).gps).toBeDefined();
      const abs = join(dir, 'IMG_0042.jpg');
      await writeFile(abs, withExif);

      const copy = await makePhotoRendition(abs, 2048, platform);

      const meta = readImageStaticMeta(copy!, { includeLocation: true });
      expect([meta.width, meta.height]).toEqual([1365, 2048]);
      expect(meta.exif).toBeUndefined();
      expect(meta.gps).toBeUndefined();
    });
  }
});

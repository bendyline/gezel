import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkspaceContentIndex } from './content-indexer.js';
import {
  exifFromHeifItem,
  rawPreviewJpeg,
  readHeifHeader,
  readImageMeta,
  readImageStaticMeta,
} from './image-meta.js';
import { IndexStore } from './index-store.js';
import { canNormalizeRaster, toDecodableRaster } from './raster-normalize.js';

const jpeg = createRequire(import.meta.url)('jpeg-js') as {
  encode(
    img: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Buffer };
};

function smallJpeg(width = 32, height = 24): Buffer {
  const data = new Uint8Array(width * height * 4).fill(180);
  return jpeg.encode({ data, width, height }, 80).data;
}

/** A little-endian TIFF block: IFD0 + an Exif IFD + data, offsets relative to `base`. */
function tiff(opts: {
  make: string;
  model: string;
  taken: string;
  width: number;
  height: number;
  preview?: Buffer;
  magic?: string;
}): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);
  header.write(opts.magic ?? 'II*\0', 0, 'latin1');
  header.writeUInt32LE(8, 4);
  const ifd0Count = opts.preview ? 5 : 3;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifCount = 3;
  const exifAt = 8 + ifd0Size;
  const exifSize = 2 + exifCount * 12 + 4;
  let dataAt = exifAt + exifSize;
  const blobs: Buffer[] = [];
  const place = (b: Buffer): number => {
    const at = dataAt;
    blobs.push(b);
    dataAt += b.length;
    return at;
  };
  const ascii = (s: string) => Buffer.from(`${s}\0`, 'latin1');
  const entry = (tag: number, type: number, count: number, value: number) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    e.writeUInt32LE(value, 8);
    return e;
  };
  const make = ascii(opts.make);
  const model = ascii(opts.model);
  const taken = ascii(opts.taken);
  const makeAt = place(make);
  const modelAt = place(model);
  const takenAt = place(taken);
  const previewAt = opts.preview ? place(opts.preview) : 0;

  const ifd0 = [
    Buffer.from([ifd0Count, 0]),
    entry(0x010f, 2, make.length, makeAt),
    entry(0x0110, 2, model.length, modelAt),
    entry(0x8769, 4, 1, exifAt),
    ...(opts.preview
      ? [entry(0x0201, 4, 1, previewAt), entry(0x0202, 4, 1, opts.preview.length)]
      : []),
    Buffer.alloc(4),
  ];
  const exif = [
    Buffer.from([exifCount, 0]),
    entry(0x9003, 2, taken.length, takenAt),
    entry(0xa002, 4, 1, opts.width),
    entry(0xa003, 4, 1, opts.height),
    Buffer.alloc(4),
  ];
  parts.push(header, ...ifd0, ...exif, ...blobs);
  return Buffer.concat(parts);
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const fullBox = (type: string, version: number, ...payload: Buffer[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...payload);
const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** ftyp + meta (iinf with an Exif item, iloc, ispe) + mdat holding the Exif after `padding` bytes. */
function heic(exifTiff: Buffer, padding = 0): Buffer {
  const exifItem = Buffer.concat([u32(6), Buffer.from('Exif\0\0', 'latin1'), exifTiff]);
  const ftyp = box(
    'ftyp',
    Buffer.from('heic', 'latin1'),
    u32(0),
    Buffer.from('mif1heic', 'latin1'),
  );
  const infe = fullBox('infe', 2, u16(2), u16(0), Buffer.from('Exif', 'latin1'));
  const iinf = fullBox('iinf', 0, u16(1), infe);
  const ispe = fullBox('ispe', 0, u32(4032), u32(3024));
  const iprp = box('iprp', box('ipco', ispe));
  const buildMeta = (exifOffset: number) =>
    fullBox(
      'meta',
      0,
      iinf,
      fullBox(
        'iloc',
        0,
        Buffer.from([0x44, 0x00]),
        u16(1),
        u16(2),
        u16(0),
        u16(1),
        u32(exifOffset),
        u32(exifItem.length),
      ),
      iprp,
    );
  const metaLength = buildMeta(0).length;
  const exifOffset = ftyp.length + metaLength + 8 + padding;
  const mdat = box('mdat', Buffer.alloc(padding), exifItem);
  return Buffer.concat([ftyp, buildMeta(exifOffset), mdat]);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-raw-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('camera RAW', () => {
  it('reads camera, capture date and size from the TIFF structure', () => {
    const raw = tiff({
      make: 'NIKON CORPORATION',
      model: 'NIKON Z 6',
      taken: '2021:08:14 09:12:30',
      width: 6048,
      height: 4024,
    });
    const meta = readImageStaticMeta(raw, { fileName: 'DSC_0001.NEF' });
    expect(meta).toMatchObject({ format: 'raw', width: 6048, height: 4024 });
    expect(meta.exif).toMatchObject({
      make: 'NIKON CORPORATION',
      model: 'NIKON Z 6',
      dateTimeOriginal: '2021:08:14 09:12:30',
    });
    // A plain TIFF with the same header is not a RAW.
    expect(readImageStaticMeta(raw, { fileName: 'scan.tif' }).format).toBe('unknown');
  });

  it('finds the embedded JPEG preview and decodes it to a temporary file', async () => {
    const preview = smallJpeg(64, 48);
    const raw = tiff({
      make: 'SONY',
      model: 'ILCE-7M3',
      taken: '2022:01:02 03:04:05',
      width: 6000,
      height: 4000,
      preview,
    });
    expect(rawPreviewJpeg(raw)?.equals(preview)).toBe(true);
    const path = join(dir, 'DSC00001.ARW');
    await writeFile(path, raw);

    const raster = await toDecodableRaster(path, new Set(['jpg', 'jpeg', 'png']), {
      scratchDir: join(dir, 'scratch'),
    });
    expect(raster?.path).not.toBe(path);
    expect(readImageMeta(await readFile(raster!.path))).toMatchObject({
      format: 'jpeg',
      width: 64,
      height: 48,
    });
    await raster!.release();
    await expect(readFile(raster!.path)).rejects.toThrow();
  });
});

describe('HEIC', () => {
  const exifTiff = tiff({
    make: 'Apple',
    model: 'iPhone 15 Pro',
    taken: '2024:06:01 18:30:00',
    width: 4032,
    height: 3024,
  });

  it('reads the size and Exif from the meta box', () => {
    const file = heic(exifTiff);
    const header = readHeifHeader(file);
    expect(header).toMatchObject({ width: 4032, height: 3024 });
    const meta = readImageStaticMeta(file, { fileName: 'IMG_0001.HEIC' });
    expect(meta).toMatchObject({ format: 'heic', width: 4032, height: 3024 });
    expect(meta.exif).toMatchObject({ make: 'Apple', dateTimeOriginal: '2024:06:01 18:30:00' });
  });

  it('locates Exif that sits past the head, for a second read', () => {
    const file = heic(exifTiff, 64 * 1024);
    const head = file.subarray(0, 4096);
    const at = readHeifHeader(head)?.exif;
    expect(at).toBeDefined();
    const parsed = exifFromHeifItem(file.subarray(at!.offset, at!.offset + at!.length));
    expect(parsed?.exif.model).toBe('iPhone 15 Pro');
    expect(readImageStaticMeta(head, { fileName: 'IMG.HEIC' }).exif).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin')(
    'converts a real HEIC to a JPEG with the system tools on macOS',
    async () => {
      const source = join(dir, 'source.jpg');
      await writeFile(source, smallJpeg(120, 80));
      const photo = join(dir, 'photo.heic');
      execFileSync('sips', ['-s', 'format', 'heic', source, '--out', photo], { stdio: 'ignore' });
      expect(readImageStaticMeta(await readFile(photo), { fileName: photo }).format).toBe('heic');

      const raster = await toDecodableRaster(photo, new Set(['jpg']), {
        scratchDir: join(dir, 'scratch'),
      });
      expect(readImageMeta(await readFile(raster!.path))).toMatchObject({
        format: 'jpeg',
        width: 120,
        height: 80,
      });
      await raster!.release();
    },
  );

  it('has no decoder for HEIC off macOS yet', () => {
    expect(canNormalizeRaster('IMG.heic', 'linux')).toBe(false);
    expect(canNormalizeRaster('IMG.heic', 'darwin')).toBe(true);
    expect(canNormalizeRaster('DSC.nef', 'win32')).toBe(true);
  });
});

describe('indexing a camera folder', () => {
  it('records RAW and HEIC camera, date and size, reading only the head of a big file', async () => {
    const work = join(dir, 'Pictures');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(work, { recursive: true });
    await writeFile(
      join(work, 'DSC_0001.NEF'),
      tiff({
        make: 'NIKON CORPORATION',
        model: 'NIKON Z 6',
        taken: '2021:08:14 09:12:30',
        width: 6048,
        height: 4024,
      }),
    );
    // Over the streaming threshold, with the Exif item past the 2 MB head.
    await writeFile(
      join(work, 'IMG_0001.HEIC'),
      heic(
        tiff({
          make: 'Apple',
          model: 'iPhone 15 Pro',
          taken: '2024:06:01 18:30:00',
          width: 4032,
          height: 3024,
        }),
        9 * 1024 * 1024,
      ),
    );
    const dbPath = join(dir, 'index.db');
    await runWorkspaceContentIndex(work, 'c', join(dir, 'artifacts'), { dbPath });

    const store = (await IndexStore.open(dbPath, {
      collectionId: 'c',
      kind: 'workspace',
      rootPath: work,
    }))!;
    try {
      expect(store.getFile('DSC_0001.NEF')?.modality).toBe('image');
      expect(store.getMetadata('DSC_0001.NEF')).toMatchObject({
        format: 'raw',
        width: '6048',
        taken_at: '2021-08-14T09:12:30',
        camera_model: 'NIKON Z 6',
      });
      expect(store.getMetadata('IMG_0001.HEIC')).toMatchObject({
        format: 'heic',
        width: '4032',
        taken_at: '2024-06-01T18:30:00',
        camera_make: 'Apple',
      });
    } finally {
      store.close();
    }
  });
});

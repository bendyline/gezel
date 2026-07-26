import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readImageMeta, readImageStaticMeta } from './image-meta.js';

const pad = (bytes: number[], to: number) =>
  Buffer.concat([Buffer.from(bytes), Buffer.alloc(Math.max(0, to - bytes.length))]);

describe('readImageMeta', () => {
  it('reads PNG dimensions', () => {
    const png = pad(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02,
      ],
      28,
    );
    expect(readImageMeta(png)).toEqual({ format: 'png', width: 800, height: 600 });
  });

  it('reads GIF dimensions', () => {
    const gif = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x02, 0xe0, 0x01], 24);
    expect(readImageMeta(gif)).toEqual({ format: 'gif', width: 640, height: 480 });
  });

  it('reads JPEG dimensions from the SOF marker', () => {
    const jpeg = pad([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40], 24);
    expect(readImageMeta(jpeg)).toEqual({ format: 'jpeg', width: 320, height: 240 });
  });

  it('returns null for unknown data', () => {
    expect(readImageMeta(Buffer.alloc(40))).toBeNull();
  });
});

/** Build a PNG with an IHDR of the given size plus arbitrary text chunks. */
function png(
  width: number,
  height: number,
  chunks: Array<{ type: string; data: Buffer }> = [],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    // CRC is never validated by the reader, so zeros keep the fixture honest
    // about what the parser actually depends on.
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...chunks.map((c) => chunk(c.type, c.data)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const tEXt = (key: string, value: string) => ({
  type: 'tEXt',
  data: Buffer.concat([Buffer.from(`${key}\0`, 'latin1'), Buffer.from(value, 'latin1')]),
});

/** Little-endian TIFF/EXIF inside an APP1 segment inside a JPEG. */
function jpegWithExif(opts: {
  make?: string;
  model?: string;
  software?: string;
  gps?: { lat: [number, number, number]; lon: [number, number, number] };
}): Buffer {
  const entries: Array<{ tag: number; type: number; value: string | number[] }> = [];
  if (opts.make) entries.push({ tag: 0x010f, type: 2, value: `${opts.make}\0` });
  if (opts.model) entries.push({ tag: 0x0110, type: 2, value: `${opts.model}\0` });
  if (opts.software) entries.push({ tag: 0x0131, type: 2, value: `${opts.software}\0` });

  // Lay out IFD0, then a GPS IFD, then the heap of out-of-line values.
  const gpsEntryCount = opts.gps ? 4 : 0;
  const ifd0Count = entries.length + (opts.gps ? 1 : 0);
  const ifd0At = 8;
  const gpsAt = ifd0At + 2 + ifd0Count * 12 + 4;
  const heapAt = gpsAt + (opts.gps ? 2 + gpsEntryCount * 12 + 4 : 0);

  const heap: Buffer[] = [];
  let heapLen = 0;
  const spill = (buf: Buffer): number => {
    const at = heapAt + heapLen;
    heap.push(buf);
    heapLen += buf.length;
    return at;
  };

  const entryBuf = (tag: number, type: number, count: number, inline: Buffer): Buffer => {
    const b = Buffer.alloc(12);
    b.writeUInt16LE(tag, 0);
    b.writeUInt16LE(type, 2);
    b.writeUInt32LE(count, 4);
    inline.copy(b, 8);
    return b;
  };

  const ifd0Entries: Buffer[] = [];
  for (const e of entries) {
    const raw = Buffer.from(e.value as string, 'latin1');
    const off = Buffer.alloc(4);
    if (raw.length <= 4) raw.copy(off);
    else off.writeUInt32LE(spill(raw));
    ifd0Entries.push(entryBuf(e.tag, e.type, raw.length, off));
  }

  const gpsEntries: Buffer[] = [];
  if (opts.gps) {
    const ptr = Buffer.alloc(4);
    ptr.writeUInt32LE(gpsAt);
    ifd0Entries.push(entryBuf(0x8825, 4, 1, ptr));

    const rational = (parts: [number, number, number]) => {
      const b = Buffer.alloc(24);
      parts.forEach((p, i) => {
        b.writeUInt32LE(Math.round(p * 100), i * 8);
        b.writeUInt32LE(100, i * 8 + 4);
      });
      return b;
    };
    const ref = (ch: string) => {
      const b = Buffer.alloc(4);
      b.write(`${ch}\0`, 'latin1');
      return b;
    };
    gpsEntries.push(entryBuf(0x0001, 2, 2, ref('N')));
    const latOff = Buffer.alloc(4);
    latOff.writeUInt32LE(spill(rational(opts.gps.lat)));
    gpsEntries.push(entryBuf(0x0002, 5, 3, latOff));
    gpsEntries.push(entryBuf(0x0003, 2, 2, ref('W')));
    const lonOff = Buffer.alloc(4);
    lonOff.writeUInt32LE(spill(rational(opts.gps.lon)));
    gpsEntries.push(entryBuf(0x0004, 5, 3, lonOff));
  }

  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const tiff = Buffer.concat([
    Buffer.from('II', 'ascii'),
    Buffer.from([0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
    u16(ifd0Entries.length),
    ...ifd0Entries,
    Buffer.alloc(4),
    ...(opts.gps ? [u16(gpsEntries.length), ...gpsEntries, Buffer.alloc(4)] : []),
    ...heap,
  ]);

  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Len = Buffer.alloc(2);
  app1Len.writeUInt16BE(app1Body.length + 2);
  // SOF0 last so readImageMeta still resolves dimensions.
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    app1Len,
    app1Body,
    sof,
    Buffer.alloc(8),
  ]);
}

describe('readImageStaticMeta', () => {
  it('always returns format, byte length, and a content hash', () => {
    const meta = readImageStaticMeta(Buffer.alloc(40));
    expect(meta.format).toBe('unknown');
    expect(meta.byteLength).toBe(40);
    expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects SVG, which has no binary header', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(readImageStaticMeta(svg).format).toBe('svg');
  });

  it('reads PNG tEXt chunks, including generation provenance', () => {
    const buf = png(1024, 1024, [
      tEXt('parameters', 'a wooden figure, masterpiece, Steps: 20'),
      tEXt('Software', 'ComfyUI'),
    ]);
    const meta = readImageStaticMeta(buf);
    expect(meta.pngText?.parameters).toContain('wooden figure');
    expect(meta.pngText?.Software).toBe('ComfyUI');
  });

  it('inflates zTXt chunks', () => {
    const body = Buffer.concat([
      Buffer.from('Comment\0', 'latin1'),
      Buffer.from([0x00]),
      deflateSync(Buffer.from('compressed note', 'latin1')),
    ]);
    const meta = readImageStaticMeta(png(1280, 800, [{ type: 'zTXt', data: body }]));
    expect(meta.pngText?.Comment).toBe('compressed note');
  });

  it('survives a corrupt zlib stream without losing the other chunks', () => {
    const bogus = Buffer.concat([
      Buffer.from('Bad\0', 'latin1'),
      Buffer.from([0x00]),
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    ]);
    const meta = readImageStaticMeta(
      png(1280, 800, [{ type: 'zTXt', data: bogus }, tEXt('Software', 'Shottr')]),
    );
    expect(meta.pngText?.Bad).toBeUndefined();
    expect(meta.pngText?.Software).toBe('Shottr');
  });

  it('reads a JPEG EXIF subset', () => {
    const meta = readImageStaticMeta(
      jpegWithExif({ make: 'Fujifilm', model: 'X100V', software: 'Lightroom' }),
    );
    expect(meta.exif?.make).toBe('Fujifilm');
    expect(meta.exif?.model).toBe('X100V');
    expect(meta.exif?.software).toBe('Lightroom');
  });

  // The privacy invariant. A pasted phone photo carries coordinates, and the
  // digest built from this metadata can be forwarded to a cloud provider.
  it('never surfaces GPS coordinates, only that they were withheld', () => {
    const meta = readImageStaticMeta(
      jpegWithExif({
        make: 'Apple',
        model: 'iPhone 16 Pro',
        gps: { lat: [52, 22, 12], lon: [4, 53, 42] },
      }),
    );
    expect(meta.gpsRedacted).toBe(true);
    expect(meta.gps).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('52.3');
    expect(JSON.stringify(meta.exif)).not.toMatch(/lat|lon|gps/i);
  });

  it('flags a wide PNG with no camera provenance as a likely screenshot', () => {
    expect(readImageStaticMeta(png(2560, 1440)).likelyScreenshot).toBe(true);
  });

  it('trusts a screenshot-tool Software tag over the dimension heuristic', () => {
    // Square, so the aspect check alone would reject it.
    const meta = readImageStaticMeta(png(900, 900, [tEXt('Software', 'CleanShot X')]));
    expect(meta.likelyScreenshot).toBe(true);
  });

  it('does not flag camera photos or portrait scans', () => {
    expect(readImageStaticMeta(jpegWithExif({ make: 'Apple' })).likelyScreenshot).toBeUndefined();
    expect(readImageStaticMeta(png(1200, 1600)).likelyScreenshot).toBeUndefined();
  });
});

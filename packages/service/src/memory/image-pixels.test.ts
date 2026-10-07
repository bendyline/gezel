/**
 * Pure decode/preprocess pipeline for the image embedders. Fixtures are real
 * encoded images produced by the same pure-JS codecs (UPNG.encode /
 * jpeg-js.encode), so the decode path is exercised end-to-end without any
 * binary blobs in the repo.
 */

import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ImageDecodeError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  applyOrientation,
  decodeImage,
  gemmaVisionTargetSize,
  isGemmaVisionSize,
  readBoundedImageFile,
  resizeBicubic,
  resizeBilinear,
  rgbaToRgb,
} from './image-pixels.js';

const cjsRequire = createRequire(import.meta.url);
type UpngModule = typeof import('@pdf-lib/upng');
const UPNG = (() => {
  const mod = cjsRequire('@pdf-lib/upng') as { default?: UpngModule } & UpngModule;
  return mod.default ?? mod;
})();
const jpeg = cjsRequire('jpeg-js') as typeof import('jpeg-js');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function pngOf(rgba: Uint8Array, width: number, height: number): Buffer {
  // cnum 0 = lossless truecolor.
  return Buffer.from(UPNG.encode([rgba.buffer as ArrayBuffer], width, height, 0));
}

function solidRgba(width: number, height: number, [r, g, b, a]: number[]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) out.set([r!, g!, b!, a!], i * 4);
  return out;
}

describe('decodeImage', () => {
  it('round-trips a 4x4 PNG exactly', () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) rgba.set([i * 16, 255 - i * 16, 128, 255], i * 4);
    const decoded = decodeImage(pngOf(rgba, 4, 4));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect([...decoded.data]).toEqual([...rgba]);
  });

  it('decodes a JPEG to approximately the encoded color', () => {
    const encoded = jpeg.encode(
      { data: solidRgba(8, 8, [200, 60, 30, 255]), width: 8, height: 8 },
      95,
    );
    const decoded = decodeImage(Buffer.from(encoded.data));
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    // Lossy — the center pixel lands near the source color.
    const i = (4 * 8 + 4) * 4;
    expect(Math.abs(decoded.data[i]! - 200)).toBeLessThan(16);
    expect(Math.abs(decoded.data[i + 1]! - 60)).toBeLessThan(16);
    expect(Math.abs(decoded.data[i + 2]! - 30)).toBeLessThan(16);
  });

  it('rejects formats without a pure-JS decoder as terminal unsupported', () => {
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'ascii'),
      Buffer.from([16, 0, 16, 0]),
      Buffer.alloc(20),
    ]);
    expect(() => decodeImage(gif)).toThrowError(
      expect.objectContaining({ reason: 'unsupported' }) as Error,
    );
  });

  it('rejects decode-bomb dimensions from the header, before any decoder runs', () => {
    // Valid PNG signature + IHDR declaring 20000x20000 — 400 MP, no IDAT
    // needed because the pixel cap fires on header dims alone.
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(20000, 16);
    header.writeUInt32BE(20000, 20);
    expect(20000 * 20000).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(() => decodeImage(header)).toThrowError(
      expect.objectContaining({ reason: 'too-large' }) as Error,
    );
  });

  it('classifies corrupt bytes of a known format as decode-failed', () => {
    const good = pngOf(solidRgba(4, 4, [10, 20, 30, 255]), 4, 4);
    const corrupt = Buffer.from(good);
    // Wreck the IDAT payload while keeping the header parseable.
    corrupt.fill(0xab, 40, Math.min(corrupt.length - 8, 80));
    let caught: unknown;
    try {
      decodeImage(corrupt);
    } catch (err) {
      caught = err;
    }
    // Some corruption survives inflate into garbage pixels — either outcome
    // is fine, but a thrown error must carry the terminal reason.
    if (caught) expect((caught as ImageDecodeError).reason).toBe('decode-failed');
  });
});

describe('readBoundedImageFile', () => {
  it('reads a normal file through its bounded descriptor path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-image-read-'));
    tempDirs.push(dir);
    const path = join(dir, 'small.png');
    await writeFile(path, Buffer.from('small'));
    await expect(readBoundedImageFile(path)).resolves.toEqual(Buffer.from('small'));
  });

  it('rejects an oversized sparse file before allocating or reading its payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gezel-image-read-'));
    tempDirs.push(dir);
    const path = join(dir, 'oversized.png');
    await writeFile(path, Buffer.alloc(0));
    await truncate(path, MAX_IMAGE_BYTES + 1);
    await expect(readBoundedImageFile(path)).rejects.toMatchObject({ reason: 'too-large' });
  });
});

describe('geometry + normalization', () => {
  it('applies EXIF orientation 6 (90 degrees clockwise)', () => {
    // 2x1 image [A, B] rotated 90 CW becomes 1x2 [A / B] reading top-down.
    const image = {
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
      width: 2,
      height: 1,
    };
    const rotated = applyOrientation(image, 6);
    expect(rotated.width).toBe(1);
    expect(rotated.height).toBe(2);
    expect([...rotated.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...rotated.data.subarray(4, 8)]).toEqual([0, 255, 0, 255]);
  });

  it('orientation 3 is a 180-degree rotation', () => {
    const image = {
      data: new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255]),
      width: 2,
      height: 1,
    };
    const out = applyOrientation(image, 3);
    expect(out.width).toBe(2);
    expect([...out.data.subarray(0, 4)]).toEqual([2, 2, 2, 255]);
  });

  it('composites alpha over white when dropping to RGB', () => {
    const rgb = rgbaToRgb({ data: new Uint8Array([0, 0, 0, 128]), width: 1, height: 1 });
    // 50.2% black over white ≈ 127.
    expect(rgb.data[0]).toBe(127);
    expect(rgb.data[1]).toBe(127);
    expect(rgb.data[2]).toBe(127);
  });

  it('bilinear 2x2 → 1x1 is the average of all four pixels', () => {
    const image = {
      data: new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200, 100, 100, 100]),
      width: 2,
      height: 2,
    };
    const out = resizeBilinear(image, 1, 1);
    expect(out.data[0]).toBe(100); // (0+100+200+100)/4
  });

  it('sizes to whole pooling blocks within the token budget, as the Gemma processor does', () => {
    expect(gemmaVisionTargetSize(640, 427, 280)).toEqual({ width: 960, height: 624 });
    expect(gemmaVisionTargetSize(612, 612, 70)).toEqual({ width: 384, height: 384 });
    for (const [w, h] of [
      [640, 427],
      [100, 166],
      [4000, 300],
      [48, 48],
      [1920, 1080],
    ] as const) {
      for (const budget of [70, 140, 280, 560, 1120]) {
        const size = gemmaVisionTargetSize(w, h, budget);
        expect(isGemmaVisionSize(size.width, size.height, budget), `${w}x${h}@${budget}`).toBe(
          true,
        );
      }
    }
  });

  it('recognises an already-sized frame, because the sizing rule is not idempotent', () => {
    const once = gemmaVisionTargetSize(100, 166, 280);
    expect(once).toEqual({ width: 576, height: 1008 });
    expect(gemmaVisionTargetSize(once.width, once.height, 280)).toEqual({
      width: 576,
      height: 1056,
    });
    expect(isGemmaVisionSize(once.width, once.height, 280)).toBe(true);
    expect(isGemmaVisionSize(577, 1008, 280)).toBe(false);
    expect(isGemmaVisionSize(48 * 30, 48 * 30, 280)).toBe(false);
  });

  it('bicubic resize keeps a flat image flat and returns the requested size', () => {
    const flat = { data: new Uint8Array(9 * 7 * 3).fill(173), width: 9, height: 7 };
    const down = resizeBicubic(flat, 4, 3);
    expect([down.width, down.height]).toEqual([4, 3]);
    expect([...down.data].every((v) => v === 173)).toBe(true);
    const up = resizeBicubic(flat, 20, 15);
    expect([...up.data].every((v) => v === 173)).toBe(true);
  });
});

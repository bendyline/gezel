/** Regression coverage for photographic capture, scan dates and camera settings.
 * Synthetic TIFF values keep the test independent of image libraries and files.
 */
import { describe, expect, it } from 'vitest';
import { readImageStaticMeta } from './image-meta.js';

function photograph(zeroDenominator = false): Buffer {
  const tiff = Buffer.alloc(768);
  tiff.write('II');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  let heap = 256;
  const entry = (at: number, tag: number, type: number, value: string | number[]) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    const data =
      typeof value === 'string' ? Buffer.from(`${value}\0`) : Buffer.alloc(type === 5 ? 8 : 4);
    if (Array.isArray(value)) {
      if (type === 3) data.writeUInt16LE(value[0]!, 0);
      else {
        data.writeUInt32LE(value[0]!, 0);
        if (type === 5) data.writeUInt32LE(value[1]!, 4);
      }
    }
    tiff.writeUInt32LE(type === 2 ? data.length : 1, at + 4);
    if (data.length <= 4) data.copy(tiff, at + 8);
    else {
      tiff.writeUInt32LE(heap, at + 8);
      data.copy(tiff, heap);
      heap += data.length;
    }
  };
  tiff.writeUInt16LE(2, 8);
  entry(10, 0x0132, 2, '2011:05:06 07:08:09');
  entry(22, 0x8769, 4, [64]);
  tiff.writeUInt16LE(6, 64);
  entry(66, 0x9003, 2, '1885:01:01 00:00:00');
  entry(78, 0x9004, 2, '2010:02:03 04:05:06');
  entry(90, 0x829a, 5, [1, zeroDenominator ? 0 : 125]);
  entry(102, 0x829d, 5, [28, 10]);
  entry(114, 0x8827, 3, [400]);
  entry(126, 0x920a, 5, [50, 1]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 4);
  return Buffer.concat([
    header,
    payload,
    Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 0, 0, 0, 0, 0xff, 0xd9]),
  ]);
}

describe('photograph metadata', () => {
  it('keeps original, digitized and modified dates separate with camera settings', () => {
    expect(readImageStaticMeta(photograph()).exif).toMatchObject({
      dateTimeOriginal: '1885:01:01 00:00:00',
      dateTimeDigitized: '2010:02:03 04:05:06',
      dateTimeModified: '2011:05:06 07:08:09',
      exposureTime: 1 / 125,
      fNumber: 2.8,
      iso: 400,
      focalLength: 50,
    });
  });
  it('omits invalid rationals rather than treating them as real camera settings', () => {
    expect(readImageStaticMeta(photograph(true)).exif?.exposureTime).toBeUndefined();
  });
  it('does not read TIFF values across the declared JPEG segment boundary', () => {
    const bytes = photograph();
    bytes.writeUInt16BE(12, 4);
    expect(readImageStaticMeta(bytes).exif).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { readImageMeta } from './image-meta.js';

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

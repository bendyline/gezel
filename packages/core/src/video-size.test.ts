import { describe, expect, it } from 'vitest';
import { VIDEO_ARCHITECTURES } from './video-geometry.js';
import { resolveVideoFrames, resolveVideoSize } from './video-size.js';

const wan5b = VIDEO_ARCHITECTURES['wan2.2-ti2v-5b'];
const wan13 = VIDEO_ARCHITECTURES['wan2.1-1.3b'];
const ltx = VIDEO_ARCHITECTURES['ltx-2'];
const WAN_5B = {
  defaultWidth: 1280,
  defaultHeight: 704,
  widthRange: { min: 512, max: 1280 },
  heightRange: { min: 512, max: 1280 },
};

describe('resolveVideoSize', () => {
  it("renders the model's default when nothing is asked", () => {
    expect(resolveVideoSize({}, WAN_5B, wan5b)).toEqual({ width: 1280, height: 704 });
    expect(resolveVideoSize({}, {}, wan13)).toEqual({ width: 832, height: 480 });
  });

  it("follows a portrait picture's shape at the model's area", () => {
    const size = resolveVideoSize({ sourceSize: { width: 1080, height: 1920 } }, WAN_5B, wan5b);
    expect(size.height).toBeGreaterThan(size.width);
    expect(size.width % 32).toBe(0);
    expect(size.height % 32).toBe(0);
    expect(size.height).toBeLessThanOrEqual(1280);
  });

  it('prefers an asked-for shape over the picture', () => {
    const size = resolveVideoSize(
      { aspectRatio: '1:1', sourceSize: { width: 1920, height: 1080 } },
      { defaultWidth: 832, defaultHeight: 480 },
      wan13,
    );
    expect(size.width).toBe(size.height);
    expect(size.width % 16).toBe(0);
  });

  it('keeps a too-wide shape the same shape inside the range', () => {
    const size = resolveVideoSize({ aspectRatio: '21:9' }, WAN_5B, wan5b);
    expect(size.width).toBe(1280);
    expect(size.height).toBeGreaterThanOrEqual(512);
  });

  it('snaps explicit sides to the token grid', () => {
    expect(resolveVideoSize({ width: 770, height: 500 }, {}, ltx)).toEqual({
      width: 768,
      height: 512,
    });
  });
});

describe('resolveVideoFrames', () => {
  it('lands on the VAE frame grid, rounding down', () => {
    expect(resolveVideoFrames(120, {}, 24, wan5b)).toBe(117);
    expect(resolveVideoFrames(120, {}, 24, ltx)).toBe(113);
    expect(resolveVideoFrames(undefined, { defaultNumFrames: 121 }, 24, wan5b)).toBe(121);
  });

  it("caps a clip at the model's longest and keeps it inside the range", () => {
    expect(resolveVideoFrames(400, { maxDurationSeconds: 5 }, 24, wan5b)).toBe(121);
    expect(resolveVideoFrames(10, { numFramesRange: { min: 25, max: 161 } }, 24, wan5b)).toBe(25);
    expect(resolveVideoFrames(26, { numFramesRange: { min: 26, max: 161 } }, 24, wan5b)).toBe(29);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageMeta } from '@bendyline/gezel-inference/internal/utils/image-meta';
import { describe, expect, it } from 'vitest';
import { webmFirstFrameWebp, webmVideoInfo } from './webm.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '__fixtures__', name));

describe('webmVideoInfo', () => {
  it('reads the video track size and codec, and whether the clip has sound', () => {
    expect(webmVideoInfo(fixture('vp8-64x48.webm'))).toEqual({
      width: 64,
      height: 48,
      codec: 'V_VP8',
      hasAudio: false,
    });
    expect(webmVideoInfo(fixture('vp8-64x48-audio.webm'))?.hasAudio).toBe(true);
  });

  it('gives up on anything that is not WebM', () => {
    expect(webmVideoInfo(Buffer.from('not a video'))).toBeUndefined();
    expect(webmVideoInfo(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('webmFirstFrameWebp', () => {
  it("wraps the first VP8 keyframe as a WebP image of the clip's size", () => {
    const webp = webmFirstFrameWebp(fixture('vp8-64x48-audio.webm'));
    expect(webp?.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(webp?.subarray(8, 16).toString('latin1')).toBe('WEBPVP8 ');
    expect(readImageMeta(webp as Buffer)).toEqual({ format: 'webp', width: 64, height: 48 });
    expect((webp as Buffer).readUInt32LE(4)).toBe((webp as Buffer).length - 8);
  });

  it('returns nothing for a truncated or foreign file', () => {
    const clip = fixture('vp8-64x48.webm');
    expect(webmFirstFrameWebp(clip.subarray(0, 40))).toBeUndefined();
    expect(webmFirstFrameWebp(Buffer.from('RIFF....WEBP'))).toBeUndefined();
  });
});

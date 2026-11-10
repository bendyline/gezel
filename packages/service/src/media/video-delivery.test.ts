import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImageMeta } from '@bendyline/gezel-inference/internal/utils/image-meta';
import { describe, expect, it } from 'vitest';
import { locateFfmpeg } from './ffmpeg.js';
import { deliverVideo } from './video-delivery.js';

const webm = readFileSync(join(import.meta.dirname, '__fixtures__', 'vp8-64x48-audio.webm'));
const hasFfmpeg = (await locateFfmpeg()) !== null;

describe('deliverVideo', () => {
  it('passes an MP4 clip and its PNG poster through', async () => {
    const out = await deliverVideo({
      video: Buffer.from('mp4'),
      mimeType: 'video/mp4',
      poster: Buffer.from('png'),
    });
    expect(out.primary).toMatchObject({ mimeType: 'video/mp4', ext: 'mp4' });
    expect(out.poster).toMatchObject({ mimeType: 'image/png', ext: 'png' });
    expect(out.alternates).toEqual([]);
    expect(out.notes).toEqual([]);
  });

  it('keeps a WebM with its first frame as the poster when there is no ffmpeg', async () => {
    const out = await deliverVideo(
      { video: webm, mimeType: 'video/webm' },
      { ffmpeg: async () => null },
    );
    expect(out.primary).toMatchObject({ mimeType: 'video/webm', ext: 'webm' });
    expect(out.poster?.mimeType).toBe('image/webp');
    expect(readImageMeta(out.poster?.data as Buffer)).toMatchObject({ width: 64, height: 48 });
    expect(out.notes[0]).toMatch(/Install ffmpeg/);
  });

  it('keeps the WebM and says why when the conversion fails', async () => {
    const out = await deliverVideo(
      { video: webm, mimeType: 'video/webm' },
      {
        ffmpeg: async () => (await locateFfmpeg()) ?? { path: 'ffmpeg', version: 'test' },
        run: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(out.primary.ext).toBe('webm');
    expect(out.poster?.mimeType).toBe('image/webp');
    expect(out.notes.join(' ')).toMatch(/boom|H\.264/);
  });

  it.skipIf(!hasFfmpeg)(
    'converts a WebM to MP4 with a PNG poster when ffmpeg is here',
    async () => {
      const out = await deliverVideo({ video: webm, mimeType: 'video/webm' });
      expect(out.primary).toMatchObject({ mimeType: 'video/mp4', ext: 'mp4' });
      expect(out.primary.data.subarray(4, 8).toString('latin1')).toBe('ftyp');
      expect(out.alternates.map((a) => a.ext)).toEqual(['webm']);
      expect(readImageMeta(out.poster?.data as Buffer)).toMatchObject({
        format: 'png',
        width: 64,
        height: 48,
      });
    },
  );
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type MediaWeightFile,
  type SdCppPricedVideoModel,
  sdCppVideoModelRequirement,
} from './media-memory.js';
import type { MediaMemoryPool } from './schemas/media-fit.js';
import type { MediaBackend } from './schemas/video.js';

/**
 * Every clip the video bench measured with GPU-held memory counted, priced
 * by core as the daemon would admit it, from the weight files and model
 * fields the run's engine actually loaded. Written by `fit-media-memory
 * --write-fixture` (evals/src/bin/fit-media-memory.ts); see
 * docs/media-model-memory.md, "Calibration".
 */
interface Fixture {
  clips: Array<{
    model: string;
    backend: MediaBackend;
    pool: MediaMemoryPool;
    size: { width: number; height: number; numFrames: number };
    measuredPeakBytes: number;
    files: MediaWeightFile[];
    priced: SdCppPricedVideoModel;
    /** The clip animated a picture. */
    animatesPicture?: boolean;
  }>;
}

const GiB = 1024 ** 3;

const FIXTURES = ['sd-cpp-metal-m5max.json'];

/** Never under the measured peak, never over the larger of 1.15x it and 1.5 GiB more. */
function outOfBand(measured: number, estimate: number): string | undefined {
  if (estimate < measured) return 'under';
  if (estimate > Math.max(1.15 * measured, measured + 1.5 * GiB)) return 'over';
  return undefined;
}

/**
 * Repeat renders of one clip on one model, from words or from a picture.
 * Their peaks differ by up to 1 GiB (short-lived GPU allocations a poll
 * catches or misses: 8.66 to 9.51 GiB for one Wan2.2 clip), so the band is
 * held against the highest: the peak the clip can reach.
 */
function clipKey(clip: Fixture['clips'][number]): string {
  const { width, height, numFrames } = clip.size;
  const files = clip.files.map((f) => `${f.component}:${f.sizeBytes}`).join(',');
  // The files name the build, whatever id the catalog gave it at the time.
  return [`${width}x${height}x${numFrames}`, clip.animatesPicture === true, files].join('|');
}

describe('video memory against measured peaks', () => {
  for (const name of FIXTURES) {
    it(`prices every clip in ${name} within the acceptance band`, () => {
      const fixture = JSON.parse(
        readFileSync(new URL(`./__fixtures__/media-memory/${name}`, import.meta.url), 'utf8'),
      ) as Fixture;
      const highest = new Map<string, Fixture['clips'][number]>();
      for (const clip of fixture.clips) {
        const prior = highest.get(clipKey(clip));
        if (!prior || clip.measuredPeakBytes > prior.measuredPeakBytes) {
          highest.set(clipKey(clip), clip);
        }
      }
      const misses: string[] = [];
      for (const clip of highest.values()) {
        const req = sdCppVideoModelRequirement({
          files: clip.files,
          model: clip.priced,
          pool: clip.pool,
          backend: clip.backend,
          size: clip.size,
          animatesPicture: clip.animatesPicture === true,
        });
        const miss = outOfBand(clip.measuredPeakBytes, req.bytes);
        if (miss) {
          const { width, height, numFrames } = clip.size;
          misses.push(
            `${clip.model} ${width}x${height}x${numFrames}: ${miss}, measured ${(clip.measuredPeakBytes / GiB).toFixed(2)} GiB, priced ${(req.bytes / GiB).toFixed(2)}`,
          );
        }
      }
      expect(misses).toEqual([]);
    });
  }
});

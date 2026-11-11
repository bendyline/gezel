import { describe, expect, it } from 'vitest';
import { type CalibrationLine, fitGroups, inAcceptanceBand, linearFit } from './fit.ts';

const GIB = 1024 ** 3;

describe('linearFit', () => {
  it('recovers a line', () => {
    const fit = linearFit([1, 2, 3], [5, 7, 9]);
    expect(fit?.slope).toBeCloseTo(2);
    expect(fit?.intercept).toBeCloseTo(3);
    expect(fit?.maxResidual).toBeCloseTo(0);
  });

  it('puts one point on a line through the origin', () => {
    expect(linearFit([4], [8])).toEqual({ slope: 2, intercept: 0, maxResidual: 0 });
  });
});

describe('inAcceptanceBand', () => {
  it('refuses an estimate under the peak, or far over it', () => {
    expect(inAcceptanceBand(10 * GIB, 9 * GIB)).toBe(false);
    expect(inAcceptanceBand(10 * GIB, 11.4 * GIB)).toBe(true);
    expect(inAcceptanceBand(10 * GIB, 11.6 * GIB)).toBe(false);
    expect(inAcceptanceBand(4 * GIB, 5.4 * GIB)).toBe(true);
  });
});

describe('fitGroups', () => {
  const line = (tokens: number, sample: number): CalibrationLine => ({
    engine: 'sd-cpp',
    backend: 'metal',
    architecture: 'wan2.2-ti2v-5b',
    model: 'wan2.2-ti2v-5b-q4',
    size: { width: 640, height: 512, numFrames: 33 },
    latentTokens: tokens,
    hiddenSize: 3072,
    batch: 2,
    weightBytes: 7 * GIB,
    estimateBytes: 9 * GIB,
    measuredPeakBytes: 7 * GIB + sample + 0.5 * GIB,
    engineReported: { paramsBytes: 7 * GIB },
    phases: { encode: 0.3 * GIB, sample, decode: 0.1 * GIB },
  });

  it('fits the sampling slope per token-width and the fixed share', () => {
    const perTokenWidth = 25;
    const [fit] = fitGroups([
      line(2880, 2 * 3072 * 2880 * perTokenWidth),
      line(27280, 2 * 3072 * 27280 * perTokenWidth),
    ]);
    expect(fit?.key).toBe('sd-cpp:metal:wan2.2-ti2v-5b');
    expect(fit?.sample?.bytesPerTokenWidth).toBeCloseTo(perTokenWidth);
    expect(fit?.weightRatio).toBe(1);
    expect(fit?.fixedBytes).toBeCloseTo(0.5 * GIB);
  });
});

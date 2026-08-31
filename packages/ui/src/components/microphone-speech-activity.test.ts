import { describe, expect, it } from 'vitest';
import { rootMeanSquare } from './microphone-speech-activity.js';

describe('rootMeanSquare', () => {
  it('measures silence and microphone energy', () => {
    expect(rootMeanSquare(new Float32Array([0, 0, 0, 0]))).toBe(0);
    expect(rootMeanSquare(new Float32Array([0.25, -0.25, 0.25, -0.25]))).toBeCloseTo(0.25);
  });
});

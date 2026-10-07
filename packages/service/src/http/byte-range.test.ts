import { describe, expect, it } from 'vitest';
import { parseByteRange } from './byte-range.js';

describe('parseByteRange', () => {
  it('reads first-last, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=0-1023', 5000)).toEqual({ start: 0, end: 1023 });
    expect(parseByteRange('bytes=4000-', 5000)).toEqual({ start: 4000, end: 4999 });
    expect(parseByteRange('bytes=-500', 5000)).toEqual({ start: 4500, end: 4999 });
    expect(parseByteRange('bytes=-9000', 5000)).toEqual({ start: 0, end: 4999 });
  });

  it('clamps an end past the file and refuses a start past it', () => {
    expect(parseByteRange('bytes=100-99999', 5000)).toEqual({ start: 100, end: 4999 });
    expect(parseByteRange('bytes=5000-', 5000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 5000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('serves the whole body for absent, malformed or multi-range requests', () => {
    expect(parseByteRange(undefined, 5000)).toBeNull();
    expect(parseByteRange('items=0-10', 5000)).toBeNull();
    expect(parseByteRange('bytes=0-10,20-30', 5000)).toBeNull();
    expect(parseByteRange('bytes=-', 5000)).toBeNull();
    expect(parseByteRange('bytes=30-10', 5000)).toBeNull();
  });
});

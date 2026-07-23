import { describe, expect, it } from 'vitest';
import { OutputRingBuffer } from './ring.js';

describe('OutputRingBuffer', () => {
  it('holds content below the cap verbatim', () => {
    const ring = new OutputRingBuffer(100);
    ring.append('hello');
    ring.append(' world');
    const { text, truncated } = ring.value();
    expect(text).toBe('hello world');
    expect(truncated).toBe(false);
  });

  it('slides the window when the cap is exceeded', () => {
    const ring = new OutputRingBuffer(10);
    ring.append('1234567890'); // exactly at cap
    ring.append('abcdef'); // pushes 1-6 off the start
    const { text, truncated } = ring.value();
    expect(text).toBe('7890abcdef');
    expect(truncated).toBe(true);
  });

  it('handles a single append larger than the cap', () => {
    const ring = new OutputRingBuffer(5);
    ring.append('abcdefghij');
    expect(ring.value()).toEqual({ text: 'fghij', truncated: true });
  });
});

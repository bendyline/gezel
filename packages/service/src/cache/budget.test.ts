import { describe, expect, it } from 'vitest';
import { defaultCacheBudgetMb } from './budget.js';

const GB = 1024 * 1024 * 1024;

describe('defaultCacheBudgetMb', () => {
  it('returns 2 GB for systems under 16 GB (fits one warm session)', () => {
    expect(defaultCacheBudgetMb(8 * GB)).toBe(2048);
    expect(defaultCacheBudgetMb(15 * GB)).toBe(2048);
    expect(defaultCacheBudgetMb(15 * GB + (GB - 1))).toBe(2048);
  });

  it('returns 4 GB for 16–32 GB (fits two warm sessions)', () => {
    expect(defaultCacheBudgetMb(16 * GB)).toBe(4096);
    expect(defaultCacheBudgetMb(24 * GB)).toBe(4096);
    expect(defaultCacheBudgetMb(31 * GB)).toBe(4096);
  });

  it('returns 8 GB for 32–64 GB (Apple Silicon Pro/Max)', () => {
    expect(defaultCacheBudgetMb(32 * GB)).toBe(8192);
    expect(defaultCacheBudgetMb(48 * GB)).toBe(8192);
    expect(defaultCacheBudgetMb(63 * GB)).toBe(8192);
  });

  it('returns 16 GB for 64+ GB (Studio/Ultra class)', () => {
    expect(defaultCacheBudgetMb(64 * GB)).toBe(16384);
    expect(defaultCacheBudgetMb(128 * GB)).toBe(16384);
    expect(defaultCacheBudgetMb(192 * GB)).toBe(16384);
  });

  it('handles boundary cases without surprise (lands in the higher tier at the threshold)', () => {
    expect(defaultCacheBudgetMb(16 * GB)).toBe(4096);
    expect(defaultCacheBudgetMb(32 * GB)).toBe(8192);
    expect(defaultCacheBudgetMb(64 * GB)).toBe(16384);
  });
});

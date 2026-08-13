import { describe, expect, it } from 'vitest';
import { summarizeCacheEntries } from './cacheDisplay.js';

describe('summarizeCacheEntries', () => {
  it('distinguishes chat caches from shared prefix caches', () => {
    expect(
      summarizeCacheEntries([
        { sessionId: 'session-a' },
        { sessionId: 'prefix-model-a' },
        { sessionId: 'session-b' },
        { sessionId: 'prefix-gezel-a' },
      ]),
    ).toEqual({
      chatCount: 2,
      prefixCount: 2,
      totalCount: 4,
      label: '2 chat caches + 2 shared prefixes',
    });
  });

  it('uses clear singular labels', () => {
    expect(summarizeCacheEntries([{ sessionId: 'session-a' }]).label).toBe('1 chat cache');
    expect(summarizeCacheEntries([{ sessionId: 'prefix-model-a' }]).label).toBe('1 shared prefix');
  });

  it('falls back to neutral wording for older responses without entry identities', () => {
    expect(summarizeCacheEntries(undefined, 4).label).toBe('4 cache entries');
  });
});

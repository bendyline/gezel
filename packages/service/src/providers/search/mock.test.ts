import { describe, expect, it } from 'vitest';
import { MockSearchProvider } from './mock.js';

describe('MockSearchProvider', () => {
  it('returns deterministic seed entries', async () => {
    const p = new MockSearchProvider();
    const out = await p.search({ query: 'hello', limit: 5 }, new AbortController().signal);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      title: 'Mock result 1 for "hello"',
      url: 'https://example.com/a',
      domain: 'example.com',
      source: 'mock',
    });
    expect(out[2]?.url).toBe('https://example.net/c');
  });

  it('honors limit smaller than seed length', async () => {
    const p = new MockSearchProvider();
    const out = await p.search({ query: 'q', limit: 2 }, new AbortController().signal);
    expect(out).toHaveLength(2);
  });

  it('returns [] when limit is 0', async () => {
    const p = new MockSearchProvider();
    const out = await p.search({ query: 'q', limit: 0 }, new AbortController().signal);
    expect(out).toEqual([]);
  });
});

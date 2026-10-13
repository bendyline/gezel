import { describe, expect, it, vi } from 'vitest';
import { ListingCache } from './listing-cache.js';

describe('catalog listing snapshots', () => {
  it('coalesces resolution and returns independent results', async () => {
    const cache = new ListingCache<{ name: string }[]>();
    const resolve = vi.fn(async () => ({ items: [{ name: 'Original' }], cacheable: true }));
    const [a, b] = await Promise.all([
      cache.read('toolset', '/a', 'index', resolve),
      cache.read('toolset', '/a', 'index', resolve),
    ]);
    a[0]!.name = 'Changed';
    expect(b).toEqual([{ name: 'Original' }]);
    expect(await cache.read('toolset', '/a', 'index', resolve)).toEqual(b);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('invalidates on index edits and live content-root changes', async () => {
    const cache = new ListingCache<number>();
    const resolve = vi.fn(async () => ({ items: 1, cacheable: true }));
    await cache.read('toolset', '/a', 'first', resolve);
    await cache.read('toolset', '/a', 'second', resolve);
    await cache.read('toolset', '/b', 'second', resolve);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('re-reads entries dependent on loose files outside the snapshot', async () => {
    const cache = new ListingCache<number>();
    let value = 1;
    const resolve = async () => ({ items: value, cacheable: false });
    expect(await cache.read('toolset', '/a', 'index', resolve)).toBe(1);
    value = 2;
    expect(await cache.read('toolset', '/a', 'index', resolve)).toBe(2);
  });

  it('does not poison later requests after a failed resolution', async () => {
    const cache = new ListingCache<number>();
    await expect(
      cache.read('toolset', '/a', 'index', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(
      await cache.read('toolset', '/a', 'index', async () => ({ items: 2, cacheable: true })),
    ).toBe(2);
  });
});

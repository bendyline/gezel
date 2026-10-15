import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSnapshotCache } from './file-snapshot-cache.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-file-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('disposable file snapshots', () => {
  it('shares unchanged reads but sees same-size external edits, deletion and recreation', async () => {
    const path = join(dir, 'data');
    await writeFile(path, 'before');
    const load = vi.fn(() => readFile(path, 'utf8'));
    const cache = new FileSnapshotCache<string>();
    expect(await Promise.all([cache.read(path, load), cache.read(path, load)])).toEqual([
      'before',
      'before',
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    const original = await stat(path);
    await writeFile(path, 'after!');
    await utimes(path, original.atime, original.mtime);
    expect(await cache.read(path, load)).toBe('after!');
    await rm(path);
    expect(await cache.read(path, load)).toBeNull();
    await writeFile(path, 'return');
    expect(await cache.read(path, load)).toBe('return');
  });

  it('evicts to a byte budget and retries rejected or invalid reads', async () => {
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    await Promise.all([writeFile(one, '1234'), writeFile(two, '1234')]);
    const cache = new FileSnapshotCache<string>(4);
    const load = vi.fn(async () => 'valid');
    await cache.read(one, load);
    await cache.read(two, load);
    await cache.read(one, load);
    expect(load).toHaveBeenCalledTimes(3);
    cache.invalidate(one);
    await expect(
      cache.read(one, async () => {
        throw new Error('corrupt');
      }),
    ).rejects.toThrow('corrupt');
    expect(await cache.read(one, async () => null)).toBeNull();
    expect(await cache.read(one, load)).toBe('valid');
  });
});

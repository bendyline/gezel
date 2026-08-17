import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SizeCache, measureTree } from './sizes.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('measureTree', () => {
  it('counts regular files while skipping symlinks and excluded subtrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-size-'));
    roots.push(root);
    const included = join(root, 'included');
    const excluded = join(root, 'excluded');
    await mkdir(included);
    await mkdir(excluded);
    await writeFile(join(root, 'top.txt'), 'top');
    await writeFile(join(included, 'nested.txt'), 'nested');
    await writeFile(join(excluded, 'hidden.txt'), 'hidden');
    await symlink(join(root, 'top.txt'), join(root, 'link.txt'));

    await expect(measureTree(root, [excluded])).resolves.toEqual({
      bytes: Buffer.byteLength('topnested'),
      fileCount: 2,
    });
  });
});

describe('SizeCache', () => {
  it('coalesces callers onto one in-flight measurement, including refreshes', async () => {
    const cache = new SizeCache();
    let release!: (value: number) => void;
    const compute = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const first = cache.get(compute);
    const second = cache.get(compute, true);
    release(42);

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not cache a measurement invalidated while it is running', async () => {
    const cache = new SizeCache();
    let release!: (value: number) => void;
    const slow = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    const stale = cache.get(slow);
    cache.clear();
    release(1);
    await expect(stale).resolves.toBe(1);

    const fresh = vi.fn().mockResolvedValue(2);
    await expect(cache.get(fresh)).resolves.toBe(2);
    expect(fresh).toHaveBeenCalledOnce();
  });
});

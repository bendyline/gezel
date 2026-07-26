import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDiskSpace, describeDiskShortfall, requiredSlackBytes } from './disk-space.js';

const GIB = 1024 ** 3;

describe('requiredSlackBytes', () => {
  it('floors at 2 GiB for small downloads', () => {
    expect(requiredSlackBytes(100 * 1024 ** 2)).toBe(2 * GIB);
  });

  it('scales with the download for very large models', () => {
    // A 200 GiB ds4 GGUF reserves 4 GiB, not the 2 GiB floor.
    expect(requiredSlackBytes(200 * GIB)).toBe(4 * GIB);
  });
});

describe('checkDiskSpace', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-disk-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('measures a real directory and passes a trivially small request', async () => {
    const check = await checkDiskSpace(dir, 1024);
    expect(check.known).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.freeBytes).toBeGreaterThan(0);
    expect(check.requiredBytes).toBe(1024 + 2 * GIB);
  });

  it('refuses a download that cannot fit', async () => {
    const check = await checkDiskSpace(dir, 8 * 1024 ** 5); // 8 PiB
    expect(check.known).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('measures the nearest existing ancestor when the target does not exist yet', async () => {
    const check = await checkDiskSpace(join(dir, 'not', 'created', 'yet'), 1024);
    expect(check.known).toBe(true);
    expect(check.ok).toBe(true);
  });

  it('never blocks when the filesystem cannot be measured', async () => {
    // Network mounts and some container overlays don't answer statfs. The
    // contract is that an unknown disk reads as fine, never as full.
    const check = await checkDiskSpace(dir, 8 * 1024 ** 5, () => {
      throw new Error('ENOTSUP');
    });
    expect(check.known).toBe(false);
    expect(check.ok).toBe(true);
  });

  it('walks up past unmeasurable children to the first ancestor that answers', async () => {
    const seen: string[] = [];
    const check = await checkDiskSpace(join(dir, 'a', 'b'), 1024, async (p) => {
      seen.push(p);
      if (p !== dir) throw new Error('ENOENT');
      return { bsize: 4096, bavail: 1_000_000 };
    });
    expect(seen).toEqual([join(dir, 'a', 'b'), join(dir, 'a'), dir]);
    expect(check.known).toBe(true);
    expect(check.freeBytes).toBe(4096 * 1_000_000);
  });
});

describe('describeDiskShortfall', () => {
  it('names the model and reports both numbers in GiB', () => {
    const msg = describeDiskShortfall(
      { known: true, ok: false, freeBytes: 40 * GIB, requiredBytes: 200 * GIB },
      'GLM 5.2 (IQ2_XXS)',
    );
    expect(msg).toContain('GLM 5.2 (IQ2_XXS)');
    expect(msg).toContain('200.0 GiB');
    expect(msg).toContain('40.0 GiB');
  });
});

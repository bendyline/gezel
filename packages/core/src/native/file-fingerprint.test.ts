import { mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileFingerprint, sameFileFingerprint } from './file-fingerprint.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-fingerprint-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// File times come from the clock tick, which is ~16 ms on a default Windows
// timer; waiting past it makes "the write moved the time" a fact, not a race.
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('fileFingerprint', () => {
  it('is stable while the file is only read', async () => {
    const path = join(dir, 'engine.exe');
    await writeFile(path, 'engine bytes');
    const first = await fileFingerprint(path);
    await nextTick();
    expect(first).not.toBeNull();
    expect(sameFileFingerprint(first, (await fileFingerprint(path))!)).toBe(true);
    // A round trip through JSON is how stamps store it.
    expect(
      sameFileFingerprint(JSON.parse(JSON.stringify(first)), (await fileFingerprint(path))!),
    ).toBe(true);
  });

  it('moves on a same-size edit even when the modification time is put back', async () => {
    const path = join(dir, 'engine.exe');
    await writeFile(path, 'engine bytes');
    // Whole seconds, so putting the time back is exact rather than rounded.
    const wholeSecond = 1_700_000_000;
    await utimes(path, wholeSecond, wholeSecond);
    const before = (await fileFingerprint(path))!;
    await nextTick();
    await writeFile(path, 'EVIL!! bytes');
    await utimes(path, wholeSecond, wholeSecond);

    const after = (await fileFingerprint(path))!;
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(sameFileFingerprint(before, after)).toBe(false);
  });

  it('moves when the file is replaced by another', async () => {
    const path = join(dir, 'engine.exe');
    await writeFile(path, 'engine bytes');
    const before = (await fileFingerprint(path))!;
    const replacement = join(dir, 'replacement.exe');
    await writeFile(replacement, 'engine bytes');
    await rename(replacement, path);
    expect(sameFileFingerprint(before, (await fileFingerprint(path))!)).toBe(false);
  });

  it('has no fingerprint for a missing file, a directory, or a link', async () => {
    expect(await fileFingerprint(join(dir, 'missing'))).toBeNull();
    await mkdir(join(dir, 'sub'));
    expect(await fileFingerprint(join(dir, 'sub'))).toBeNull();
    if (process.platform !== 'win32') {
      await writeFile(join(dir, 'target'), 'x');
      await symlink(join(dir, 'target'), join(dir, 'link'));
      expect(await fileFingerprint(join(dir, 'link'))).toBeNull();
    }
  });

  it('never matches a malformed stored record', async () => {
    const path = join(dir, 'engine.exe');
    await writeFile(path, 'engine bytes');
    const current = (await fileFingerprint(path))!;
    expect(sameFileFingerprint(null, current)).toBe(false);
    expect(sameFileFingerprint('fingerprint', current)).toBe(false);
    expect(sameFileFingerprint({ ...current, ctimeNs: undefined }, current)).toBe(false);
    expect(sameFileFingerprint({ ...current, size: Number(current.size) }, current)).toBe(false);
  });
});

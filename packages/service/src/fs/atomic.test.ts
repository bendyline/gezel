import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileAtomic, writeFileAtomic } from './atomic.js';

describe('atomic file publishing', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function expectNoStagingFiles(): Promise<void> {
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  }

  it('replaces a text file without leaving its staging file behind', async () => {
    const target = join(dir, 'state.json');
    await writeFile(target, 'old');

    await writeFileAtomic(target, 'new');

    await expect(readFile(target, 'utf8')).resolves.toBe('new');
    await expectNoStagingFiles();
  });

  it('preserves binary bytes', async () => {
    const target = join(dir, 'asset.bin');
    const bytes = Uint8Array.from([0, 255, 1, 128, 42]);

    await writeFileAtomic(target, bytes);

    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    await expectNoStagingFiles();
  });

  it('publishes create-only backups without replacing an existing original', async () => {
    const target = join(dir, 'original.docx');
    const original = Uint8Array.from([1, 2, 3]);
    await writeFileAtomic(target, original, { noReplace: true });

    await expect(
      writeFileAtomic(target, Uint8Array.from([9, 9, 9]), { noReplace: true }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(new Uint8Array(await readFile(target))).toEqual(original);
    await expectNoStagingFiles();
  });

  it('publishes create-only backups without replacing an existing original', async () => {
    const target = join(dir, 'original.docx');
    const original = Uint8Array.from([1, 2, 3]);
    await writeFileAtomic(target, original, { noReplace: true });

    await expect(
      writeFileAtomic(target, Uint8Array.from([9, 9, 9]), { noReplace: true }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(new Uint8Array(await readFile(target))).toEqual(original);
    await expectNoStagingFiles();
  });

  it('uses collision-free staging paths for concurrent writers', async () => {
    const target = join(dir, 'session.json');
    const payloads = Array.from({ length: 12 }, (_, index) => `payload-${index}`);

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    expect(payloads).toContain(await readFile(target, 'utf8'));
    await expectNoStagingFiles();
  });

  it('copies a staged file over an existing target without changing the source', async () => {
    const source = join(dir, 'download.part');
    const target = join(dir, 'release.bin');
    const bytes = Uint8Array.from([3, 1, 4, 1, 5, 9]);
    await writeFile(source, bytes);
    await writeFile(target, 'old');

    await copyFileAtomic(source, target);

    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    expect(new Uint8Array(await readFile(source))).toEqual(bytes);
    await expectNoStagingFiles();
  });

  it('preserves the prior target and cleans up when a copy cannot be staged', async () => {
    const target = join(dir, 'release.bin');
    await writeFile(target, 'known-good');

    await expect(copyFileAtomic(join(dir, 'missing.part'), target)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(readFile(target, 'utf8')).resolves.toBe('known-good');
    await expectNoStagingFiles();
  });

  it.skipIf(process.platform === 'win32')(
    'publishes durable secret files with the requested mode',
    async () => {
      const target = join(dir, 'secret.json');

      await writeFileAtomic(target, '{}\n', { mode: 0o600, durable: true });

      expect((await stat(target)).mode & 0o777).toBe(0o600);
      await expectNoStagingFiles();
    },
  );
});

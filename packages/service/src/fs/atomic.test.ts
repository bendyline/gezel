import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  it('uses collision-free staging paths for concurrent writers', async () => {
    const target = join(dir, 'session.json');
    const payloads = Array.from({ length: 12 }, (_, index) => `payload-${index}`);

    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));

    expect(payloads).toContain(await readFile(target, 'utf8'));
    await expectNoStagingFiles();
  });

  it('publishes exactly one complete file when create-only writers race', async () => {
    const target = join(dir, 'original.docx');
    const payloads = Array.from({ length: 8 }, (_, index) => Buffer.alloc(4096, index));
    const outcomes = await Promise.allSettled(
      payloads.map((bytes) => writeFileAtomic(target, bytes, { noReplace: true })),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: 'EEXIST' });
    }
    expect(await readFile(target)).toEqual(
      payloads[outcomes.findIndex((outcome) => outcome.status === 'fulfilled')],
    );
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

  describe.skipIf(process.platform === 'win32')('POSIX permissions', () => {
    it.each([0o755, 0o600, 0o751, 0o640])(
      'preserves mode %i when replacing text and bytes',
      async (mode) => {
        const target = join(dir, 'user-file');
        await writeFile(target, 'old');
        await chmod(target, mode);
        await writeFileAtomic(target, 'new text');
        expect((await stat(target)).mode & 0o777).toBe(mode);
        await writeFileAtomic(target, Uint8Array.from([0, 1, 2]));
        expect((await stat(target)).mode & 0o777).toBe(mode);
        await expectNoStagingFiles();
      },
    );

    it('preserves permissions even when the current umask is more restrictive', async () => {
      const target = join(dir, 'run.sh');
      await writeFile(target, 'old');
      await chmod(target, 0o755);
      const previous = process.umask(0o077);
      try {
        await writeFileAtomic(target, 'new');
      } finally {
        process.umask(previous);
      }
      expect((await stat(target)).mode & 0o777).toBe(0o755);
    });

    it('honors an explicit mode over existing permissions', async () => {
      const target = join(dir, 'private.json');
      await writeFile(target, 'old');
      await chmod(target, 0o755);
      await writeFileAtomic(target, 'secret', { mode: 0o600 });
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    });

    it('uses the umask for new files and does not borrow a symlink target mode', async () => {
      const source = join(dir, 'executable');
      const target = join(dir, 'linked');
      await writeFile(source, 'original');
      await chmod(source, 0o755);
      await symlink(source, target);
      const previous = process.umask(0o027);
      try {
        await writeFileAtomic(target, 'replacement');
        await writeFileAtomic(join(dir, 'new'), 'new');
      } finally {
        process.umask(previous);
      }
      expect((await stat(target)).mode & 0o777).toBe(0o640);
      expect((await stat(join(dir, 'new'))).mode & 0o777).toBe(0o640);
      expect(await readFile(source, 'utf8')).toBe('original');
    });
  });
});

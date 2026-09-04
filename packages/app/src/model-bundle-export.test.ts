import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishExportedBundle, verifyUnlessSkipped } from './model-bundle-export.js';

const verifyModelBundleArchive = vi.hoisted(() => vi.fn());
vi.mock('@bendyline/gezel-client/node', () => ({ verifyModelBundleArchive }));

describe('skippable export verification', () => {
  beforeEach(() => {
    verifyModelBundleArchive.mockReset();
  });

  it('reports a completed read-back as verified', async () => {
    verifyModelBundleArchive.mockResolvedValue(undefined);
    const active = { verifyController: new AbortController(), verificationSkipped: false };
    await expect(
      verifyUnlessSkipped({
        path: '/tmp/model.partial',
        active,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).resolves.toBe(true);
  });

  it('keeps the export when the user skips the read-back', async () => {
    const active = { verifyController: new AbortController(), verificationSkipped: false };
    verifyModelBundleArchive.mockImplementation((_path, _onProgress, signal: AbortSignal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const pending = verifyUnlessSkipped({
      path: '/tmp/model.partial',
      active,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    active.verificationSkipped = true;
    active.verifyController.abort();
    await expect(pending).resolves.toBe(false);
  });

  it('still fails a cancelled export and a genuine checksum mismatch', async () => {
    const canceled = new AbortController();
    const active = { verifyController: new AbortController(), verificationSkipped: true };
    verifyModelBundleArchive.mockRejectedValue(new Error('aborted'));
    canceled.abort();
    await expect(
      verifyUnlessSkipped({
        path: '/tmp/model.partial',
        active,
        signal: canceled.signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow('aborted');

    verifyModelBundleArchive.mockRejectedValue(new Error('export checksum verification failed'));
    await expect(
      verifyUnlessSkipped({
        path: '/tmp/model.partial',
        active: { verifyController: new AbortController(), verificationSkipped: false },
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow('checksum verification failed');
  });
});

describe('publishing an exported bundle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-export-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('moves the partial onto its final path', async () => {
    const from = join(dir, 'model.partial');
    const to = join(dir, 'model.gezmodel');
    await writeFile(from, 'bundle');
    await publishExportedBundle(from, to);
    expect(await readFile(to, 'utf8')).toBe('bundle');
  });

  it('retries while a reader still holds the file, then gives up', async () => {
    const held = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const move = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(held)
      .mockRejectedValueOnce(held)
      .mockResolvedValueOnce(undefined);
    await publishExportedBundle('a', 'b', { rename: move, delay: async () => {} });
    expect(move).toHaveBeenCalledTimes(3);

    const alwaysHeld = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(held);
    await expect(
      publishExportedBundle('a', 'b', { rename: alwaysHeld, delay: async () => {} }),
    ).rejects.toThrow('EPERM');
    expect(alwaysHeld).toHaveBeenCalledTimes(11);
  });

  it('surfaces an unrelated rename failure immediately', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const move = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(missing);
    await expect(
      publishExportedBundle('a', 'b', { rename: move, delay: async () => {} }),
    ).rejects.toThrow('ENOENT');
    expect(move).toHaveBeenCalledOnce();
  });
});

import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitInstalled, runGit } from '../git/git.js';
import { discoverWorkspaceFiles, looksCloudOnly } from './file-walk.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-walk-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedPicturesFolder(): Promise<void> {
  await mkdir(join(dir, 'Photos Library.photoslibrary', 'originals', '0'), { recursive: true });
  await writeFile(join(dir, 'Photos Library.photoslibrary', 'originals', '0', 'IMG_1.heic'), 'x');
  await mkdir(join(dir, 'Old.photolibrary', 'Masters'), { recursive: true });
  await writeFile(join(dir, 'Old.photolibrary', 'Masters', 'IMG_2.jpg'), 'x');
  await mkdir(join(dir, 'Trips'), { recursive: true });
  await writeFile(join(dir, 'Trips', 'beach.jpg'), 'x');
}

describe('discoverWorkspaceFiles', () => {
  it("skips a photo app's library package in a plain folder", async () => {
    await seedPicturesFolder();
    const { files } = await discoverWorkspaceFiles(dir, { maxFiles: 100 });
    expect(files.map((f) => f.path)).toEqual(['Trips/beach.jpg']);
  });

  it('skips the library package in a git listing too', async () => {
    if (!(await isGitInstalled())) return;
    await seedPicturesFolder();
    await runGit(['init', '-q'], { cwd: dir });
    const { files } = await discoverWorkspaceFiles(dir, { maxFiles: 100 });
    expect(files.map((f) => f.path)).toEqual(['Trips/beach.jpg']);
  });

  it('flags a file whose bytes are not on disk', async () => {
    await writeFile(join(dir, 'local.jpg'), Buffer.alloc(64 * 1024, 1));
    // A sparse file allocates no blocks, which is what a cloud placeholder reports.
    await writeFile(join(dir, 'in-icloud.jpg'), '');
    await truncate(join(dir, 'in-icloud.jpg'), 64 * 1024);

    const { files } = await discoverWorkspaceFiles(dir, { maxFiles: 100 });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.cloudOnly ?? false]));
    expect(byPath).toEqual({ 'local.jpg': false, 'in-icloud.jpg': true });
  });
});

describe('looksCloudOnly', () => {
  it('needs a real size with nothing allocated', () => {
    expect(looksCloudOnly({ size: 2_000_000, blocks: 0 })).toBe(true);
    expect(looksCloudOnly({ size: 2_000_000, blocks: 3912 })).toBe(false);
    // Tiny files can be stored inline with no blocks of their own.
    expect(looksCloudOnly({ size: 900, blocks: 0 })).toBe(false);
    expect(looksCloudOnly({ size: 0, blocks: 0 })).toBe(false);
    // A platform that reports no block count never claims a placeholder.
    expect(looksCloudOnly({ size: 2_000_000 })).toBe(false);
  });
});

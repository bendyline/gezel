import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { censusFolder, findCodeFolders } from './folder-census.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-census-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('censusFolder', () => {
  it('counts photos, videos, documents and cloud-only files without reading them', async () => {
    await mkdir(join(dir, '2026', 'June'), { recursive: true });
    await writeFile(join(dir, '2026', 'June', 'a.jpg'), 'x');
    await writeFile(join(dir, '2026', 'June', 'b.png'), 'x');
    await writeFile(join(dir, '2026', 'clip.mov'), 'x');
    await writeFile(join(dir, 'notes.docx'), 'x');
    await writeFile(join(dir, 'in-icloud.jpg'), '');
    await truncate(join(dir, 'in-icloud.jpg'), 64 * 1024);
    await mkdir(join(dir, 'Photos Library.photoslibrary'), { recursive: true });
    await writeFile(join(dir, 'Photos Library.photoslibrary', 'db.jpg'), 'x');
    await writeFile(join(dir, '.DS_Store'), 'x');

    const census = await censusFolder(dir);

    expect(census).toMatchObject({
      files: 5,
      images: 3,
      videos: 1,
      documents: 1,
      cloudOnly: 1,
      complete: true,
    });
    expect(census.newestMtime).toMatch(/^\d{4}-/);
  });

  it('says when it stopped at its budget', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `p${i}.png`), 'x');
    const census = await censusFolder(join(dir), { maxFiles: 2 });
    expect(census.complete).toBe(false);
  });
});

describe('findCodeFolders', () => {
  it('finds checkouts up to two levels under the usual code folders', async () => {
    await mkdir(join(dir, 'code', 'app', '.git'), { recursive: true });
    await mkdir(join(dir, 'gh', 'org', 'lib', '.git'), { recursive: true });
    await mkdir(join(dir, 'gh', 'org', 'notes'), { recursive: true });
    await mkdir(join(dir, 'Documents', 'site', '.git'), { recursive: true });

    const found = await findCodeFolders(dir);

    expect(found.sort()).toEqual([join(dir, 'code', 'app'), join(dir, 'gh', 'org', 'lib')]);
  });
});

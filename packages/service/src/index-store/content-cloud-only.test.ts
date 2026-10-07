import { mkdir, mkdtemp, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectContentIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { CLOUD_ONLY_META_KEY, runWorkspaceContentIndex } from './content-indexer.js';
import { IndexStore } from './index-store.js';

// Minimal valid PNG header declaring 800x600, padded past the placeholder floor.
const PNG = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(16 * 1024),
]);

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;
const dbPath = () => projectContentIndexDbFile(home, 'c', dir);
const index = () => runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: dbPath() });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-cloud-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-cloud-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function fileRow(path: string) {
  const store = (await IndexStore.open(dbPath(), {
    collectionId: 'c',
    kind: 'workspace',
    rootPath: dir,
  }))!;
  try {
    return { file: store.getFile(path), meta: store.getMetadata(path) };
  } finally {
    store.close();
  }
}

/** A sparse file: full size, nothing allocated, as a cloud placeholder reports. */
async function placeholder(path: string, size: number): Promise<void> {
  await writeFile(path, '');
  await truncate(path, size);
}

describe('cloud-only files', () => {
  it('are listed by name, size and date and never read by any tier', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    await writeFile(join(dir, 'photos', 'local.png'), PNG);
    await placeholder(join(dir, 'photos', 'in-icloud.png'), PNG.length);

    await index();
    const { file, meta } = await fileRow('photos/in-icloud.png');
    expect(file).toMatchObject({ hash: null, size: PNG.length, modality: 'image' });
    expect(meta[CLOUD_ONLY_META_KEY]).toBe('1');

    const describeImage = vi.fn(async (_abs: string) => ({ body: 'a photo' }));
    await ci.aiShadows('c', { describeImage }, 10);
    expect(describeImage.mock.calls.map(([abs]) => abs)).toEqual([
      join(dir, 'photos', 'local.png'),
    ]);
  });

  it('are read once they are back on disk, even with the same size and date', async () => {
    const path = join(dir, 'scan.png');
    await placeholder(path, PNG.length);
    const { mtime } = await stat(path);
    await index();
    expect((await fileRow('scan.png')).file?.hash).toBeNull();

    // Downloading keeps the size and modification date the placeholder had.
    await writeFile(path, PNG);
    await utimes(path, mtime, mtime);
    await index();

    const { file, meta } = await fileRow('scan.png');
    expect(file?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta[CLOUD_ONLY_META_KEY]).toBeUndefined();
    expect(meta.width).toBe('800');
  });

  it('drops the hash of a file evicted after it was indexed, so no tier reads it', async () => {
    const path = join(dir, 'old.png');
    await writeFile(path, PNG);
    await index();
    expect((await fileRow('old.png')).file?.hash).not.toBeNull();

    const { mtime } = await stat(path);
    await placeholder(path, PNG.length);
    await utimes(path, mtime, mtime);
    await index();

    const { file, meta } = await fileRow('old.png');
    expect(file?.hash).toBeNull();
    expect(meta[CLOUD_ONLY_META_KEY]).toBe('1');
    // What the earlier pass learned stays.
    expect(meta.width).toBe('800');
  });
});

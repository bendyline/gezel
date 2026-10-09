/**
 * Phase 5 image modality — deterministic tier: dimension extraction, filename
 * search, and folder description. (Captions and media-search similarity need a
 * vision model and are covered by the graceful-degradation path.)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectContentIndexDbFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import { IndexStore } from './index-store.js';

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;
const indexDb = () => projectContentIndexDbFile(home, 'c', dir);

// Minimal valid PNG header declaring 800x600.
const PNG_800x600 = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-img-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-img-home-'));
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

describe('image-intel', () => {
  it('indexes images with dimensions and searches them by filename', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    await writeFile(join(dir, 'photos', 'cat-sunset.png'), PNG_800x600);
    await writeFile(join(dir, 'photos', 'dog.png'), PNG_800x600);
    await writeFile(join(dir, 'notes.txt'), 'not an image');

    const stats = await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: indexDb() });
    expect(stats).not.toBeNull();

    const search = await ci.searchImages('c', 'sunset');
    expect(search.engine).toBe('fts');
    expect(search.results[0]).toMatchObject({
      path: 'photos/cat-sunset.png',
      width: 800,
      height: 600,
      format: 'png',
    });
  });

  it('lists a clip once, at its matching moment, when its name matches too', async () => {
    await mkdir(join(dir, 'clips'), { recursive: true });
    await writeFile(join(dir, 'clips', 'sea-turtle.mp4'), Buffer.alloc(64, 1));
    await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: indexDb() });
    const store = (await IndexStore.open(indexDb(), {
      collectionId: 'c',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    const hash = store.getFile('clips/sea-turtle.mp4')?.hash;
    expect(hash).toBeTruthy();
    const unit = (hot: number) => Array.from({ length: 512 }, (_, i) => (i === hot ? 1 : 0));
    store.putMediaVectors(hash as string, 'clips/sea-turtle.mp4', 'video', [
      { startMs: 0, endMs: 30_000, vec: Float32Array.from(unit(1)) },
      { startMs: 30_000, endMs: 60_000, vec: Float32Array.from(unit(2)) },
    ]);
    store.close();

    const prior = process.env.GEZEL_KNOWLEDGE_VECTOR_FLOORS;
    process.env.GEZEL_KNOWLEDGE_VECTOR_FLOORS = 'off';
    try {
      const search = await ci.searchImages('c', 'sea turtle', 10, {
        kinds: ['video'],
        vector: unit(2),
      });
      expect(search.engine).toBe('hybrid');
      const turtle = search.results.filter((r) => r.path === 'clips/sea-turtle.mp4');
      expect(turtle[0]).toMatchObject({ kind: 'video', startMs: 30_000, endMs: 60_000 });
      // The filename match joined the best window instead of adding a row
      // with no moment; the other window is its own row.
      expect(turtle.map((r) => r.startMs)).toEqual([30_000, 0]);
    } finally {
      if (prior === undefined) delete process.env.GEZEL_KNOWLEDGE_VECTOR_FLOORS;
      else process.env.GEZEL_KNOWLEDGE_VECTOR_FLOORS = prior;
    }
  });

  it('describes a folder of images', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    await writeFile(join(dir, 'photos', 'a.png'), PNG_800x600);
    await writeFile(join(dir, 'photos', 'b.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: indexDb() });

    const desc = await ci.describeFolder('c', 'photos');
    expect(desc.imageCount).toBe(2);
    expect(desc.formats).toEqual([{ format: 'png', count: 2 }]);
    expect(desc.dimensions).toEqual({
      minWidth: 800,
      maxWidth: 800,
      minHeight: 600,
      maxHeight: 600,
    });
    expect(desc.captioned).toBe(0);
    expect(desc.samples).toContain('photos/a.png');
  });

  it('find_similar_images degrades to unavailable without media embeddings', async () => {
    await mkdir(join(dir, 'photos'), { recursive: true });
    await writeFile(join(dir, 'photos', 'a.png'), PNG_800x600);
    await runWorkspaceContentIndex(dir, 'c', artifacts, { dbPath: indexDb() });

    const sim = await ci.findSimilarImages('c', 'photos/a.png');
    expect(sim.engine).toBe('unavailable');
    expect(sim.results).toHaveLength(0);
  });
});

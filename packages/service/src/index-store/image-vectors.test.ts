/**
 * v12 image-vector storage: content-hash keying, the image-embed gate, the
 * model-swap wipe, and the chunk_id→content_hash table migration. The face
 * tables ride the same schema bump; their behavior is covered by the face
 * lane's own tests.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexStore, MAX_ENRICH_ATTEMPTS } from './index-store.js';
import { openIndexDatabase } from './sqlite-driver.js';

let dir: string;
const priorModel = process.env.GEZEL_IMAGE_EMBED_MODEL;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-imgvec-'));
});
afterEach(async () => {
  if (priorModel === undefined) delete process.env.GEZEL_IMAGE_EMBED_MODEL;
  else process.env.GEZEL_IMAGE_EMBED_MODEL = priorModel;
  await rm(dir, { recursive: true, force: true });
});

const open = () =>
  IndexStore.open(join(dir, 'index.db'), {
    collectionId: 'p1',
    kind: 'workspace',
    rootPath: dir,
  });

function imageFile(path: string, hash: string) {
  return {
    path,
    hash,
    size: 100,
    mtimeMs: 1,
    lang: null,
    kind: 'image',
    modality: 'image' as const,
    trivial: false,
    indexedAt: 'now',
    loc: null,
  };
}

const unitVec = (dim: number, hot: number) => {
  const v = new Array(dim).fill(0);
  v[hot % dim] = 1;
  return v;
};

describe('image vectors (v12, hash-keyed)', () => {
  it('stores and retrieves vectors by content hash; rename keeps the vector', async () => {
    const s = (await open())!;
    s.upsertFile(imageFile('photos/a.png', 'ha'));
    s.putImageVector('ha', 'photos/a.png', unitVec(512, 1));

    expect(s.imageVectorByHash('ha')?.vec[1]).toBe(1);
    expect(s.allImageVectors().map((v) => v.filePath)).toEqual(['photos/a.png']);

    // A rename re-upserts under a new path with the same hash — the vector
    // follows via the files join, no re-embed.
    s.deleteFile('photos/a.png');
    s.upsertFile(imageFile('photos/renamed.png', 'ha'));
    expect(s.allImageVectors().map((v) => v.filePath)).toEqual(['photos/renamed.png']);
    s.close();
  });

  it('excludes vectors whose file is gone from allImageVectors', async () => {
    const s = (await open())!;
    s.upsertFile(imageFile('a.png', 'ha'));
    s.upsertFile(imageFile('b.png', 'hb'));
    s.putImageVector('ha', 'a.png', unitVec(512, 0));
    s.putImageVector('hb', 'b.png', unitVec(512, 1));
    s.deleteFile('b.png');
    expect(s.allImageVectors().map((v) => v.contentHash)).toEqual(['ha']);
    s.close();
  });

  it('gates work by capped attempts, ok, and terminal unsupported', async () => {
    const s = (await open())!;
    s.upsertFile(imageFile('a.png', 'ha'));
    s.upsertFile(imageFile('b.webp', 'hb'));
    s.upsertFile(imageFile('c.jpg', 'hc'));
    expect(s.countNeedingImageEmbed()).toBe(3);

    s.markImageEmbedOk('ha', 'a.png');
    s.markImageEmbedUnsupported('hb', 'b.webp');
    expect(s.filesNeedingImageEmbed().map((f) => f.path)).toEqual(['c.jpg']);

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) s.markImageEmbedAttempt('hc', 'c.jpg');
    expect(s.countNeedingImageEmbed()).toBe(0);
    s.close();
  });

  it('a failed attempt below the cap stays in the work-list', async () => {
    const s = (await open())!;
    s.upsertFile(imageFile('a.png', 'ha'));
    expect(s.markImageEmbedAttempt('ha', 'a.png')).toBe(1);
    expect(s.filesNeedingImageEmbed().map((f) => f.path)).toEqual(['a.png']);
    s.close();
  });

  it('wipes vectors + gate on an image-model swap, leaving text state alone', async () => {
    process.env.GEZEL_IMAGE_EMBED_MODEL = 'test/image-model-A';
    const s1 = (await open())!;
    s1.upsertFile(imageFile('a.png', 'ha'));
    s1.putImageVector('ha', 'a.png', unitVec(512, 2));
    s1.markImageEmbedOk('ha', 'a.png');
    s1.upsertSummary({ contentHash: 'ha', filePath: 'a.png', summaryMd: 'caption', model: 'm' });
    expect(s1.countNeedingImageEmbed()).toBe(0);
    s1.close();

    // Same model → untouched.
    const same = (await open())!;
    expect(same.imageVectorByHash('ha')).not.toBeNull();
    same.close();

    process.env.GEZEL_IMAGE_EMBED_MODEL = 'test/image-model-B';
    const migrated = (await open())!;
    expect(migrated.imageVectorByHash('ha')).toBeNull();
    expect(migrated.countNeedingImageEmbed()).toBe(1); // gate cleared → re-queued
    expect(migrated.getSummary('ha')).toBe('caption'); // captions are not vectors
    migrated.close();
  });

  it('drops the legacy chunk_id-keyed table on open (v11 → v12)', async () => {
    const s1 = (await open())!;
    s1.close();

    // Simulate a pre-v12 db: recreate the old shape through a raw handle.
    const raw = (await openIndexDatabase(join(dir, 'index.db')))!;
    raw.exec('DROP TABLE image_vectors');
    raw.exec(`CREATE TABLE image_vectors (
      chunk_id INTEGER PRIMARY KEY,
      collection_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      vec BLOB
    )`);
    raw.close();

    const reopened = (await open())!;
    reopened.upsertFile(imageFile('a.png', 'ha'));
    reopened.putImageVector('ha', 'a.png', unitVec(512, 3));
    expect(reopened.imageVectorByHash('ha')?.filePath).toBe('a.png');
    reopened.close();
  });
});

describe('entity mention regions (face-lane substrate)', () => {
  it('round-trips region + confidence through addEntityMention/entityMentions', async () => {
    const s = (await open())!;
    const id = s.upsertEntity('person', 'Person 1', 'cluster-uuid-1');
    s.addEntityMention(id, 'photos/a.png', {
      region: '{"x":10,"y":20,"w":64,"h":64}',
      confidence: 0.92,
    });
    s.addEntityMention(id, 'photos/b.png', { line: 3 });

    const mentions = s.entityMentions(id);
    expect(mentions).toHaveLength(2);
    const withRegion = mentions.find((m) => m.filePath === 'photos/a.png');
    expect(withRegion?.region).toBe('{"x":10,"y":20,"w":64,"h":64}');
    expect(withRegion?.confidence).toBeCloseTo(0.92);
    const withoutRegion = mentions.find((m) => m.filePath === 'photos/b.png');
    expect(withoutRegion?.region).toBeNull();
    expect(withoutRegion?.line).toBe(3);
    s.close();
  });
});

/**
 * Media-vector storage (v14): content-hash keying, audio/video windows, the
 * media-embed gate, the identity-change wipe, and the CLIP-table drop. The
 * face tables have their own tests.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexStore, MAX_ENRICH_ATTEMPTS } from './index-store.js';
import { openIndexDatabase } from './sqlite-driver.js';

let dir: string;
const priorBudget = process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-imgvec-'));
});
afterEach(async () => {
  if (priorBudget === undefined) delete process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET;
  else process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET = priorBudget;
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

  it('wipes vectors + gate when the media embedder identity changes, leaving text state alone', async () => {
    process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET = '280';
    const s1 = (await open())!;
    s1.upsertFile(imageFile('a.png', 'ha'));
    s1.putImageVector('ha', 'a.png', unitVec(512, 2));
    s1.markImageEmbedOk('ha', 'a.png');
    s1.upsertSummary({ contentHash: 'ha', filePath: 'a.png', summaryMd: 'caption', model: 'm' });
    expect(s1.countNeedingImageEmbed()).toBe(0);
    s1.close();

    // Same identity → untouched.
    const same = (await open())!;
    expect(same.imageVectorByHash('ha')).not.toBeNull();
    same.close();

    // A vision token budget change moves every image vector.
    process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET = '70';
    const migrated = (await open())!;
    expect(migrated.imageVectorByHash('ha')).toBeNull();
    expect(migrated.countNeedingImageEmbed()).toBe(1); // gate cleared → re-queued
    expect(migrated.getSummary('ha')).toBe('caption'); // captions are not vectors
    migrated.close();
  });

  it('drops the CLIP-era image_vectors table on open (v13 → v14)', async () => {
    const s1 = (await open())!;
    s1.close();

    const raw = (await openIndexDatabase(join(dir, 'index.db')))!;
    raw.exec(`CREATE TABLE image_vectors (
      content_hash TEXT PRIMARY KEY, collection_id TEXT NOT NULL, file_path TEXT NOT NULL,
      model TEXT, dim INTEGER, vec BLOB, created_at TEXT
    )`);
    raw.close();

    const s2 = (await open())!;
    s2.close();
    const check = (await openIndexDatabase(join(dir, 'index.db')))!;
    const tables = check
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_vectors'`)
      .all<{ name: string }>()
      .map((t) => t.name);
    check.close();
    expect(tables).toContain('media_vectors');
    expect(tables).not.toContain('image_vectors');
  });

  it('stores audio and video windows per start time and lists them by kind', async () => {
    const s = (await open())!;
    s.upsertFile({ ...imageFile('talk.mp3', 'hm'), kind: 'audio', modality: 'audio' as never });
    s.putMediaVectors('hm', 'talk.mp3', 'audio', [
      { startMs: 0, endMs: 30_000, vec: unitVec(512, 3) },
      { startMs: 30_000, endMs: 52_000, vec: unitVec(512, 4) },
    ]);
    const rows = s.allMediaVectors(['audio']);
    expect(rows.map((r) => [r.startMs, r.endMs])).toEqual([
      [0, 30_000],
      [30_000, 52_000],
    ]);
    expect(s.allImageVectors()).toEqual([]);
    // Re-embedding a file replaces its windows rather than accumulating.
    s.putMediaVectors('hm', 'talk.mp3', 'audio', [
      { startMs: 0, endMs: 10_000, vec: unitVec(512, 5) },
    ]);
    expect(s.allMediaVectors(['audio'])).toHaveLength(1);
    s.close();
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

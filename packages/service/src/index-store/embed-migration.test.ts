import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexStore } from './index-store.js';
import { openIndexDatabase } from './sqlite-driver.js';

let dir: string;
const priorModel = process.env.GEZEL_EMBED_MODEL;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-embed-mig-'));
});
afterEach(async () => {
  if (priorModel === undefined) delete process.env.GEZEL_EMBED_MODEL;
  else process.env.GEZEL_EMBED_MODEL = priorModel;
  await rm(dir, { recursive: true, force: true });
});

const open = () =>
  IndexStore.open(join(dir, 'index.db'), {
    collectionId: 'p1',
    kind: 'workspace',
    rootPath: dir,
  });

describe('embed-model re-embed migration (IndexStore.open)', () => {
  it('invalidates vectors + enrichments on a model change but keeps summaries', async () => {
    process.env.GEZEL_EMBED_MODEL = 'test/model-A';
    const s1 = (await open())!;
    if (!s1.vecAvailable) return s1.close(); // sqlite-vec unavailable in this env

    s1.upsertFile({
      path: 'a.ts',
      hash: 'h1',
      size: 10,
      mtimeMs: 1,
      lang: 'typescript',
      kind: 'code',
      modality: 'code',
      trivial: false,
      indexedAt: 'now',
      loc: 5,
    });
    s1.putChunks('a.ts', 'h1', [{ kind: 'summary', lineStart: 1, lineEnd: 1, text: 'chunk' }]);
    s1.addTextVector(s1.chunksForFile('a.ts')[0]!.id, new Array(384).fill(0.1));
    s1.upsertSummary({ contentHash: 'h1', filePath: 'a.ts', summaryMd: 'kept', model: 'm' });
    s1.markEnriched('h1');
    expect(s1.enrichmentCounts()).toMatchObject({
      eligible: 1,
      summarized: 1,
      embedded: 1,
      pending: 0,
    });
    s1.close();

    // Reopen with the SAME model — no invalidation.
    process.env.GEZEL_EMBED_MODEL = 'test/model-A';
    const same = (await open())!;
    expect(same.getSummary('h1')).toBe('kept');
    expect(same.enrichmentCounts().embedded).toBe(1);
    same.close();

    // Reopen with a DIFFERENT model — vectors + enrichments cleared, summary kept,
    // file re-queued for a (cheap, LLM-free) re-embed.
    process.env.GEZEL_EMBED_MODEL = 'test/model-B';
    const migrated = (await open())!;
    expect(migrated.getSummary('h1')).toBe('kept'); // summary survives → no re-summarize
    expect(migrated.enrichmentCounts()).toMatchObject({
      eligible: 1,
      summarized: 1, // summaries table untouched
      embedded: 0, // enrichments cleared
      pending: 1, // file needs re-embed
    });
    migrated.close();
  });

  it('leaves file_reviews untouched on an embed-model swap (reviews are embedding-independent)', async () => {
    process.env.GEZEL_EMBED_MODEL = 'test/model-A';
    const s1 = (await open())!;
    s1.upsertFile({
      path: 'a.ts',
      hash: 'h1',
      size: 10,
      mtimeMs: 1,
      lang: 'typescript',
      kind: 'code',
      modality: 'code',
      trivial: false,
      indexedAt: 'now',
      loc: 5,
    });
    s1.upsertFileReview({
      contentHash: 'h1',
      filePath: 'a.ts',
      rubricHash: 'r1',
      notesMd: 'kept notes',
      issues: [{ severity: 'info', category: 'clarity', message: 'fine' }],
      health: 7,
      healthReason: 'solid',
      model: 'm',
    });
    s1.close();

    process.env.GEZEL_EMBED_MODEL = 'test/model-B';
    const migrated = (await open())!;
    const review = migrated.getFileReview('h1');
    expect(review?.notesMd).toBe('kept notes');
    expect(review?.health).toBe(7);
    migrated.close();
  });
});

describe('v7 → v8 schema migration (file_reviews)', () => {
  it('recreates a missing file_reviews table on open, keeping existing rows intact', async () => {
    const s1 = (await open())!;
    s1.upsertFile({
      path: 'a.ts',
      hash: 'h1',
      size: 10,
      mtimeMs: 1,
      lang: 'typescript',
      kind: 'code',
      modality: 'code',
      trivial: false,
      indexedAt: 'now',
      loc: 5,
    });
    s1.upsertSummary({ contentHash: 'h1', filePath: 'a.ts', summaryMd: 'kept', model: 'm' });
    s1.close();

    // Simulate a pre-v8 db: drop the table (and the attempts column's home)
    // through a raw handle, then reopen through IndexStore.
    const raw = (await openIndexDatabase(join(dir, 'index.db')))!;
    raw.exec('DROP TABLE file_reviews');
    const version = raw
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get<{ value: string }>();
    expect(version?.value).toBe('9');
    raw.close();

    const reopened = (await open())!;
    expect(reopened.getFileReview('h1')).toBeUndefined();
    reopened.recordReviewAttempt('h1', 'a.ts', 'r1');
    expect(reopened.getSummary('h1')).toBe('kept');
    expect(reopened.filesNeedingReview('code', 'r1', 10, 3)).toHaveLength(1);
    reopened.close();
  });
});

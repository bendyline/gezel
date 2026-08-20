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
    expect(version?.value).toBe('12');
    raw.close();

    const reopened = (await open())!;
    expect(reopened.getFileReview('h1')).toBeUndefined();
    reopened.recordReviewAttempt('h1', 'a.ts', 'r1');
    expect(reopened.getSummary('h1')).toBe('kept');
    expect(reopened.filesNeedingReview('code', 'r1', 10, 3)).toHaveLength(1);
    reopened.close();
  });
});

describe('v9 → v10 schema migration (provenance columns)', () => {
  it('adds provenance columns to a pre-v10 db, keeps old rows, forces no re-review', async () => {
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
      issues: [],
      health: 7,
      healthReason: 'solid',
      model: 'm',
    });
    s1.close();

    // Simulate a pre-v10 db: drop the provenance columns through a raw handle.
    const raw = (await openIndexDatabase(join(dir, 'index.db')))!;
    for (const col of ['provider', 'gezel_id', 'gezel_name', 'app_version']) {
      raw.exec(`ALTER TABLE file_reviews DROP COLUMN ${col}`);
      raw.exec(`ALTER TABLE summaries DROP COLUMN ${col}`);
    }
    raw.close();

    const reopened = (await open())!;
    const review = reopened.getFileReview('h1');
    // The old review survives with NULL provenance (no backfill is possible)…
    expect(review?.notesMd).toBe('kept notes');
    expect(review?.provider).toBeNull();
    expect(review?.gezelName).toBeNull();
    expect(review?.appVersion).toBeNull();
    // …and the migration alone must not re-admit reviewed files to the queue.
    expect(reopened.filesNeedingReview('code', 'r1', 10, 3)).toHaveLength(0);
    reopened.upsertFileReview({
      contentHash: 'h1',
      filePath: 'a.ts',
      rubricHash: 'r1',
      notesMd: 'new notes',
      issues: [],
      health: 8,
      healthReason: 'better',
      model: 'm2',
      provenance: { provider: 'llama-cpp', gezelName: 'Wachter', appVersion: '1.2.3' },
    });
    expect(reopened.getFileReview('h1')?.provider).toBe('llama-cpp');
    reopened.close();
  });

  it('stamps provenance on summaries, symbol one-liners, and area rollups', async () => {
    const provenance = {
      provider: 'mlx',
      gezelId: 'noor',
      gezelName: 'Noor',
      appVersion: '1.2.3',
    };
    const s1 = (await open())!;
    s1.upsertSummary({
      contentHash: 'h1',
      filePath: 'a.ts',
      summaryMd: 'sums',
      model: 'm',
      provenance,
    });
    s1.putSymbolSummaries('a.ts', 'h1', [{ name: 'alpha', summary: 'does x' }], 'm', provenance);
    s1.upsertAreaSummary({
      areaPath: 'src',
      inputHash: 'i1',
      summaryMd: 'area',
      model: 'm',
      provenance,
    });
    s1.close();

    const raw = (await openIndexDatabase(join(dir, 'index.db')))!;
    for (const table of ['summaries', 'symbol_summaries', 'area_summaries']) {
      const row = raw
        .prepare(`SELECT provider, gezel_id, gezel_name, app_version FROM ${table}`)
        .get<{
          provider: string | null;
          gezel_id: string | null;
          gezel_name: string | null;
          app_version: string | null;
        }>();
      expect(row).toMatchObject({
        provider: 'mlx',
        gezel_id: 'noor',
        gezel_name: 'Noor',
        app_version: '1.2.3',
      });
    }
    raw.close();
  });
});

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDocument, KnowledgeCatalogManifest } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified } from './archive/read.js';
import { compileKnowledgeCatalog } from './compiler/compile.js';
import { DatabaseSync } from './format/node-sqlite.js';
import { loadMarkdownCatalog } from './markdown-adapter/load.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { validateExtractedCatalog } from './reader/validate.js';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  fakeCountTokens,
  fakeEmbed,
} from './test/fixture.js';

let dir: string;
let extracted: string;
let handle: CatalogHandle;
let sequence = 0;
const topics = [
  { id: 'news', name: 'News' },
  { id: 'day-22', parentId: 'news', name: '2026-09-22', sortKey: '2' },
  { id: 'day-28', parentId: 'news', name: '2026-09-28', sortKey: '1' },
  { id: 'empty', parentId: 'news', name: 'Empty' },
];
const docs: CatalogDocument[] = [
  {
    id: 'polo',
    title: 'Hurricane Polo',
    slug: 'hurricane-polo',
    language: 'en',
    topicPath: ['news', 'day-22'],
    ordinal: 2,
    tocReferences: [
      { topicPath: ['news', 'day-28'], ordinal: 0 },
      { topicPath: ['news'], ordinal: 8 },
    ],
    markdown: '# Hurricane Polo\n\nOne canonical hurricane article.\n',
  },
  {
    id: 'alpha',
    title: 'Alpha',
    slug: 'alpha',
    language: 'en',
    topicPath: ['news', 'day-28'],
    ordinal: 1,
    markdown: '# Alpha\n\nAnother article.\n',
  },
  {
    id: 'zebra',
    title: 'Zebra',
    slug: 'zebra',
    language: 'en',
    topicPath: ['news', 'day-22'],
    markdown: '# Zebra\n\nAn unordered article.\n',
  },
];
async function build(documents = docs) {
  const name = `case-${sequence++}`;
  const outputPath = join(dir, `${name}.gezk`);
  const report = await compileKnowledgeCatalog({
    catalog: {
      id: 'news',
      version: '1.0.0',
      name: 'Daily news',
      language: 'en',
      publisher: { id: 'test', name: 'Test' },
      createdAt: '2026-10-04T00:00:00Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics,
    documents: (async function* () {
      yield* documents;
    })(),
    outputPath,
    workDir: join(dir, name),
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
  });
  return { ...report, outputPath };
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-shared-toc-'));
  const built = await build();
  extracted = join(dir, 'extracted');
  await extractGezkVerified(built.outputPath, extracted);
  handle = CatalogHandle.open(extracted);
});
afterAll(async () => {
  handle?.close();
  await rm(dir, { recursive: true, force: true });
});

async function corrupt(sql: string) {
  const root = join(dir, `corrupt-${sequence++}`);
  await cp(extracted, root, { recursive: true });
  const path = join(root, 'index/router.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sql);
  } finally {
    db.close();
  }
  const manifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8'),
  ) as KnowledgeCatalogManifest;
  const bytes = await readFile(path);
  const entry = manifest.files.find((f) => f.path === 'index/router.db');
  if (!entry) throw new Error('Missing router');
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  entry.sizeBytes = bytes.length;
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return validateExtractedCatalog(root, { deep: true });
}

describe('shared TOC references', () => {
  it('lists the same document directly under each date with independent ordering', () => {
    expect(handle.schemaVersion).toBe(4);
    expect(handle.formatVersion).toBe('0.7');
    const earlier = handle.documentsPage({ topicId: 'day-22', descendants: false });
    const later = handle.documentsPage({ topicId: 'day-28', descendants: false });
    expect(earlier.documents.map((d) => d.id)).toEqual(['polo', 'zebra']);
    expect(later.documents.map((d) => d.id)).toEqual(['polo', 'alpha']);
    expect(later.documents[0]).toMatchObject({
      id: 'polo',
      title: 'Hurricane Polo',
      topicId: 'day-28',
      ordinal: 0,
    });
    expect(handle.getDocument('polo')).toMatchObject({
      topicId: 'day-22',
      ordinal: 2,
      markdown: docs[0]?.markdown,
    });
    expect(
      handle.documentsPage({ topicId: 'news', descendants: false }).documents.map((d) => d.id),
    ).toEqual(['polo']);
  });
  it('deduplicates parent and whole-catalog pages and paginates after deduplication', () => {
    expect(handle.documentsPage({ topicId: 'news' }).total).toBe(3);
    expect(handle.documentsPage().total).toBe(3);
    const page1 = handle.documentsPage({ topicId: 'news', limit: 1 });
    const page2 = handle.documentsPage({ topicId: 'news', limit: 1, offset: 1 });
    const page3 = handle.documentsPage({ topicId: 'news', limit: 1, offset: 2 });
    expect([...page1.documents, ...page2.documents, ...page3.documents].map((d) => d.id)).toEqual([
      'polo',
      'alpha',
      'zebra',
    ]);
    expect(handle.documentsPage({ topicId: 'missing' })).toEqual({ documents: [], total: 0 });
    expect(handle.documentsPage({ topicId: 'empty' })).toEqual({ documents: [], total: 0 });
    const counts = new Map(handle.topics().map((t) => [t.id, t]));
    expect(counts.get('news')).toMatchObject({ documentCount: 1, totalDocumentCount: 3 });
    expect(counts.get('day-22')).toMatchObject({ documentCount: 2, totalDocumentCount: 2 });
    expect(counts.get('day-28')).toMatchObject({ documentCount: 2, totalDocumentCount: 2 });
  });
  it('stores and indexes one body and one set of chunks, with valid archive counts', async () => {
    expect((await validateExtractedCatalog(extracted, { deep: true })).ok).toBe(true);
    expect(handle.searchDocumentsFts('Hurricane Polo').map((h) => h.documentId)).toEqual(['polo']);
    const db = new DatabaseSync(join(extracted, 'index/router.db'), { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE id='polo'").get()?.n).toBe(1);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM fts_documents WHERE document_id='polo'").get()?.n,
      ).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM topic_documents').get()?.n).toBe(5);
      const baseline = await build(docs.map(({ tocReferences: _refs, ...doc }) => doc));
      const manifest = JSON.parse(
        await readFile(join(extracted, 'manifest.json'), 'utf8'),
      ) as KnowledgeCatalogManifest;
      expect(manifest.counts).toEqual(baseline.manifest.counts);
    } finally {
      db.close();
    }
  });
  it('is deterministic regardless of additional-reference input order', async () => {
    const a = await build();
    const b = await build(
      docs.map((d) => ({
        ...d,
        ...(d.tocReferences ? { tocReferences: [...d.tocReferences].reverse() } : {}),
      })),
    );
    expect(await readFile(a.outputPath)).toEqual(await readFile(b.outputPath));
  });
  it('rejects unknown, disconnected, duplicate and invalid-ordinal placements before embedding', async () => {
    const base = docs[0] as CatalogDocument;
    for (const references of [
      [{ topicPath: ['missing'] }],
      [{ topicPath: ['day-22', 'day-28'] }],
      [{ topicPath: ['news', 'day-22'] }],
      [{ topicPath: ['news', 'day-28'] }, { topicPath: ['news', 'day-28'] }],
      [{ topicPath: ['news', 'day-28'], ordinal: 1.5 }],
    ])
      await expect(build([{ ...base, tocReferences: references }])).rejects.toThrow();
  });
  it.each([
    "INSERT INTO topic_documents VALUES ('missing', 'polo', 0)",
    "INSERT INTO topic_documents VALUES ('day-28', 'missing', 0)",
    "DELETE FROM topic_documents WHERE document_id='polo' AND topic_id='day-22'",
    "UPDATE topic_documents SET ordinal=7 WHERE document_id='polo' AND topic_id='day-22'",
    'UPDATE topics SET document_count=999',
    'DROP TABLE topic_documents',
  ])('rejects corrupted TOC data: %s', async (sql) => {
    const result = await corrupt(sql);
    expect(result.ok).toBe(false);
    expect(
      result.checks.some((c) => !c.ok && /toc-|catalog-structure|counts-documents/.test(c.name)),
    ).toBe(true);
  });
  it('loads repeated Markdown TOC entries into references and compiles them end to end', async () => {
    const folder = join(dir, 'markdown');
    await mkdir(folder);
    await writeFile(
      join(folder, 'polo.md'),
      '---\nid: polo\n---\n# Hurricane Polo\n\nOne article.\n',
    );
    await writeFile(
      join(folder, 'mkdocs.yml'),
      'docs_dir: .\nnav:\n  - September 22:\n      - Hurricane Polo: polo.md\n      - Hurricane Polo: polo.md\n  - September 28:\n      - Hurricane Polo: polo.md\n',
    );
    const warnings: string[] = [];
    const source = await loadMarkdownCatalog(folder, {
      language: 'en',
      toc: { format: 'mkdocs' },
      onWarning: (w) => warnings.push(w),
    });
    expect(source.documents).toHaveLength(1);
    expect(source.documents[0]?.tocReferences).toHaveLength(1);
    expect(warnings).toEqual([]);
    const path = join(dir, 'markdown.gezk');
    await compileKnowledgeCatalog({
      catalog: {
        id: 'markdown',
        version: '1.0.0',
        name: 'Markdown',
        language: 'en',
        publisher: { id: 'test', name: 'Test' },
        createdAt: '2026-10-04T00:00:00Z',
        license: { name: 'MIT', attributionRequired: false },
      },
      topics: source.topics,
      documents: (async function* () {
        yield* source.documents;
      })(),
      outputPath: path,
      workDir: join(dir, 'markdown-build'),
      embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
      chunkingProfile: FIXTURE_CHUNKING_PROFILE,
      embed: fakeEmbed,
      countTokens: fakeCountTokens,
    });
    const output = join(dir, 'markdown-extracted');
    await extractGezkVerified(path, output);
    const reader = CatalogHandle.open(output);
    try {
      for (const topic of source.topics)
        expect(reader.documentsPage({ topicId: topic.id }).documents.map((d) => d.id)).toEqual([
          'polo',
        ]);
      expect(reader.documentsPage().total).toBe(1);
    } finally {
      reader.close();
    }
  });
});

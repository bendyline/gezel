/**
 * Phase-0 exit tests (knowledge-catalogs plan): deterministic double-build,
 * verified extraction, read-only + immutable open with plain SQLite, the
 * shipped TOC, brotli body round-trip, two-stage semantic search, doc-FTS
 * known queries, the embedder-free self-KNN smoke, and tamper rejection.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEZK_MIME_TYPE } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GezkArchiveError,
  extractGezkVerified,
  inspectGezkArchive,
  readGezkManifest,
} from './archive/read.js';
import { writeGezkArchive } from './archive/write.js';
import type { CompileReport } from './compiler/compile.js';
import { compileKnowledgeCatalog } from './compiler/compile.js';
import { CatalogHandle } from './reader/catalog-handle.js';
import { validateExtractedCatalog } from './reader/validate.js';
import {
  generateKnowledgeSigningKeyPair,
  signManifest,
  verifyManifestSignature,
} from './signatures/signing.js';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from './test/fixture.js';

let dir: string;
let archivePath: string;
let extractedDir: string;
let report: CompileReport;
let handle: CatalogHandle;

const DOCS = generateFixtureCorpus(250, 42);

async function build(outputPath: string, workDir: string): Promise<CompileReport> {
  return compileKnowledgeCatalog({
    catalog: {
      id: 'fixture-en',
      version: '1.0.0',
      name: 'Fixture Catalog',
      description: 'Synthetic corpus for format tests.',
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: FIXTURE_TOPICS,
    documents: (async function* () {
      for (const doc of DOCS) yield doc;
    })(),
    outputPath,
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir,
    extraFiles: { 'README.md': '# Fixture Catalog\nSynthetic corpus.\n' },
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-roundtrip-'));
  archivePath = join(dir, 'fixture-en-1.0.0.gezk');
  report = await build(archivePath, join(dir, 'work'));
  extractedDir = join(dir, 'extracted');
  await extractGezkVerified(archivePath, extractedDir);
  handle = CatalogHandle.open(extractedDir);
}, 240_000);

afterAll(async () => {
  handle?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('deterministic build', () => {
  it('two consecutive builds are byte-identical', { timeout: 240_000 }, async () => {
    const secondPath = join(dir, 'second.gezk');
    await build(secondPath, join(dir, 'work2'));
    const [a, b] = await Promise.all([readFile(archivePath), readFile(secondPath)]);
    expect(createHash('sha256').update(a).digest('hex')).toBe(
      createHash('sha256').update(b).digest('hex'),
    );
  });
});

describe('archive + manifest', () => {
  it('reports honest counts and a small-catalog embedded shard', () => {
    expect(report.documents).toBe(250);
    expect(report.shards).toBe(1);
    expect(report.manifest.router.shards[0]?.path).toBe('index/router.db');
    expect(report.manifest.counts.chunks).toBeGreaterThan(250);
  });

  it('reads the manifest without extraction', async () => {
    const manifest = await readGezkManifest(archivePath);
    expect(manifest.id).toBe('fixture-en');
    expect(manifest.kind).toBe('gezk-catalog');
    expect(manifest.formatVersion).toBe('0.5');
    expect(manifest.embedding.id).toBe(FIXTURE_EMBEDDING_PROFILE.id);
    expect(manifest.topics.length).toBeGreaterThanOrEqual(1);
    expect(manifest.license.noticePath).toBe('LICENSES/catalog.txt');
    expect(manifest.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['README.md', 'LICENSES/catalog.txt']),
    );
    expect(manifest.toolchain?.name).toBe('@bendyline/gezel-knowledge');
  });

  it('starts with the stored mimetype entry, identifiable at a fixed offset', async () => {
    const head = Buffer.from(await readFile(archivePath)).subarray(
      0,
      30 + 8 + GEZK_MIME_TYPE.length,
    );
    expect(head.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'));
    expect(head.subarray(30, 38).toString('utf8')).toBe('mimetype');
    expect(head.subarray(38).toString('utf8')).toBe(GEZK_MIME_TYPE);
  });

  it('refuses a manifest from an earlier format generation with a typed reason', async () => {
    const legacyPath = join(dir, 'legacy-format.gezk');
    const manifest = { ...report.manifest, kind: 'gezel-knowledge-catalog', formatVersion: 1 };
    await writeGezkArchive(legacyPath, [
      { path: 'manifest.json', content: Buffer.from(`${JSON.stringify(manifest)}\n`) },
      ...report.manifest.files.map((file) => ({
        path: file.path,
        absPath: join(extractedDir, file.path),
      })),
    ]);
    await expect(readGezkManifest(legacyPath)).rejects.toMatchObject({ reason: 'format-version' });
  });

  it('refuses an archive without the mimetype magic', async () => {
    const yazl = createRequire(import.meta.url)('yazl') as {
      ZipFile: new () => {
        addBuffer(buffer: Buffer, path: string): void;
        end(): void;
        outputStream: NodeJS.ReadableStream;
      };
    };
    const scratch = await mkdtemp(join(dir, 'no-magic-'));
    const noMagicPath = join(scratch, 'no-magic.gezk');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`${JSON.stringify(report.manifest)}\n`), 'manifest.json');
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(noMagicPath);
      out.on('close', () => resolve());
      out.on('error', reject);
      zip.outputStream.pipe(out);
      zip.end();
    });
    await expect(readGezkManifest(noMagicPath)).rejects.toMatchObject({ reason: 'mimetype' });
  });

  it('rejects a tampered archive', async () => {
    const tamperedPath = join(dir, 'tampered.gezk');
    const bytes = Buffer.from(await readFile(archivePath));
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = (bytes[mid] as number) ^ 0xff;
    await writeFile(tamperedPath, bytes);
    await expect(
      extractGezkVerified(tamperedPath, join(dir, 'tampered-out')),
    ).rejects.toBeInstanceOf(GezkArchiveError);
  });

  it('reconciles declared sizes with ZIP metadata before extraction', async () => {
    const dishonestPath = join(dir, 'dishonest-size.gezk');
    const manifest = structuredClone(report.manifest);
    manifest.files[0]!.sizeBytes += 1;
    await writeGezkArchive(dishonestPath, [
      { path: 'manifest.json', content: Buffer.from(`${JSON.stringify(manifest)}\n`) },
      ...report.manifest.files.map((file) => ({
        path: file.path,
        absPath: join(extractedDir, file.path),
      })),
    ]);

    await expect(inspectGezkArchive(dishonestPath)).rejects.toMatchObject({
      reason: 'hash-mismatch',
    });
    await expect(
      extractGezkVerified(dishonestPath, join(dir, 'dishonest-out')),
    ).rejects.toMatchObject({ reason: 'hash-mismatch' });
  });

  it('rejects a path-capable catalog version before any extraction', async () => {
    const traversalPath = join(dir, 'traversal-version.gezk');
    const manifest = structuredClone(report.manifest);
    manifest.version = '../../../../../escaped/extensions';
    await writeGezkArchive(traversalPath, [
      { path: 'manifest.json', content: Buffer.from(`${JSON.stringify(manifest)}\n`) },
      ...report.manifest.files.map((file) => ({
        path: file.path,
        absPath: join(extractedDir, file.path),
      })),
    ]);

    await expect(readGezkManifest(traversalPath)).rejects.toMatchObject({ reason: 'manifest' });
    await expect(
      extractGezkVerified(traversalPath, join(dir, 'traversal-out')),
    ).rejects.toMatchObject({ reason: 'manifest' });
  });
});

describe('read-only catalog handle', () => {
  it('ships a browsable table of contents', () => {
    const topics = handle.topics();
    expect(topics.length).toBe(FIXTURE_TOPICS.length);
    expect(topics.reduce((sum, t) => sum + t.documentCount, 0)).toBe(250);
  });

  it('round-trips a brotli-compressed document body', () => {
    const doc = handle.getDocument('doc-0001');
    expect(doc).not.toBeNull();
    expect(doc?.markdown).toContain('## Section 1');
    expect(doc?.markdown).toBe(
      (DOCS.find((d) => d.id === 'doc-0001')?.markdown ?? '').replace(/\r\n/g, '\n'),
    );
  });

  it('answers 20 known title queries through doc-FTS', () => {
    for (const doc of DOCS.slice(0, 20)) {
      const hits = handle.searchDocumentsFts(doc.title, 5);
      expect(
        hits.some((h) => h.documentId === doc.id),
        `expected ${doc.id} for query "${doc.title}"`,
      ).toBe(true);
    }
  });

  it('two-stage semantic search returns the exact chunk for its own text', async () => {
    // The hash embedder maps identical text to identical vectors, so a
    // chunk's own embed input must be its own nearest neighbor through the
    // full bit-KNN → int8-rerank path. Reconstruct the embed input the
    // compiler built for a known chunk (title header + text).
    const doc = DOCS[100];
    if (!doc) throw new Error('fixture missing');
    const full = handle.getDocument(doc.id);
    expect(full).not.toBeNull();
    // Take a section body line as the query via the stored chunk itself:
    // fetch semantic hits for the exact stored chunk text + header.
    const probe = await fakeEmbed([`${doc.title}\n${doc.markdown.slice(0, 200)}`]);
    void probe; // (vector shape sanity below uses the real stored chunk)

    // Use FTS to find one stored chunk's text, then query with its exact
    // embed input.
    const ftsHits = handle.searchChunksFts(doc.title, [0], 5);
    expect(ftsHits.length).toBeGreaterThan(0);
    const chunk = ftsHits[0];
    if (!chunk) throw new Error('no chunk hit');
    const headingPart =
      chunk.headingPath.length > 0
        ? `${chunk.title}\n${chunk.headingPath.join(' > ')}\n`
        : `${chunk.title}\n`;
    const [vector] = await fakeEmbed([`${headingPart}${chunk.text}`]);
    const hits = handle.searchSemantic(Float32Array.from(vector as number[]), { finalK: 5 });
    expect(hits[0]?.chunkUid).toBe(chunk.chunkUid);
    expect(hits[0]?.cosine).toBeGreaterThan(0.95);
  });

  it('passes the embedder-free self-KNN smoke', () => {
    expect(handle.selfKnnSmoke(0)).toBe(true);
  });
});

describe('validation', () => {
  it('deep validation passes on the extracted fixture', async () => {
    const report = await validateExtractedCatalog(extractedDir, { deep: true });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.manifest?.id).toBe('fixture-en');
  });

  it('deep validation flags a corrupted database file', async () => {
    const { cp } = await import('node:fs/promises');
    const corruptDir = join(dir, 'corrupt');
    await cp(extractedDir, corruptDir, { recursive: true });
    const dbPath = join(corruptDir, 'index', 'router.db');
    const bytes = Buffer.from(await readFile(dbPath));
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 0xff;
    await writeFile(dbPath, bytes);
    const report = await validateExtractedCatalog(corruptDir, { deep: true });
    expect(report.ok).toBe(false);
  });
});

describe('signed build', () => {
  it(
    'a finalizeManifest-signed archive round-trips and verifies',
    { timeout: 60_000 },
    async () => {
      const keys = generateKnowledgeSigningKeyPair();
      const signedPath = join(dir, 'signed.gezk');
      await compileKnowledgeCatalog({
        catalog: {
          id: 'fixture-signed',
          version: '1.0.0',
          name: 'Signed Fixture',
          language: 'en',
          publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
          createdAt: '2026-01-01T00:00:00.000Z',
          license: { name: 'MIT', attributionRequired: false },
        },
        topics: FIXTURE_TOPICS,
        documents: (async function* () {
          for (const doc of DOCS.slice(0, 20)) yield doc;
        })(),
        outputPath: signedPath,
        embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
        chunkingProfile: FIXTURE_CHUNKING_PROFILE,
        embed: fakeEmbed,
        countTokens: fakeCountTokens,
        workDir: join(dir, 'work-signed'),
        finalizeManifest: (manifest) => signManifest(manifest, keys.privateKeyPem),
      });
      const manifest = await readGezkManifest(signedPath);
      expect(manifest.signature?.keyId).toBe(keys.keyId);
      const verdict = verifyManifestSignature(manifest, [
        { keyId: keys.keyId, publicKeyPem: keys.publicKeyPem },
      ]);
      expect(verdict).toEqual({ ok: true, keyId: keys.keyId });
      const wrongKeys = generateKnowledgeSigningKeyPair();
      expect(
        verifyManifestSignature(manifest, [
          { keyId: wrongKeys.keyId, publicKeyPem: wrongKeys.publicKeyPem },
        ]).ok,
      ).toBe(false);
    },
  );
});

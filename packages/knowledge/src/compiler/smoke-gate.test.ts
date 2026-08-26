/**
 * The seal-time smoke gate (the arts-pilot lesson): a catalog must never
 * ship sanity queries its own built index cannot answer — the failure has
 * to land in the PRODUCER's build, not the user's install.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified } from '../archive/read.js';
import { readGezkManifest } from '../archive/read.js';
import { validateExtractedCatalog } from '../reader/validate.js';
import {
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from '../test/fixture.js';
import { compileKnowledgeCatalog } from './compile.js';

let dir: string;
const DOCS = generateFixtureCorpus(60, 7);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-smoke-gate-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function build(opts: {
  outputPath: string;
  workDir: string;
  smokeQueries: Array<{ query: string; expectedDocumentIds: string[] }>;
  smokeQueryPolicy?: 'require' | 'select';
}) {
  return compileKnowledgeCatalog({
    catalog: {
      id: 'fixture-en',
      version: '1.0.0',
      name: 'Fixture Catalog',
      language: 'en',
      publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: FIXTURE_TOPICS,
    documents: (async function* () {
      for (const doc of DOCS) yield doc;
    })(),
    outputPath: opts.outputPath,
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: opts.workDir,
    smokeQueries: opts.smokeQueries,
    ...(opts.smokeQueryPolicy ? { smokeQueryPolicy: opts.smokeQueryPolicy } : {}),
  });
}

describe('seal-time smoke-query gate', () => {
  it('require mode fails the BUILD when a recorded query cannot rank its document', async () => {
    const target = DOCS[0]!;
    await expect(
      build({
        outputPath: join(dir, 'bad.gezk'),
        workDir: join(dir, 'work-bad'),
        // A query with no lexical relation to the target document: the
        // index can never surface it, so the seal must refuse.
        smokeQueries: [{ query: 'zzz-nonexistent-term', expectedDocumentIds: [target.id] }],
      }),
    ).rejects.toThrow(/smoke queries failed against the built index/);
  });

  it('select mode records only candidates the built index actually answers', async () => {
    const good = DOCS[1]!;
    const alsoGood = DOCS[2]!;
    const outputPath = join(dir, 'select.gezk');
    await build({
      outputPath,
      workDir: join(dir, 'work-select'),
      smokeQueryPolicy: 'select',
      smokeQueries: [
        { query: 'zzz-nonexistent-term', expectedDocumentIds: [good.id] },
        { query: good.title, expectedDocumentIds: [good.id] },
        { query: alsoGood.title, expectedDocumentIds: [alsoGood.id] },
      ],
    });
    const manifest = await readGezkManifest(outputPath);
    expect(manifest.smokeQueries?.map((s) => s.query)).toEqual([good.title, alsoGood.title]);

    // And what the seal proved is exactly what the install-time validator
    // re-checks: the extracted catalog passes deep validation.
    const extracted = join(dir, 'select-extract');
    await extractGezkVerified(outputPath, extracted);
    const report = await validateExtractedCatalog(extracted, { deep: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('select mode with zero viable candidates fails the build', async () => {
    await expect(
      build({
        outputPath: join(dir, 'none.gezk'),
        workDir: join(dir, 'work-none'),
        smokeQueryPolicy: 'select',
        smokeQueries: [
          { query: 'zzz-nonexistent-term', expectedDocumentIds: [DOCS[3]!.id] },
        ],
      }),
    ).rejects.toThrow(/no smoke-query candidate passes/);
  });
});

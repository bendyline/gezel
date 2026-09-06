import { createHash } from 'node:crypto';
import { cpSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified } from '../archive/read.js';
import { compileKnowledgeCatalog } from '../compiler/compile.js';
import { DatabaseSync } from '../format/node-sqlite.js';
import {
  FIXTURE_ASSETS,
  FIXTURE_CHUNKING_PROFILE,
  FIXTURE_EMBEDDING_PROFILE,
  FIXTURE_TOPICS,
  fakeCountTokens,
  fakeEmbed,
  generateFixtureCorpus,
} from '../test/fixture.js';
import { assetReferences, validateExtractedCatalog } from './validate.js';

let dir: string;
let extracted: string;
let copies = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-validate-'));
  const archivePath = join(dir, 'fixture.gezk');
  const docs = generateFixtureCorpus(24, 3);
  await compileKnowledgeCatalog({
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
      for (const doc of docs) yield doc;
    })(),
    outputPath: archivePath,
    embeddingProfile: FIXTURE_EMBEDDING_PROFILE,
    chunkingProfile: FIXTURE_CHUNKING_PROFILE,
    embed: fakeEmbed,
    countTokens: fakeCountTokens,
    workDir: join(dir, 'work'),
    assets: FIXTURE_ASSETS,
  });
  extracted = join(dir, 'extracted');
  await extractGezkVerified(archivePath, extracted);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A mutable copy of the extracted catalog whose manifest is re-pointed at
 * the mutated files, so the per-file hash checks pass and the check under
 * test is the one that fires.
 */
async function mutatedCopy(
  mutate: (root: string, manifest: Record<string, unknown>) => Promise<string[]> | string[],
): Promise<string> {
  copies += 1;
  const root = join(dir, `copy-${copies}`);
  cpSync(extracted, root, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const changed = await mutate(root, manifest);
  const files = manifest.files as Array<{ path: string; sizeBytes: number; sha256: string }>;
  for (const path of changed) {
    const bytes = await readFile(join(root, path));
    const entry = files.find((f) => f.path === path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (entry) {
      entry.sizeBytes = bytes.byteLength;
      entry.sha256 = sha256;
    } else {
      files.push({ path, sizeBytes: bytes.byteLength, sha256 });
    }
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

function withRouter(root: string, sql: string): void {
  const db = new DatabaseSync(join(root, 'index', 'router.db'));
  try {
    // The mutations deliberately break invariants the schema enforces.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function failing(root: string): Promise<string[]> {
  const report = await validateExtractedCatalog(root, { deep: true });
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('validateExtractedCatalog on a 0.6 catalog', () => {
  it('passes the untouched fixture, including the new checks', async () => {
    const report = await validateExtractedCatalog(extracted, { deep: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const names = report.checks.map((c) => c.name);
    for (const expected of [
      'meta-format',
      'topics-tree',
      'documents-topic-declared',
      'assets-paths',
      'assets-limits',
      'counts-assets',
      'document-meta-json',
      'asset-type:assets/mark.png',
      'document-asset-refs',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('refuses a parent cycle in the topic tree', async () => {
    const root = await mutatedCopy((r) => {
      withRouter(r, "UPDATE topics SET parent_id = 'metals' WHERE id = 'craft'");
      return ['index/router.db'];
    });
    expect(await failing(root)).toContain('topics-tree');
  });

  it('refuses a document filed under an undeclared topic', async () => {
    const root = await mutatedCopy((r) => {
      withRouter(r, "UPDATE documents SET topic_id = 'ghost' WHERE id = 'doc-0002'");
      return ['index/router.db'];
    });
    expect(await failing(root)).toContain('documents-topic-declared');
  });

  it('refuses metadata that is not an object or is oversized', async () => {
    const root = await mutatedCopy((r) => {
      withRouter(
        r,
        `UPDATE documents SET meta_json = '[1,2]' WHERE id = 'doc-0002';
         UPDATE documents SET meta_json = '{"x":"${'y'.repeat(17 * 1024)}"}' WHERE id = 'doc-0003';`,
      );
      return ['index/router.db'];
    });
    const report = await validateExtractedCatalog(root, { deep: true });
    const check = report.checks.find((c) => c.name === 'document-meta-json');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('doc-0002');
    expect(check?.detail).toContain('doc-0003');
  });

  it('refuses an asset whose bytes do not match its extension, and an active SVG', async () => {
    const root = await mutatedCopy(async (r, manifest) => {
      await writeFile(join(r, 'assets', 'mark.png'), 'GIF89a not a png');
      await writeFile(
        join(r, 'assets', 'live.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      );
      (manifest.counts as Record<string, number>).assets = 2;
      return ['assets/mark.png', 'assets/live.svg'];
    });
    const names = await failing(root);
    expect(names).toContain('asset-type:assets/mark.png');
    expect(names).toContain('asset-svg-inert:assets/live.svg');
  });

  it('reconciles counts.assets and the asset path grammar', async () => {
    const root = await mutatedCopy((_r, manifest) => {
      (manifest.counts as Record<string, number>).assets = 3;
      return [];
    });
    expect(await failing(root)).toContain('counts-assets');
    const bad = await mutatedCopy(async (r, manifest) => {
      await writeFile(join(r, 'assets', 'notes.txt'), 'hello');
      (manifest.counts as Record<string, number>).assets = 2;
      return ['assets/notes.txt'];
    });
    expect(await failing(bad)).toContain('assets-paths');
  });

  it('extracts asset references from a body', () => {
    expect(
      assetReferences(
        '![a](assets/x.png) and [b]( <assets/dir/y.svg> ) and ![c](https://h/x.png) and ![d](assets/x.png)',
      ),
    ).toEqual(['assets/x.png', 'assets/dir/y.svg']);
  });
});

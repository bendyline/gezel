/**
 * A 0.6 reader must keep opening catalogs published under gezk 0.5: the
 * vendored conformance fixture of that generation is the proof. Everything
 * the newer generation added reads back as its absence — no ordinal, no
 * metadata, no assets — and the rollup is a no-op because 0.5 filed every
 * document at its root topic.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractGezkVerified, readGezkManifest } from '../archive/read.js';
import { CatalogHandle } from './catalog-handle.js';
import { validateExtractedCatalog } from './validate.js';

const LEGACY_FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'conformance',
  'fixtures',
  'conformance-0.5.gezk',
);

let dir: string;
let handle: CatalogHandle;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezk-legacy-'));
  await extractGezkVerified(LEGACY_FIXTURE, join(dir, 'extracted'));
  handle = CatalogHandle.open(join(dir, 'extracted'));
});

afterAll(async () => {
  handle?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('reading a gezk 0.5 catalog with the 0.6 reader', () => {
  it('accepts the older generation at every gate', async () => {
    const manifest = await readGezkManifest(LEGACY_FIXTURE);
    expect(manifest.formatVersion).toBe('0.5');
    expect(manifest.indexSchemaVersion).toBe(2);
    expect(manifest.counts.assets).toBeUndefined();
    expect(handle.schemaVersion).toBe(2);
    expect(handle.formatVersion).toBe('0.5');
  });

  it('rolls up nothing, orders by slug, and reports the new fields as absent', () => {
    const topics = handle.topics();
    for (const topic of topics) expect(topic.totalDocumentCount).toBe(topic.documentCount);
    const metals = topics.find((t) => t.id === 'metals');
    expect(metals?.parentId).toBe('craft');
    expect(metals?.documentCount).toBe(0);
    const page = handle.documentsPage({ limit: 200 });
    const slugs = page.documents.map((d) => d.slug);
    expect([...slugs].sort()).toEqual(slugs);
    expect(page.documents.every((d) => d.ordinal === null && d.meta === null)).toBe(true);
    const first = page.documents[0];
    expect(first).toBeDefined();
    expect(handle.getDocument(first?.id ?? '')?.meta).toBeNull();
    expect(handle.assets()).toEqual([]);
    expect(handle.readAsset('assets/mark.png')).toBeNull();
  });

  it('passes deep validation under the 0.5 check set', async () => {
    const report = await validateExtractedCatalog(join(dir, 'extracted'), { deep: true });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('assets-not-in-0.5');
    expect(names).toContain('meta-format');
    expect(names).not.toContain('counts-assets');
  });
});

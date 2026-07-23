import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { type NormalizeSpec, applyNormalize } from './normalize.js';

/**
 * Golden test for the shipped `airtable-records` connector-type: it loads the
 * REAL bundled manifest (not an inline copy), runs a raw Airtable record — the
 * same shape `list-records.conformance.test.ts` proves the vendored action
 * returns — through `applyNormalize`, and pins the resulting `NormalizedRecord`
 * the safety writer then consumes. Editing the manifest's `normalize.map`
 * without updating this test turns the drift into a red build.
 *
 * The two tests together close the spectral loop end-to-end for Airtable:
 *   vendored action (conformance) → { data: AirtableRecord[] }
 *   manifest normalize (this test) → NormalizedRecord → writer.
 */
describe('airtable-records normalize golden (shipped manifest)', () => {
  // One row as the Airtable API returns it (raw, pre-normalize).
  const raw = {
    id: 'recA1',
    createdTime: '2026-06-01T10:00:00.000Z',
    fields: {
      Name: 'Design review',
      Status: 'In progress',
      Notes: 'Ship the connectors tab',
    },
  };

  it('maps a raw record to the canonical NormalizedRecord', async () => {
    const catalog = new CatalogService([new BundledSource({ noIndex: true })]);
    const detail = await catalog.get('connector-type', 'airtable-records');
    expect(detail?.manifest.kind).toBe('connector-type');
    if (!detail || detail.manifest.kind !== 'connector-type') throw new Error('unreachable');

    const manifest = detail.manifest;
    expect(manifest.driver).toBe('spectral');

    const rec = await applyNormalize(manifest.normalize as NormalizeSpec, raw, {
      namespace: manifest.id,
    });

    expect(rec).toEqual({
      recordId: 'recA1',
      dirSegments: ['records'],
      fileStem: 'design-review',
      frontmatter: {
        direction: 'inbound',
        title: 'Design review',
        date: '2026-06-01T10:00:00.000Z',
        recordId: 'recA1',
        createdTime: '2026-06-01T10:00:00.000Z',
      },
      bodyMarkdown: JSON.stringify(raw.fields, null, 2),
      scanOrigin: 'airtable-records',
      quarantineNamespace: 'airtable-records',
      quarantineLabel: 'Design review',
    });
  });

  it('a row without a Name field names the file by record id (graceful title fallback)', async () => {
    const catalog = new CatalogService([new BundledSource({ noIndex: true })]);
    const detail = await catalog.get('connector-type', 'airtable-records');
    if (!detail || detail.manifest.kind !== 'connector-type') throw new Error('unreachable');

    const rec = await applyNormalize(
      detail.manifest.normalize as NormalizeSpec,
      { id: 'recNoName', createdTime: '2026-06-02T00:00:00.000Z', fields: { Status: 'Todo' } },
      { namespace: detail.manifest.id },
    );

    expect(rec.recordId).toBe('recNoName');
    expect(rec.fileStem).toBe('recnoname');
    expect(rec.frontmatter.title).toBeUndefined();
    expect(rec.quarantineLabel).toBe('recNoName');
  });
});

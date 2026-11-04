import { describe, expect, it } from 'vitest';
import {
  knowledgeCatalogUrl,
  mobileKnowledgeCatalogs,
  mobileQueryModels,
  queryModelStoreId,
} from './catalog.js';

// What the native stores accept (SpeechModels.java, SpeechModelStore in
// GezelSpeechPlugin.swift, MAX_ARCHIVE in both GezelKnowledge plugins): a
// pinned download outside these rules would fail on every device.
const STORE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ARCHIVE = 32 * 1024 ** 3;

describe('knowledge catalog snapshot', () => {
  it('pins each catalog to an immutable download the native stores accept', () => {
    expect(mobileKnowledgeCatalogs.length).toBeGreaterThan(0);
    for (const catalog of mobileKnowledgeCatalogs) {
      expect(catalog.id).toMatch(STORE_ID);
      expect(catalog.version).toMatch(SEGMENT);
      expect(catalog.huggingface.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(catalog.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(catalog.archiveBytes).toBeGreaterThan(0);
      expect(catalog.archiveBytes).toBeLessThanOrEqual(MAX_ARCHIVE);
    }
  });

  it("has a query model for every catalog's embedding profile", () => {
    for (const catalog of mobileKnowledgeCatalogs)
      expect(mobileQueryModels.map((model) => model.id)).toContain(catalog.embeddingProfile.id);
  });

  it('pins each query model file and names it as the native stores require', () => {
    for (const model of mobileQueryModels) {
      expect(queryModelStoreId(model.id)).toMatch(STORE_ID);
      const names = model.files.map((file) => file.name);
      expect(names).toEqual(expect.arrayContaining([model.model, model.tokenizer]));
      expect(names).toContain('tokenizer_config.json');
      for (const file of model.files) {
        expect(file.name.split('/').every((part) => SEGMENT.test(part))).toBe(true);
        expect(file.url).toMatch(
          /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//,
        );
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.size).toBeGreaterThan(0);
      }
    }
  });

  it('builds the immutable download URL with each path segment encoded', () => {
    const [catalog] = mobileKnowledgeCatalogs;
    expect(
      knowledgeCatalogUrl({
        ...catalog!,
        huggingface: { repo: 'Bendyline/knowledge', revision: 'abc', path: 'a b/c#d.gezk' },
      }),
    ).toBe(
      'https://huggingface.co/datasets/Bendyline/knowledge/resolve/abc/a%20b/c%23d.gezk?download=true',
    );
    expect(queryModelStoreId('multilingual-e5-small@2')).toBe('query-multilingual-e5-small-2');
  });
});

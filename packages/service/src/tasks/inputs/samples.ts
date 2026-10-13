import { sampleCommonDir } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { CraftbookSampleReader } from './resolve.js';

export { sampleCommonDir };

/** Where a book resolves from outside the catalog: its samples are not there. */
const NON_CATALOG_SOURCES = new Set(['project', 'local']);

/**
 * Sample files read from the craftbook's version folder in the catalog source
 * the book itself came from. A project or local copy of a book never borrows
 * the catalog's sample of the same id.
 */
export function catalogSampleReader(
  catalog: Pick<CatalogService, 'readItemFile'>,
): CraftbookSampleReader {
  return {
    async read({ craftbookId, sourceId, version, sample }) {
      if (sourceId && NON_CATALOG_SOURCES.has(sourceId)) return null;
      const prefix = sampleCommonDir(sample.files);
      const out: Array<{ rel: string; bytes: Uint8Array }> = [];
      for (const path of sample.files) {
        const buf = await catalog.readItemFile(
          'craftbook-template',
          craftbookId,
          path,
          sourceId,
          version,
        );
        if (!buf) return null;
        out.push({ rel: path.slice(prefix.length), bytes: new Uint8Array(buf) });
      }
      return out;
    },
  };
}

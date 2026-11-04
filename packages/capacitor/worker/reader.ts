// What catalog-host.ts imports from @bendyline/gezel-knowledge, without the
// package's compiler and archive writer (Node only). Archives are verified
// against their pinned sha256 when they download, so there is no extraction
// to validate.
export { CatalogHandle } from '../../knowledge/src/reader/catalog-handle.js';
export async function validateExtractedCatalog(): Promise<never> {
  throw new Error('Catalogs are verified when they download');
}

import type { CatalogItemDetail, Craftbook } from '../schemas/index.js';
import type { MobileModelSourceIdentity } from '../schemas/mobile-provider.js';
/** Snapshot of the exact pinned catalog, compiled by the host build. */
export interface PortableCatalogModel {
  name: string;
  description?: string;
  license?: string;
  approxSizeBytes: number;
  contextWindow?: number;
  source: MobileModelSourceIdentity;
}
export interface PortableContent {
  models?: PortableCatalogModel[];
  templates: CatalogItemDetail[];
  craftbooks: Array<{ item: CatalogItemDetail; book: Craftbook }>;
}

import type { CatalogItemDetail, Craftbook } from '../schemas/index.js';
import type { MobileModelSourceIdentity } from '../schemas/mobile-provider.js';
import type { ChatModelTuning } from '../schemas/model-tuning.js';
/** Snapshot of the exact pinned catalog, compiled by the host build. */
export interface PortableCatalogModel {
  name: string;
  description?: string;
  license?: string;
  approxSizeBytes: number;
  contextWindow?: number;
  source: MobileModelSourceIdentity;
  /** The catalog's sampling/reasoning tuning, resolved per turn like the desktop's. */
  tuning?: ChatModelTuning;
  /** `style.reasoningFormat`: whether `samplingWhenThinking` can apply. */
  reasoningFormat?: 'think' | 'channel' | 'inline' | 'none';
}
export interface PortableContent {
  models?: PortableCatalogModel[];
  templates: CatalogItemDetail[];
  craftbooks: Array<{ item: CatalogItemDetail; book: Craftbook }>;
}

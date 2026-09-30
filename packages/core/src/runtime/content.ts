import type { CatalogItemDetail, Craftbook } from '../schemas/index.js';
import type { MobileModelSourceIdentity } from '../schemas/mobile-provider.js';
import type { BehaviorEntry, ModelStyle } from '../schemas/model-profile.js';
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
  /** The manifest's style and behaviors, from which the model profile resolves. */
  style?: ModelStyle;
  behaviors?: BehaviorEntry[];
  /** The manifest's parameter size ("8B"), which sets the capability tier. */
  parameterSize?: string;
}
export interface PortableContent {
  models?: PortableCatalogModel[];
  templates: CatalogItemDetail[];
  craftbooks: Array<{ item: CatalogItemDetail; book: Craftbook }>;
}

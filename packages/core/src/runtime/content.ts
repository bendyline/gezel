import type { CatalogItemDetail, CatalogItemSummary, Craftbook } from '../schemas/index.js';
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
  /**
   * Each bundled book's sample files, base64 by version-folder path
   * (`samples/shop-sales/sales.csv`), so a first project can run on its sample
   * with no network. Keyed by craftbook id.
   */
  sampleFiles?: Record<string, Record<string, string>>;
  /**
   * Catalog books this device cannot run, as summaries with the reason
   * (`unavailableReason`), so New Task can show them disabled and say why
   * instead of the catalog silently looking smaller. Step prompts are
   * stripped; nothing here is ever executed.
   */
  unavailableCraftbooks?: CatalogItemSummary[];
}

import type { FileMapResponse } from '@bendyline/gezel';
import type { Camera, LodTier } from '../camera.js';
import type { CityPalette } from '../palette.js';
import type { SpriteAtlas } from '../sprites.js';

/** Everything one frame of the city renderer needs — passed to every pass. */
export interface RenderState {
  cam: Camera;
  model: FileMapResponse;
  palette: CityPalette;
  tier: LodTier;
  viewW: number;
  viewH: number;
  selectedId: string | null;
  hoverId: string | null;
  /** PR blast radius — blocks that (transitively) import a changed block. */
  affectedIds?: ReadonlySet<string>;
  /** Age lens: color blocks by placement recency instead of language. */
  ageLens?: boolean;
  /** Epoch ms "now" for the age lens (injectable for deterministic tests). */
  now?: number;
  /** Monotonic animation clock in ms; 0 gives a deterministic still frame. */
  animationTime?: number;
  /** Decoration sprite atlas; null/absent (jsdom, first frame) skips decor. */
  atlas?: SpriteAtlas | null;
}

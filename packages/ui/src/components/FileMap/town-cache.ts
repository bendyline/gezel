import type { FileMapResponse, MapBlock } from '@bendyline/gezel';
import { type TownStyle, townStyleForBlock } from './iso/town-style.js';

/**
 * Per-model architectural styles, memoized like `geometryForModel` and
 * `decorForModel`.
 *
 * Two reasons this exists rather than resolving styles at draw time:
 *
 * 1. **Cost.** `townStyleForBlock` hashes the block id and runs a PRNG. The iso
 *    renderer called it for every visible block on every frame — and then threw
 *    the result away on the podium path — so a district-zoom pan was paying for
 *    thousands of hashes it never used.
 * 2. **One story, two renderers.** The flat top-down view used to re-derive its
 *    own architecture from `health.zone`, independently of the iso vocabulary,
 *    which is why the two views disagreed about what a file looked like. Both
 *    now read the same resolved struct.
 */

const cache = new WeakMap<FileMapResponse, Map<string, TownStyle>>();

export function styleForModel(model: FileMapResponse): Map<string, TownStyle> {
  const hit = cache.get(model);
  if (hit) return hit;
  const built = new Map<string, TownStyle>();
  for (const b of model.blocks) {
    if (b.state === 'tombstoned') continue;
    built.set(b.id, townStyleForBlock(b));
  }
  cache.set(model, built);
  return built;
}

/** The cached style for one block, resolving on demand for blocks the model
 *  doesn't own (PR-overlay phantoms are built outside the payload's block list). */
export function styleForBlock(model: FileMapResponse, block: MapBlock): TownStyle {
  const hit = styleForModel(model).get(block.id);
  if (hit) return hit;
  const built = townStyleForBlock(block);
  styleForModel(model).set(block.id, built);
  return built;
}

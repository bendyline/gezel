import { type FileUse, type MapBlock, fileUseOf } from '@bendyline/gezel';

/**
 * The map use of a block — see `fileUseOf` in core for the classes. Path-based,
 * so it works on any payload, including ones built before fields and parks.
 */
export function blockUse(block: Pick<MapBlock, 'id' | 'lang'>): FileUse {
  return fileUseOf(block.id, block.lang);
}

/**
 * Whether a symbol-carrying block is drawn as a campus of symbol buildings.
 * Only code is: a config file with two exported helpers is still the town's
 * signal tower, and a field or a park has no buildings to stand on it. Every
 * consumer of the campus — the painter, the symbol tags, the mini hit test,
 * the fire marker's anchor — reads this one predicate so they never disagree.
 */
export function hasSymbolCampus(block: Pick<MapBlock, 'id' | 'lang' | 'buildingCount'>): boolean {
  return block.buildingCount > 0 && blockUse(block) === 'code';
}

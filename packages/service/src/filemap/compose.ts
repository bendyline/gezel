import type { FileMapResponse, MapDistrict, Rect } from '@bendyline/gezel';

/**
 * The combined map is a view over the two durable cities, not a third layout.
 * Keep this gap in world units so the neighborhoods remain distinct while the
 * renderer's camera is still free to fit them as one town.
 */
const SCOPE_GAP = 80;

type ComposedScope = 'core' | 'tests';

function offsetRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h };
}

function scopeId(scope: ComposedScope, id: string): string {
  return `scope:${scope}:${id}`;
}

function wrapperId(scope: ComposedScope): string {
  return `scope:${scope}`;
}

function translateScope(
  model: FileMapResponse,
  scope: ComposedScope,
  label: string,
  dx: number,
  dy: number,
): Pick<FileMapResponse, 'districts' | 'blocks' | 'buildings' | 'roads' | 'streets' | 'plazas'> {
  const wrapper = wrapperId(scope);
  const liveBlocks = model.blocks.filter((block) => block.state !== 'tombstoned' && !block.phantom);
  const area: MapDistrict = {
    id: wrapper,
    parentId: null,
    rect: offsetRect(model.bounds, dx, dy),
    label,
    displayLabel: label,
    depth: 0,
    fileCount: liveBlocks.length,
    weight: liveBlocks.reduce((sum, block) => sum + block.weight, 0),
  };

  return {
    districts: [
      area,
      ...model.districts.map((district) => ({
        ...district,
        id: scopeId(scope, district.id),
        parentId: district.parentId === null ? wrapper : scopeId(scope, district.parentId),
        rect: offsetRect(district.rect, dx, dy),
        ...(district.labelPlate ? { labelPlate: offsetRect(district.labelPlate, dx, dy) } : {}),
      })),
    ],
    blocks: model.blocks.map((block) => ({
      ...block,
      districtId: block.districtId === '' ? wrapper : scopeId(scope, block.districtId),
      rect: offsetRect(block.rect, dx, dy),
      ...(block.lot ? { lot: offsetRect(block.lot, dx, dy) } : {}),
    })),
    buildings: model.buildings.map((building) => ({
      ...building,
      rect: offsetRect(building.rect, dx, dy),
    })),
    roads: model.roads,
    streets: (model.streets ?? []).map((street) => ({
      ...street,
      id: scopeId(scope, street.id),
      districtId: street.districtId === null ? wrapper : scopeId(scope, street.districtId),
      rect: offsetRect(street.rect, dx, dy),
    })),
    plazas: (model.plazas ?? []).map((plaza) => ({
      ...plaza,
      id: scopeId(scope, plaza.id),
      districtId: plaza.districtId === null ? wrapper : scopeId(scope, plaza.districtId),
      rect: offsetRect(plaza.rect, dx, dy),
    })),
  };
}

function unionBounds(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Compose the Code and Tests cities without running the layout engine over
 * their combined files. Code keeps its persisted coordinates. Tests receives
 * one rigid translation to sit beside it, so every lot, street, plaza,
 * building, and label keeps exactly the geometry it has in the Tests view.
 */
export function composeFileMapScopes(
  code: FileMapResponse,
  tests: FileMapResponse,
): FileMapResponse {
  const hasCode = code.blocks.length > 0;
  const hasTests = tests.blocks.length > 0;

  let testsDx = 0;
  let testsDy = 0;
  if (hasCode && hasTests) {
    testsDx = code.bounds.x + code.bounds.w + SCOPE_GAP - tests.bounds.x;
    testsDy = code.bounds.y + code.bounds.h / 2 - (tests.bounds.y + tests.bounds.h / 2);
  }

  const codePart = hasCode ? translateScope(code, 'core', 'Code', 0, 0) : null;
  const testsPart = hasTests ? translateScope(tests, 'tests', 'Tests', testsDx, testsDy) : null;
  const parts = [codePart, testsPart].filter((part) => part !== null);
  const bounds = unionBounds(parts.flatMap((part) => [part.districts[0]!.rect]));

  return {
    domain: 'code:all',
    root: code.root || tests.root,
    bounds,
    builtAt: code.builtAt > tests.builtAt ? code.builtAt : tests.builtAt,
    indexed: code.indexed || tests.indexed,
    districts: parts.flatMap((part) => part.districts),
    blocks: parts.flatMap((part) => part.blocks),
    buildings: parts.flatMap((part) => part.buildings),
    roads: parts.flatMap((part) => part.roads),
    streets: parts.flatMap((part) => part.streets ?? []),
    plazas: parts.flatMap((part) => part.plazas ?? []),
    // Per-block urbanity rides the block spread untouched, which gives the
    // right picture for free: the loosely packed Tests city reads as a village
    // beside the denser Code city. The map-level field is Code's verbatim —
    // Code is the untranslated half (dx = dy = 0), so its center needs no
    // offset — falling back to Tests when there is no code at all.
    ...((code.urbanity ?? tests.urbanity) ? { urbanity: (code.urbanity ?? tests.urbanity)! } : {}),
    ...((code.signals ?? tests.signals) ? { signals: code.signals ?? tests.signals } : {}),
  };
}

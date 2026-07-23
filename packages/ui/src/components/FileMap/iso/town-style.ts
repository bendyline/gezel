import type { MapBlock, MapBuilding } from '@bendyline/gezel';
import { hash32, seeded } from '../seed.js';

/** Architectural vocabulary for the isometric renderer. Deliberately drawn
 * from a small 1890–1915 town rather than a modern skyline. */
export type TownArchetype =
  | 'boarding-house'
  | 'cottage'
  | 'townhouse'
  | 'corner-shop'
  | 'market-hall'
  | 'inn'
  | 'guildhall'
  | 'library'
  | 'schoolhouse'
  | 'foundry'
  | 'rail-depot'
  | 'workshop';

export type TownRoof = 'gable' | 'hip' | 'mansard' | 'sawtooth' | 'shed';
export type RidgeAxis = 'x' | 'y';

export interface TownStyle {
  archetype: TownArchetype;
  roof: TownRoof;
  ridge: RidgeAxis;
  storeys: number;
  bays: number;
  chimneys: number;
  dormers: number;
  awning: boolean;
  cupola: boolean;
  clock: boolean;
  sawteeth: number;
  /** Stable seed used by small details such as lit windows and stack spacing. */
  seed: number;
}

const RESIDENTIAL: readonly TownArchetype[] = ['cottage', 'townhouse', 'boarding-house'];
const COMMERCIAL: readonly TownArchetype[] = ['corner-shop', 'inn', 'market-hall'];
const CIVIC: readonly TownArchetype[] = ['library', 'schoolhouse', 'guildhall'];
const INDUSTRIAL: readonly TownArchetype[] = ['workshop', 'rail-depot', 'foundry'];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

function ridgeFor(block: Pick<MapBlock, 'rect'>, random: () => number): RidgeAxis {
  const { w, h } = block.rect;
  if (w > h * 1.18) return 'x';
  if (h > w * 1.18) return 'y';
  return random() < 0.5 ? 'x' : 'y';
}

function roofFor(archetype: TownArchetype, random: () => number): TownRoof {
  switch (archetype) {
    case 'cottage':
    case 'schoolhouse':
    case 'rail-depot':
      return 'gable';
    case 'townhouse':
    case 'corner-shop':
      return random() < 0.55 ? 'mansard' : 'gable';
    case 'boarding-house':
    case 'inn':
    case 'library':
    case 'guildhall':
      return random() < 0.7 ? 'hip' : 'mansard';
    case 'market-hall':
      return random() < 0.65 ? 'gable' : 'hip';
    case 'foundry':
    case 'workshop':
      return 'sawtooth';
  }
}

function isTestFile(id: string): boolean {
  return /(?:^|[/_.-])(?:test|tests|spec|specs)(?:[/_.-]|$)/i.test(id);
}

/**
 * Resolve a file into a deterministic period building. The path is the seed
 * anchor; code facts select the architectural family and visible details:
 *
 * - dependency zone → residential / shopfront / civic / workshop family
 * - landmark → guildhall with a clock cupola
 * - test path → schoolhouse (unless the file is industrial)
 * - levels → storeys, symbols → facade bays/dormers, churn → extra chimneys
 *
 * No render-time randomness is used, so a file keeps its silhouette across
 * frames, reloads, and machines while still evolving when its role changes.
 */
export function townStyleForBlock(block: MapBlock): TownStyle {
  const seed = hash32(`town-1910:v1:${block.id}`);
  const random = seeded(seed);
  const zone = block.health?.zone ?? 'residential';
  let archetype: TownArchetype;
  if (block.landmark) archetype = 'guildhall';
  else if (isTestFile(block.id) && zone !== 'industrial') archetype = 'schoolhouse';
  else if (zone === 'commercial') archetype = pick(COMMERCIAL, random);
  else if (zone === 'civic') archetype = pick(CIVIC, random);
  else if (zone === 'industrial') archetype = pick(INDUSTRIAL, random);
  else archetype = pick(RESIDENTIAL, random);

  const storeys = Math.max(1, Math.min(5, block.levels ?? 1));
  const symbolBays = Math.ceil(Math.sqrt(Math.max(1, block.buildingCount)));
  const bays = Math.max(1, Math.min(5, symbolBays + (random() < 0.45 ? 1 : 0)));
  const isIndustrial = zone === 'industrial';
  const isCommercial = zone === 'commercial';
  const isCivic = zone === 'civic' || block.landmark === true;
  const churn = block.health?.churn ?? 0;
  const roof = roofFor(archetype, random);

  return {
    archetype,
    roof,
    ridge: ridgeFor(block, random),
    storeys,
    bays,
    chimneys: isIndustrial
      ? 1 + Math.min(2, Math.floor(churn / 8) + (random() < 0.5 ? 1 : 0))
      : archetype === 'cottage' || archetype === 'inn' || archetype === 'boarding-house'
        ? 1 + (random() < 0.25 ? 1 : 0)
        : 0,
    dormers:
      roof === 'mansard' || (roof === 'gable' && storeys >= 3)
        ? Math.min(3, Math.max(1, Math.floor(bays / 2)))
        : 0,
    awning: isCommercial && archetype !== 'market-hall',
    cupola: isCivic && (block.landmark === true || random() < 0.5),
    clock: block.landmark === true,
    sawteeth: roof === 'sawtooth' ? Math.max(2, Math.min(5, bays)) : 0,
    seed,
  };
}

/** Period treatment for a symbol building inside a file's courtyard. Symbol
 * kind picks the useful visual distinction; the parent file supplies era and
 * zoning context. */
export function townStyleForSymbol(symbol: MapBuilding, parent: MapBlock): TownStyle {
  const seed = hash32(`town-1910:symbol:v1:${symbol.id}`);
  const random = seeded(seed);
  const kind = symbol.kind.toLowerCase();
  const classLike = /class|interface|struct|enum|trait|type/.test(kind);
  const moduleLike = /module|namespace|package/.test(kind);
  const industrial = parent.health?.zone === 'industrial';
  const roof: TownRoof = industrial
    ? random() < 0.65
      ? 'sawtooth'
      : 'shed'
    : moduleLike
      ? 'mansard'
      : classLike
        ? random() < 0.55
          ? 'hip'
          : 'gable'
        : random() < 0.7
          ? 'gable'
          : 'shed';
  const storeys = Math.max(1, Math.min(3, 1 + Math.round(symbol.height * 2)));
  const bays = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, symbol.lines ?? 1)) / 3)));
  return {
    archetype: industrial ? 'workshop' : classLike ? 'townhouse' : 'cottage',
    roof,
    ridge: parent.rect.w >= parent.rect.h ? 'x' : 'y',
    storeys,
    bays,
    chimneys: industrial && random() < 0.55 ? 1 : 0,
    dormers: roof === 'mansard' && symbol.height > 0.55 ? 1 : 0,
    awning: parent.health?.zone === 'commercial' && !classLike,
    cupola: parent.landmark === true && moduleLike,
    clock: false,
    sawteeth: roof === 'sawtooth' ? 2 + (random() < 0.4 ? 1 : 0) : 0,
    seed,
  };
}

export function townArchetypeLabel(style: TownStyle): string {
  return style.archetype.replace('-', ' ');
}

import type { FileUse, MapBlock, MapBuilding } from '@bendyline/gezel';
import { blockUse } from '../file-use.js';
import { type MaterialPair, materialsFor } from '../material.js';
import { hash32, seeded } from '../seed.js';
import { type UrbanityBand, bandOf } from '../urbanity.js';

/**
 * Architectural vocabulary for the Village — a settlement from roughly
 * **1890–1915**, never a modern skyline.
 *
 * The vocabulary is a 3×4 grid: four dependency-role families (the `zone`)
 * crossed with three urbanity registers (the `settlement` band). Each family
 * table holds exactly three entries, index-aligned small → mid → large, which
 * buys a property worth naming: **a file keeps its size-role slot across bands
 * and only changes regional idiom.** A mid-size commercial file is an `inn` in
 * the town band and a `hotel` in the city band — the same building, in a
 * different kind of place.
 *
 * ## Why the seed stream is fragile, and the three rules that protect it
 *
 * A file's building is its identity on the map; users navigate by "the sawtooth
 * foundry by the plaza." Everything derives from one seeded PRNG stream, whose
 * *shape* is therefore load-bearing:
 *
 * - **A. Never change the length or order of a family table.** `pick()` is
 *   `items[floor(random() * len)]`, so appending a fourth member to a table
 *   remaps every file in that family. New architecture goes in a *new* table
 *   selected before the call — which is exactly what the band does, consuming
 *   no extra draw.
 * - **B. The main stream is append-only.** It runs `pick`, `bays`, then
 *   `roofFor` / `ridgeFor` / `chimneys` / `cupola`, several of which draw
 *   conditionally. Anything new must come strictly after the `cupola` draw.
 * - **C. Prefer salted sub-streams (`SEED_SALT`) over the main stream.** They
 *   are order-independent by construction, so adding a massing draw cannot
 *   perturb material selection. This is the default for new fields, and it is
 *   what makes rule B rarely have to carry any weight.
 *
 * `town-style.golden.test.ts` pins twenty real files against these rules.
 */

export type TownArchetype =
  // village
  | 'cottage-row'
  | 'farmhouse'
  | 'village-shop'
  | 'smithy'
  | 'market-cross'
  | 'chapel'
  | 'parish-hall'
  | 'barn'
  | 'mill'
  | 'kiln'
  // town
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
  | 'workshop'
  // city
  | 'terrace-house'
  | 'tenement'
  | 'mansion-flat'
  | 'shopfront-block'
  | 'hotel'
  | 'arcade'
  | 'bank'
  | 'institute'
  | 'town-hall'
  | 'warehouse'
  | 'works'
  | 'terminus'
  // by use, in every register: data is farmland, stylesheets are gardens,
  // configuration is the municipal machinery
  | 'field'
  | 'park'
  | 'signal-tower';

export type TownRoof =
  | 'gable'
  | 'hip'
  | 'mansard'
  | 'sawtooth'
  | 'shed'
  | 'thatch'
  | 'half-hip'
  | 'catslide'
  | 'parapet'
  | 'monitor'
  | 'pyramid'
  | 'barrel'
  | 'conical';

export type RidgeAxis = 'x' | 'y';

/** Which facade fronts the street: `eave` = ridge runs along it (terraces,
 *  shopfronts), `gable` = the gable end faces it (cottages, chapels). */
export type EavesFront = 'eave' | 'gable';

/** Ground-floor treatment — the strongest single "what is this building for"
 *  cue at street zoom. */
export type GroundFloor = 'plain' | 'shopfront' | 'arcade' | 'cart-door' | 'portico';

/** What sits on the ridge or apex. */
export type RoofCap = 'none' | 'cupola' | 'bellcote' | 'clock-tower' | 'finial' | 'lantern';

export type MassingKind = 'none' | 'ell' | 'setback';

export interface Massing {
  kind: MassingKind;
  /** Normalized sub-rect within the block footprint, in [0,1]. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Height as a fraction of the main mass. */
  height: number;
  /** True when the wing sits toward N/W and so paints BEFORE the main mass. */
  behind: boolean;
}

const NO_MASSING: Massing = {
  kind: 'none',
  u0: 0,
  v0: 0,
  u1: 0,
  v1: 0,
  height: 0,
  behind: false,
};

export interface TownTrim {
  cornice: boolean;
  parapet: boolean;
  stringCourse: boolean;
  quoins: boolean;
}

export interface TownStyle {
  archetype: TownArchetype;
  /** What the file is for — decides between a building, a field, and a park. */
  use: FileUse;
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
  /** The urbanity register this building was resolved in. */
  band: UrbanityBand;
  eaves: EavesFront;
  ground: GroundFloor;
  cap: RoofCap;
  trim: TownTrim;
  /** Wall and roof materials. Applied only outside the age lens and outside
   *  city tier — see `prismColors`. */
  material: MaterialPair;
  /** Secondary mass, if any. `rect` is normalized within the block footprint
   *  and always strictly inside it: `iso/depth.ts` sorts footprints only, so a
   *  mass crossing into the lot margin could be occluded by a block the depth
   *  sort believes is behind it. */
  massing: Massing;
  /** Roof headroom multiplier for anything that builds taller than an ordinary
   *  roof — clock towers, kiln cones, lanterns. Culling, hit-testing, and the
   *  issue-marker anchor all read it through `roofHeadroom`; drawing past the
   *  declared budget causes scroll pop-in and dead clicks. Default 1. */
  roofFactor?: number;
}

/**
 * Salts for independent sub-streams. Every new derived field should take one
 * rather than drawing from the main stream — see rule C. Two of these predate
 * the grid and are kept at their original values so existing facade and roof
 * furniture detail is unchanged.
 */
export const SEED_SALT = {
  FACADE: 0xa18f35cd,
  ROOF_FURNITURE: 0x61c88647,
  MASSING: 0x9e3779b9,
  MATERIAL: 0x85ebca6b,
  TRIM: 0xc2b2ae35,
  GROUND: 0x27d4eb2f,
} as const;

type Family = 'residential' | 'commercial' | 'civic' | 'industrial';

/**
 * Rule A in data form. The `town` row is the original vocabulary, in its
 * original order — those three arrays must never be reordered or resized.
 */
const FAMILY_TABLE: Record<UrbanityBand, Record<Family, readonly TownArchetype[]>> = {
  village: {
    residential: ['cottage', 'cottage-row', 'farmhouse'],
    commercial: ['village-shop', 'smithy', 'market-cross'],
    civic: ['chapel', 'schoolhouse', 'parish-hall'],
    industrial: ['barn', 'mill', 'kiln'],
  },
  town: {
    residential: ['cottage', 'townhouse', 'boarding-house'],
    commercial: ['corner-shop', 'inn', 'market-hall'],
    civic: ['library', 'schoolhouse', 'guildhall'],
    industrial: ['workshop', 'rail-depot', 'foundry'],
  },
  city: {
    residential: ['terrace-house', 'tenement', 'mansion-flat'],
    commercial: ['shopfront-block', 'hotel', 'arcade'],
    civic: ['bank', 'institute', 'town-hall'],
    industrial: ['warehouse', 'works', 'terminus'],
  },
};

interface ArchetypeSpec {
  /** Candidate roofs. A single entry consumes NO draw — see `roofFor`. */
  roofs: readonly TownRoof[];
  eaves: EavesFront;
  ground: GroundFloor;
  cap: RoofCap;
  trim: Partial<TownTrim>;
  /** Declared roof headroom when the cap builds past an ordinary roof. */
  roofFactor?: number;
}

const NO_TRIM: TownTrim = { cornice: false, parapet: false, stringCourse: false, quoins: false };

/**
 * Headroom for the roof form plus anything that breaks its skyline.
 *
 * Chimneys used to be painted *down* the roof, so the ordinary roof budget was
 * accidentally enough. Once stacks stand upright, culling and hit-testing have
 * to know about them just as they do a clock tower. Keep the allowance here,
 * beside style resolution, rather than hiding it in the painter.
 */
function resolvedRoofFactor(roof: TownRoof, cap: RoofCap, chimneys: number, declared = 1): number {
  const roofShape = roof === 'conical' ? 2.1 : roof === 'pyramid' ? 1.35 : 1;
  let factor = Math.max(declared, roofShape);
  if (chimneys > 0) factor = Math.max(factor, roofShape + 0.68);
  const capExtra: Partial<Record<RoofCap, number>> = {
    cupola: 0.78,
    bellcote: 0.62,
    'clock-tower': 0.78,
    finial: 0.4,
    lantern: 0.56,
  };
  factor = Math.max(factor, roofShape + (capExtra[cap] ?? 0));
  return factor;
}

/** Roof geometry sometimes names the material outright. A bottle kiln cannot
 * be glazed iron because the independent material stream happened to say so. */
function resolvedMaterials(
  seed: number,
  band: UrbanityBand,
  industrial: boolean,
  roof: TownRoof,
): MaterialPair {
  const material = materialsFor(seed ^ SEED_SALT.MATERIAL, band, industrial);
  if (roof === 'thatch') material.roof = 'thatch';
  else if (roof === 'conical') material.roof = 'brick';
  else if (roof === 'barrel') material.roof = 'glass';
  return material;
}

/**
 * One data table instead of a switch per property. Village forms are gable-end
 * and untrimmed; city forms are eave-end, corniced, and often parapeted — which
 * is most of what makes the two registers read differently at district zoom.
 */
const ARCHETYPE_SPEC: Record<TownArchetype, ArchetypeSpec> = {
  // ── village ──────────────────────────────────────────────────────────────
  cottage: { roofs: ['gable'], eaves: 'gable', ground: 'plain', cap: 'none', trim: {} },
  'cottage-row': {
    roofs: ['thatch', 'gable'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: {},
  },
  farmhouse: {
    roofs: ['catslide', 'half-hip'],
    eaves: 'gable',
    ground: 'plain',
    cap: 'finial',
    trim: {},
  },
  'village-shop': {
    roofs: ['gable', 'catslide'],
    eaves: 'gable',
    ground: 'shopfront',
    cap: 'none',
    trim: {},
  },
  smithy: {
    roofs: ['shed', 'catslide'],
    eaves: 'eave',
    ground: 'cart-door',
    cap: 'none',
    trim: {},
  },
  'market-cross': {
    roofs: ['pyramid'],
    eaves: 'gable',
    ground: 'arcade',
    cap: 'finial',
    trim: {},
  },
  chapel: { roofs: ['gable'], eaves: 'gable', ground: 'plain', cap: 'bellcote', trim: {} },
  'parish-hall': {
    roofs: ['half-hip', 'gable'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: {},
  },
  barn: {
    roofs: ['gable', 'catslide'],
    eaves: 'gable',
    ground: 'cart-door',
    cap: 'none',
    trim: {},
  },
  mill: { roofs: ['monitor', 'gable'], eaves: 'eave', ground: 'cart-door', cap: 'none', trim: {} },
  kiln: {
    roofs: ['conical'],
    eaves: 'gable',
    ground: 'cart-door',
    cap: 'none',
    trim: {},
    roofFactor: 1.6,
  },

  // ── town (original vocabulary) ───────────────────────────────────────────
  'boarding-house': {
    roofs: ['hip', 'mansard'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: { cornice: true },
  },
  townhouse: {
    roofs: ['mansard', 'gable'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: { cornice: true, stringCourse: true },
  },
  'corner-shop': {
    roofs: ['mansard', 'gable'],
    eaves: 'eave',
    ground: 'shopfront',
    cap: 'none',
    trim: { cornice: true },
  },
  'market-hall': {
    roofs: ['gable', 'hip'],
    eaves: 'eave',
    ground: 'arcade',
    cap: 'none',
    trim: { cornice: true },
  },
  inn: {
    roofs: ['hip', 'mansard'],
    eaves: 'eave',
    ground: 'shopfront',
    cap: 'none',
    trim: { cornice: true },
  },
  guildhall: {
    roofs: ['hip', 'mansard'],
    eaves: 'eave',
    ground: 'portico',
    cap: 'cupola',
    trim: { cornice: true, quoins: true },
  },
  library: {
    roofs: ['hip', 'mansard'],
    eaves: 'eave',
    ground: 'portico',
    cap: 'cupola',
    trim: { cornice: true, quoins: true },
  },
  schoolhouse: { roofs: ['gable'], eaves: 'gable', ground: 'plain', cap: 'bellcote', trim: {} },
  foundry: { roofs: ['sawtooth'], eaves: 'eave', ground: 'cart-door', cap: 'none', trim: {} },
  'rail-depot': { roofs: ['gable'], eaves: 'eave', ground: 'arcade', cap: 'none', trim: {} },
  workshop: { roofs: ['sawtooth'], eaves: 'eave', ground: 'cart-door', cap: 'none', trim: {} },

  // ── city ─────────────────────────────────────────────────────────────────
  'terrace-house': {
    roofs: ['parapet', 'mansard'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: { cornice: true, parapet: true, stringCourse: true },
  },
  tenement: {
    roofs: ['mansard', 'parapet'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: { cornice: true, stringCourse: true },
  },
  'mansion-flat': {
    roofs: ['mansard', 'hip'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: { cornice: true, stringCourse: true, quoins: true },
  },
  'shopfront-block': {
    roofs: ['parapet', 'mansard'],
    eaves: 'eave',
    ground: 'shopfront',
    cap: 'none',
    trim: { cornice: true, parapet: true, stringCourse: true },
  },
  hotel: {
    roofs: ['mansard', 'hip'],
    eaves: 'eave',
    ground: 'shopfront',
    cap: 'lantern',
    trim: { cornice: true, stringCourse: true, quoins: true },
    roofFactor: 1.3,
  },
  arcade: {
    roofs: ['barrel', 'monitor'],
    eaves: 'eave',
    ground: 'arcade',
    cap: 'none',
    trim: { cornice: true, parapet: true },
  },
  bank: {
    roofs: ['parapet', 'hip'],
    eaves: 'eave',
    ground: 'portico',
    cap: 'none',
    trim: { cornice: true, parapet: true, quoins: true },
  },
  institute: {
    roofs: ['hip', 'parapet'],
    eaves: 'eave',
    ground: 'portico',
    cap: 'cupola',
    trim: { cornice: true, quoins: true },
  },
  'town-hall': {
    roofs: ['hip', 'mansard'],
    eaves: 'eave',
    ground: 'portico',
    cap: 'clock-tower',
    trim: { cornice: true, quoins: true, stringCourse: true },
    roofFactor: 1.6,
  },
  warehouse: {
    roofs: ['monitor', 'gable'],
    eaves: 'eave',
    ground: 'cart-door',
    cap: 'none',
    trim: { cornice: true, parapet: true },
  },
  works: {
    roofs: ['sawtooth'],
    eaves: 'eave',
    ground: 'cart-door',
    cap: 'none',
    trim: { parapet: true },
  },
  terminus: {
    roofs: ['barrel', 'monitor'],
    eaves: 'eave',
    ground: 'arcade',
    cap: 'none',
    trim: { cornice: true, parapet: true },
  },

  // ── by use ───────────────────────────────────────────────────────────────
  // A field and a park are not buildings; their roof/eaves entries only keep
  // the struct total so the renderer contract tests can drive them. The
  // painters branch on the archetype before any roof is drawn.
  field: {
    roofs: ['shed'],
    eaves: 'eave',
    ground: 'plain',
    cap: 'none',
    trim: {},
    roofFactor: 1.4,
  },
  park: { roofs: ['hip'], eaves: 'eave', ground: 'plain', cap: 'none', trim: {}, roofFactor: 2.2 },
  // The control tower: a squat municipal block under a parapet, with the
  // glazed cab on the roof. Declares the cab's height like any lantern.
  'signal-tower': {
    roofs: ['parapet'],
    eaves: 'eave',
    ground: 'portico',
    cap: 'lantern',
    trim: { cornice: true, parapet: true, quoins: true },
    roofFactor: 1.9,
  },
};

/** The archetype a non-code use resolves to, in every register. */
const USE_ARCHETYPE: Partial<Record<FileUse, TownArchetype>> = {
  data: 'field',
  style: 'park',
  config: 'signal-tower',
};

/** Every archetype, with the roofs and cap it can actually draw. Exported so
 *  tests can drive the full cross-product rather than hoping a sampled fixture
 *  happens to reach the tall forms. */
export function allArchetypeForms(): Array<{
  archetype: TownArchetype;
  roofs: readonly TownRoof[];
  cap: RoofCap;
  roofFactor: number;
}> {
  return (Object.keys(ARCHETYPE_SPEC) as TownArchetype[]).map((archetype) => {
    const spec = ARCHETYPE_SPEC[archetype];
    return {
      archetype,
      roofs: spec.roofs,
      cap: spec.cap,
      // The renderer contract test adds two stacks to every sampled form; give
      // it the same resolved headroom a real style receives.
      roofFactor: Math.max(
        ...spec.roofs.map((roof) => resolvedRoofFactor(roof, spec.cap, 2, spec.roofFactor)),
      ),
    };
  });
}

/** Archetypes that grow a secondary mass, and which kind. */
const MASSING_KIND: Partial<Record<TownArchetype, MassingKind>> = {
  farmhouse: 'ell',
  'parish-hall': 'ell',
  barn: 'ell',
  mill: 'ell',
  smithy: 'ell',
  guildhall: 'ell',
  library: 'ell',
  inn: 'ell',
  'rail-depot': 'ell',
  'mansion-flat': 'setback',
  tenement: 'setback',
  hotel: 'setback',
  bank: 'setback',
  institute: 'setback',
  'town-hall': 'setback',
  warehouse: 'setback',
};

/**
 * Resolve the secondary mass from its own salted sub-stream. Kept strictly
 * inside the footprint (see the `Massing` doc comment) and given its own draw
 * order flag so an N/W wing paints before the main block and an S/E wing after.
 */
function massingFor(archetype: TownArchetype, seed: number, storeys: number): Massing {
  const kind = MASSING_KIND[archetype];
  if (!kind) return NO_MASSING;
  const random = seeded(seed ^ SEED_SALT.MASSING);
  if (kind === 'setback') {
    // A top storey stepped in from the S and E fronts.
    if (storeys < 3) return NO_MASSING;
    return { kind, u0: 0.12, v0: 0.12, u1: 0.88, v1: 0.88, height: 1.22, behind: false };
  }
  // An ell on one of the four corners, half the footprint, one storey lower.
  const corner = Math.floor(random() * 4);
  const long = 0.46 + random() * 0.12;
  const behind = corner === 0 || corner === 3;
  const box =
    corner === 0
      ? { u0: 0.04, v0: 0.04, u1: 0.04 + long, v1: 0.52 }
      : corner === 1
        ? { u0: 0.96 - long, v0: 0.04, u1: 0.96, v1: 0.52 }
        : corner === 2
          ? { u0: 0.96 - long, v0: 0.48, u1: 0.96, v1: 0.96 }
          : { u0: 0.04, v0: 0.48, u1: 0.04 + long, v1: 0.96 };
  return { kind, ...box, height: storeys <= 1 ? 0.72 : (storeys - 1) / storeys, behind };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

function ridgeFor(block: Pick<MapBlock, 'rect'>, random: () => number): RidgeAxis {
  const { w, h } = block.rect;
  if (w > h * 1.18) return 'x';
  if (h > w * 1.18) return 'y';
  return random() < 0.5 ? 'x' : 'y';
}

/**
 * Roof for an archetype. The **zero-draw fast path is load-bearing**: five of
 * the original town archetypes (cottage, schoolhouse, rail-depot, foundry,
 * workshop) consumed no draw here, so turning their single roof into a weighted
 * pick would silently reshuffle every file that has one. See rule B.
 */
function roofFor(archetype: TownArchetype, random: () => number): TownRoof {
  const roofs = ARCHETYPE_SPEC[archetype].roofs;
  if (roofs.length === 1) return roofs[0]!;
  // The original two-candidate probabilities, preserved: the town archetypes
  // that used 0.55/0.7/0.65 splits keep them via the ordering in the spec.
  return random() < TWO_ROOF_BIAS[archetype]! ? roofs[0]! : roofs[1]!;
}

/** First-candidate probability for every multi-roof archetype. The town
 *  entries reproduce the pre-grid constants exactly. */
const TWO_ROOF_BIAS: Partial<Record<TownArchetype, number>> = {
  townhouse: 0.55,
  'corner-shop': 0.55,
  'boarding-house': 0.7,
  inn: 0.7,
  library: 0.7,
  guildhall: 0.7,
  'market-hall': 0.65,
  // New forms: a plain majority for the signature roof of each archetype.
  'cottage-row': 0.6,
  farmhouse: 0.55,
  'village-shop': 0.65,
  smithy: 0.6,
  'parish-hall': 0.6,
  barn: 0.7,
  mill: 0.6,
  'terrace-house': 0.6,
  tenement: 0.55,
  'mansion-flat': 0.6,
  'shopfront-block': 0.65,
  hotel: 0.6,
  arcade: 0.7,
  bank: 0.6,
  institute: 0.6,
  'town-hall': 0.6,
  warehouse: 0.6,
  terminus: 0.65,
};

function isTestFile(id: string): boolean {
  return /(?:^|[/_.-])(?:test|tests|spec|specs)(?:[/_.-]|$)/i.test(id);
}

/** The civic landmark of each band. */
const LANDMARK_ARCHETYPE: Record<UrbanityBand, TownArchetype> = {
  village: 'parish-hall',
  town: 'guildhall',
  city: 'town-hall',
};

/**
 * Resolve a file into a deterministic period building. The path is the seed
 * anchor; code facts select the architectural family and visible details:
 *
 * - dependency zone → residential / shopfront / civic / workshop family
 * - urbanity band → which register of that family (village / town / city)
 * - landmark → the band's civic landmark, clock-topped in the city
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
  const band = bandOf(block);
  const table = FAMILY_TABLE[band];
  const use = blockUse(block);

  // Use comes first: a JSON fixture under __tests__ is a field, not a
  // schoolhouse, and a package.json that happens to be a landmark is still
  // the signal tower. These branches consume no draw, like the test branch.
  let archetype: TownArchetype;
  const byUse = USE_ARCHETYPE[use];
  if (byUse) archetype = byUse;
  else if (block.landmark) archetype = LANDMARK_ARCHETYPE[band];
  else if (isTestFile(block.id) && zone !== 'industrial') archetype = 'schoolhouse';
  else archetype = pick(table[zone], random);

  const storeys = Math.max(1, Math.min(5, block.levels ?? 1));
  const symbolBays = Math.ceil(Math.sqrt(Math.max(1, block.buildingCount)));
  const rawBays = Math.max(1, Math.min(5, symbolBays + (random() < 0.45 ? 1 : 0)));
  const isIndustrial = zone === 'industrial';
  const isCommercial = zone === 'commercial';
  const isCivic = zone === 'civic' || block.landmark === true;
  const churn = block.health?.churn ?? 0;
  const roof = roofFor(archetype, random);
  const ridge = ridgeFor(block, random);
  const spec = ARCHETYPE_SPEC[archetype];

  // Band adjustments are POST-HOC and consume no draw (rule B): a city terrace
  // wants a tight bay rhythm, a village cottage a sparse one.
  const bays =
    band === 'city'
      ? Math.max(1, Math.min(6, Math.round(rawBays * 1.4)))
      : band === 'village'
        ? Math.min(3, rawBays)
        : rawBays;

  // Every village house and shop was heated by a hearth, and a stack against
  // the sky is the most recognizable period silhouette element there is —
  // village buildings without one read as modern sheds.
  //
  // Scoped to the village band on purpose: the town row is what the golden
  // fixtures pin, and this branch consumes a draw, so widening it there would
  // shift every downstream value.
  const hearth =
    archetype === 'cottage' ||
    archetype === 'inn' ||
    archetype === 'boarding-house' ||
    (band === 'village' && !isCivic);
  const chimneys = isIndustrial
    ? 1 + Math.min(2, Math.floor(churn / 8) + (random() < 0.5 ? 1 : 0))
    : hearth
      ? 1 + (random() < 0.25 ? 1 : 0)
      : 0;
  const cupola = isCivic && (block.landmark === true || random() < 0.5);
  // ── main stream ends here; nothing below may draw from `random` ──────────

  const cap = spec.cap === 'cupola' && !cupola ? 'none' : spec.cap;
  const resolvedChimneys =
    chimneys === 0 && band === 'city' && !isIndustrial && storeys >= 3
      ? // City terraces carry stacks on the party-wall line rather than the
        // seeded one-or-two of a cottage. Derived from bays, so no new draw.
        Math.max(1, Math.min(3, Math.floor(bays / 2)))
      : chimneys;
  const roofFactor = resolvedRoofFactor(roof, cap, resolvedChimneys, spec.roofFactor);

  return {
    archetype,
    use,
    roof,
    ridge,
    storeys,
    bays,
    chimneys: resolvedChimneys,
    dormers:
      roof === 'mansard' || (roof === 'gable' && storeys >= 3)
        ? Math.min(3, Math.max(1, Math.floor(bays / 2)))
        : 0,
    awning: isCommercial && archetype !== 'market-hall',
    cupola,
    clock: block.landmark === true,
    sawteeth: roof === 'sawtooth' ? Math.max(2, Math.min(5, bays)) : 0,
    seed,
    band,
    eaves: spec.eaves,
    ground: spec.ground,
    cap,
    trim: { ...NO_TRIM, ...spec.trim },
    material: resolvedMaterials(seed, band, isIndustrial, roof),
    massing: massingFor(archetype, seed, storeys),
    ...(roofFactor !== 1 ? { roofFactor } : {}),
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
  const band = bandOf(parent);

  // Symbol minis get the SAME vocabulary as file buildings, not a reduced one.
  // In a codebase where most files carry symbols, these campuses are the
  // overwhelming majority of what a user actually sees — giving them three
  // archetypes while files got thirty-four made the whole settlement read as
  // rows of identical sheds.
  //
  // Symbol kind picks the family, so a campus is a legible little street:
  // classes and structs are the dwellings, functions and methods the shopfronts
  // that call on them, modules the civic buildings. An industrial parent
  // overrides everything — a foundry yard is sheds all the way down.
  const family: Family = industrial
    ? 'industrial'
    : moduleLike
      ? 'civic'
      : classLike
        ? 'residential'
        : 'commercial';
  // The slot within the family comes from the symbol's SIZE, not from a coin.
  // Family tables are ordered small → mid → large, so a one-line helper is a
  // corner shop and a 300-line orchestrator is the market hall — which reads
  // correctly and, just as importantly, stops the large forms from flooding a
  // yard. Uniform picking put seven market crosses in one file.
  const table = FAMILY_TABLE[band][family];
  const slot = symbol.height < 0.4 ? 0 : symbol.height < 0.72 ? 1 : 2;
  const archetype = table[Math.min(table.length - 1, slot)]!;
  const roof = roofFor(archetype, random);
  const storeys = Math.max(1, Math.min(3, 1 + Math.round(symbol.height * 2)));
  const bays = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(1, symbol.lines ?? 1)) / 3)));
  const spec = ARCHETYPE_SPEC[archetype];
  // A tower on a mini would be absurd; everything else in the cap vocabulary
  // reads fine at campus scale, and the draw path already sizes caps to the
  // headroom they are given.
  const cap: RoofCap = spec.cap === 'clock-tower' ? 'cupola' : spec.cap;
  // Preserve the original main-stream order: ridge → chimneys → sawteeth.
  // Furniture headroom is derived only after those draws are complete.
  const ridge = ridgeFor(symbol, random);
  const chimneys =
    industrial || archetype === 'cottage' || archetype === 'farmhouse' || archetype === 'inn'
      ? 1 + (random() < 0.3 ? 1 : 0)
      : 0;
  const sawteeth = roof === 'sawtooth' ? 2 + (random() < 0.4 ? 1 : 0) : 0;
  const roofFactor = resolvedRoofFactor(roof, cap, chimneys, spec.roofFactor);
  return {
    archetype,
    use: 'code',
    roof,
    // Per-symbol, not the parent's. Sharing one ridge axis across a campus
    // pointed every roof the same way, which is most of why a file read as one
    // extruded mass rather than a row of separate buildings.
    ridge,
    storeys,
    bays,
    chimneys,
    dormers: roof === 'mansard' && symbol.height > 0.55 ? 1 : 0,
    awning: parent.health?.zone === 'commercial' && !classLike,
    cupola: cap === 'cupola',
    clock: false,
    sawteeth,
    seed,
    band,
    eaves: spec.eaves,
    ground: spec.ground,
    cap,
    // Trim is gated on projected width at draw time, so a mini that is big
    // enough on screen earns its cornice and a tiny one silently skips it.
    trim: { ...NO_TRIM, ...spec.trim },
    material: resolvedMaterials(seed, band, industrial, roof),
    // A wing inside a symbol footprint would be indistinguishable noise.
    massing: NO_MASSING,
    ...(roofFactor !== 1 ? { roofFactor } : {}),
  };
}

export function townArchetypeLabel(style: TownStyle): string {
  return style.archetype.replace(/-/g, ' ');
}

/** Human-readable register for the file inspector, e.g. "village smithy". */
export function townStyleLabel(style: TownStyle): string {
  return `${style.band} ${townArchetypeLabel(style)}`;
}

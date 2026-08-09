import { type MaterialKey, applyMaterial, hsl, wallHueKeep, wallLitDelta } from './material.js';
import { hueFromString } from './seed.js';

/**
 * Theme-aware city palette. Two flat-design cities: light is "parchment
 * daylight" (grass ground, warm paving), dark is "dusk" (near-black ground,
 * dim paving, amber accents). Depth comes from 2–3 tone steps per material;
 * street-tier construction grain is projected vector linework in
 * `iso/town-buildings.ts`, never a bitmap texture pasted over the canvas.
 */
export interface CityPalette {
  dark: boolean;
  /** Grass-toned ground plane behind everything. */
  ground: string;
  /** Paved fill of leaf districts (city blocks). */
  districtFill: string;
  /** Ancestor district outline. */
  districtStroke: string;
  /** Curb line around leaf districts. */
  curb: string;
  /** Sidewalk band just inside the curb. */
  sidewalk: string;
  districtLabel: string;
  label: string;
  /** Import-edge ribbons (not the paved streets — those use pavement tones). */
  road: string;
  roadMutual: string;
  /** Hairline block outline at flat/city zoom. */
  blockStroke: string;
  /** Single translucent tone for all building drop shadows. */
  shadow: string;
  /** Symbol-building roof / facade (monochrome; block roofs are lang-hued). */
  building: string;
  buildingFacade: string;
  /** Bare-earth ground for construction sites and vacant (tombstoned) lots. */
  earth: string;
  rubble: string;
  crane: string;
  newBlock: string;
  tombstone: string;
  selected: string;
  hover: string;
  /** Civic-landmark dome accent (and plaza ring). */
  domeAccent: string;
  /** Small architectural details shared by the period-building renderer. */
  window: string;
  windowLit: string;
  masonry: string;
  awning: string;
  /** Street pavement by tier (painted when the layout ships street rects). */
  pavementAvenue: string;
  pavementStreet: string;
  pavementLane: string;
  avenueDash: string;
  /** District label plate (iso label engine). */
  labelPlate: string;
  labelPlateStroke: string;
  /** Village ground and boundary tones — see iso/lots.ts. */
  hedge: string;
  fence: string;
  orchard: string;
  /** Street surfaces below macadam: village dirt lane, town cobble. */
  dirtLane: string;
  cobble: string;
  /** Market-stall awning on a village square. */
  stall: string;
}

export function buildPalette(dark: boolean): CityPalette {
  return dark
    ? {
        dark: true,
        ground: 'hsl(150 10% 12%)',
        districtFill: 'hsl(228 8% 15%)',
        districtStroke: '#34373f',
        curb: 'hsl(228 10% 28%)',
        sidewalk: 'hsl(228 7% 18%)',
        districtLabel: '#8b8f99',
        label: '#c9ccd4',
        road: '#4a4d56',
        roadMutual: '#6b7280',
        blockStroke: '#15161a',
        shadow: 'rgba(0, 0, 0, 0.38)',
        building: '#11141a',
        buildingFacade: '#04060a',
        earth: 'hsl(35 20% 22%)',
        rubble: 'hsl(30 6% 30%)',
        crane: 'hsl(38 80% 55%)',
        newBlock: '#3f7d4f',
        tombstone: '#55504a',
        selected: '#e0a062',
        hover: '#9aa0ad',
        domeAccent: 'hsl(42 60% 55%)',
        window: 'hsl(214 24% 16%)',
        windowLit: 'hsl(41 72% 61%)',
        masonry: 'hsl(18 24% 28%)',
        awning: 'hsl(8 48% 48%)',
        pavementAvenue: 'hsl(228 8% 24%)',
        pavementStreet: 'hsl(228 8% 21%)',
        pavementLane: 'hsl(228 8% 18%)',
        avenueDash: 'hsl(45 45% 48%)',
        labelPlate: 'hsl(228 10% 10% / 0.85)',
        labelPlateStroke: 'hsl(228 10% 34%)',
        hedge: 'hsl(128 22% 22%)',
        fence: 'hsl(36 16% 38%)',
        orchard: 'hsl(120 18% 20%)',
        dirtLane: 'hsl(32 16% 20%)',
        cobble: 'hsl(226 7% 22%)',
        stall: 'hsl(12 42% 42%)',
      }
    : {
        dark: false,
        ground: 'hsl(80 24% 86%)',
        districtFill: 'hsl(46 28% 89%)',
        districtStroke: 'hsl(44 16% 76%)',
        curb: 'hsl(44 14% 70%)',
        sidewalk: 'hsl(46 24% 92%)',
        districtLabel: '#7a715c',
        label: '#473f30',
        road: '#b3a98f',
        roadMutual: '#8a7f64',
        blockStroke: '#d8d0bd',
        shadow: 'rgba(70, 60, 35, 0.2)',
        building: '#ffffff',
        buildingFacade: '#d6cfbd',
        earth: 'hsl(36 35% 78%)',
        rubble: 'hsl(40 12% 72%)',
        crane: 'hsl(38 85% 55%)',
        newBlock: '#7bb98a',
        tombstone: '#c3bba9',
        selected: '#c9722e',
        hover: '#6f6651',
        domeAccent: 'hsl(42 65% 52%)',
        window: 'hsl(205 24% 39%)',
        windowLit: 'hsl(42 88% 70%)',
        masonry: 'hsl(18 26% 48%)',
        awning: 'hsl(8 52% 52%)',
        pavementAvenue: 'hsl(46 10% 72%)',
        pavementStreet: 'hsl(46 12% 78%)',
        pavementLane: 'hsl(46 14% 82%)',
        avenueDash: 'hsl(46 40% 94%)',
        labelPlate: 'hsl(46 30% 96% / 0.88)',
        labelPlateStroke: 'hsl(44 16% 72%)',
        hedge: 'hsl(122 26% 42%)',
        fence: 'hsl(38 20% 62%)',
        orchard: 'hsl(104 28% 68%)',
        dirtLane: 'hsl(34 24% 70%)',
        cobble: 'hsl(44 8% 74%)',
        stall: 'hsl(10 48% 58%)',
      };
}

/**
 * Age bucket for the age lens: 0 = this week, 1 = this month, 2 = this
 * quarter, 3 = older. Null when the block predates placement timestamps.
 */
export function ageBucket(placedAt: string | null | undefined, now: number): 0 | 1 | 2 | 3 | null {
  if (!placedAt) return null;
  const t = Date.parse(placedAt);
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, (now - t) / 86_400_000);
  if (days <= 7) return 0;
  if (days <= 30) return 1;
  if (days <= 90) return 2;
  return 3;
}

/** Roof / facade / roof-edge tones for one building. */
export interface RoofColors {
  roof: string;
  facade: string;
  edge: string;
}

// Warm single-hue ramp, newest brightest — the block "cools" as it ages. The
// facade rows drop lightness so the 3D form survives the age lens.
const AGE_ROOF_DARK = ['hsl(28 92% 58%)', 'hsl(28 70% 46%)', 'hsl(28 42% 35%)', 'hsl(28 16% 27%)'];
const AGE_FACADE_DARK = [
  'hsl(28 92% 44%)',
  'hsl(28 70% 34%)',
  'hsl(28 42% 26%)',
  'hsl(28 16% 20%)',
];
const AGE_EDGE_DARK = ['hsl(28 92% 68%)', 'hsl(28 70% 56%)', 'hsl(28 42% 44%)', 'hsl(28 16% 35%)'];
const AGE_ROOF_LIGHT = ['hsl(28 95% 55%)', 'hsl(28 82% 66%)', 'hsl(28 55% 77%)', 'hsl(28 25% 86%)'];
const AGE_FACADE_LIGHT = [
  'hsl(28 95% 42%)',
  'hsl(28 82% 52%)',
  'hsl(28 55% 63%)',
  'hsl(28 25% 72%)',
];
const AGE_EDGE_LIGHT = ['hsl(28 95% 66%)', 'hsl(28 82% 76%)', 'hsl(28 55% 85%)', 'hsl(28 25% 92%)'];

// Hues for the dominant languages are hand-picked so the skyline's biggest
// roof fields look deliberate; everything else quantizes to 12 slots.
const LANG_HUE: Record<string, number> = {
  typescript: 210,
  tsx: 210,
  javascript: 48,
  jsx: 48,
  python: 160,
  rust: 20,
  go: 190,
  css: 280,
  html: 15,
  markdown: 90,
};

/** Quantize to 12 hue slots so the roofscape reads as a curated set. */
export function roofHue(lang: string): number {
  const fixed = LANG_HUE[lang.toLowerCase()];
  if (fixed !== undefined) return fixed;
  return (Math.round(hueFromString(lang) / 30) * 30) % 360;
}

/**
 * Building colors for a block: language-hued roof over a darker facade, with
 * a light roof-edge highlight (NW light). Under the age lens the ramp color
 * takes over the same three roles so the 3D form survives the lens.
 */
export function roofColors(
  lang: string | null | undefined,
  p: CityPalette,
  age?: 0 | 1 | 2 | 3 | null,
): RoofColors {
  if (age !== null && age !== undefined) {
    return p.dark
      ? { roof: AGE_ROOF_DARK[age]!, facade: AGE_FACADE_DARK[age]!, edge: AGE_EDGE_DARK[age]! }
      : { roof: AGE_ROOF_LIGHT[age]!, facade: AGE_FACADE_LIGHT[age]!, edge: AGE_EDGE_LIGHT[age]! };
  }
  if (!lang) {
    return p.dark
      ? { roof: 'hsl(220 6% 40%)', facade: 'hsl(220 7% 27%)', edge: 'hsl(220 8% 50%)' }
      : { roof: 'hsl(46 12% 72%)', facade: 'hsl(46 12% 56%)', edge: 'hsl(46 16% 82%)' };
  }
  const hue = roofHue(lang);
  return p.dark
    ? { roof: `hsl(${hue} 34% 42%)`, facade: `hsl(${hue} 36% 28%)`, edge: `hsl(${hue} 40% 52%)` }
    : { roof: `hsl(${hue} 48% 70%)`, facade: `hsl(${hue} 42% 54%)`, edge: `hsl(${hue} 55% 80%)` };
}

/** Four-role prism colors for the iso renderer: NW-lit top, the SW wall in
 *  the facade tone, the SE wall a step darker, plus the edge highlight. */
export interface PrismColors {
  top: string;
  wallL: string;
  wallR: string;
  edge: string;
}

/** Lightness points a building may drift from its neighbours. Big enough to
 *  separate a terrace, small enough that a language field still reads as one
 *  color at district zoom. */
const TONE_JITTER = 5;

// SE-wall rows for the age ramp: the facade rows dropped ~7% lightness.
const AGE_WALLR_DARK = ['hsl(28 92% 37%)', 'hsl(28 70% 28%)', 'hsl(28 42% 21%)', 'hsl(28 16% 16%)'];
const AGE_WALLR_LIGHT = [
  'hsl(28 95% 35%)',
  'hsl(28 82% 45%)',
  'hsl(28 55% 56%)',
  'hsl(28 25% 65%)',
];

/** Optional material treatment for a building. Omitted ⇒ the pre-material
 *  colors, byte for byte, which is what keeps legacy payloads and the city-tier
 *  batcher unchanged. */
export interface MaterialTreatment {
  wall: MaterialKey;
  roof: MaterialKey;
  /** Continuous urbanity — how far the wall pulls off the language hue. */
  urbanity: number;
  /**
   * Per-building tonal jitter in [-1, 1], shifting lightness a few points.
   *
   * A single-language repository resolves to a single roof hue, so a street of
   * neighbours would otherwise be one flat color and read as one extruded mass
   * rather than as separate buildings. This is what separates them, without
   * lying about the language signal — the hue is untouched.
   */
  variance?: number;
}

export function prismColors(
  lang: string | null | undefined,
  p: CityPalette,
  age?: 0 | 1 | 2 | 3 | null,
  material?: MaterialTreatment,
): PrismColors {
  const base = roofColors(lang, p, age);
  // The age lens owns the whole surface: one clean color per file so its
  // recency signal stays legible. Material is deliberately not applied here.
  if (age !== null && age !== undefined) {
    const wallR = p.dark ? AGE_WALLR_DARK[age]! : AGE_WALLR_LIGHT[age]!;
    return { top: base.roof, wallL: base.facade, wallR, edge: base.edge };
  }
  if (!lang) {
    return {
      top: base.roof,
      wallL: base.facade,
      wallR: p.dark ? 'hsl(220 7% 20%)' : 'hsl(46 12% 46%)',
      edge: base.edge,
    };
  }
  const hue = roofHue(lang);
  if (!material) {
    return {
      top: base.roof,
      wallL: base.facade,
      wallR: p.dark ? `hsl(${hue} 36% 21%)` : `hsl(${hue} 42% 44%)`,
      edge: base.edge,
    };
  }
  // Roof keeps the language hue (hueKeep 1); walls pull toward their material
  // by however urban the ground is. `litDelta` is shared, so the roof/facade
  // lightness delta that carries the 3D reading survives untouched.
  const sat = p.dark ? { top: 34, wall: 36, edge: 40 } : { top: 48, wall: 42, edge: 55 };
  const lit = p.dark
    ? { top: 42, wallL: 28, wallR: 21, edge: 52 }
    : { top: 70, wallL: 54, wallR: 44, edge: 80 };
  const keep = wallHueKeep(material.urbanity);
  // Walls take their lightness shift relative to the roof's so a light wall
  // material can never climb into a dark roof and flatten the prism.
  const wallLit = wallLitDelta(material.wall, material.roof);
  // The jitter is applied EQUALLY to every surface, so it separates neighbours
  // without touching the roof/facade delta that carries the 3D reading.
  const j = Math.max(-1, Math.min(1, material.variance ?? 0)) * TONE_JITTER;
  return {
    top: hsl(applyMaterial({ h: hue, s: sat.top, l: lit.top + j }, material.roof, 1)),
    wallL: hsl(
      applyMaterial({ h: hue, s: sat.wall, l: lit.wallL + j }, material.wall, keep, wallLit),
    ),
    wallR: hsl(
      applyMaterial({ h: hue, s: sat.wall, l: lit.wallR + j }, material.wall, keep, wallLit),
    ),
    edge: hsl(applyMaterial({ h: hue, s: sat.edge, l: lit.edge + j }, material.roof, 1)),
  };
}

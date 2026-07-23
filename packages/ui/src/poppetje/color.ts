import { HAT_FELTS } from '@bendyline/gezel';

export type Felt = (typeof HAT_FELTS)[number];

/** Parse `#rrggbb` → [r, g, b], or null for anything else. */
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = Number.parseInt(m[1]!, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Convert an RGB tuple back to a lowercase `#rrggbb` string. */
function rgbHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Mix two six-digit hex colors in sRGB space. Poppetje palettes are persisted
 * as plain strings (and power users may supply non-hex values), so invalid
 * colors deliberately fall back to the original instead of making a figure
 * disappear behind a broken SVG paint server.
 */
export function mixHex(color: string, toward: string, amount: number): string {
  const fromRgb = hexRgb(color);
  const towardRgb = hexRgb(toward);
  if (!fromRgb || !towardRgb) return color;
  const t = Math.min(1, Math.max(0, amount));
  return rgbHex([
    fromRgb[0] + (towardRgb[0] - fromRgb[0]) * t,
    fromRgb[1] + (towardRgb[1] - fromRgb[1]) * t,
    fromRgb[2] + (towardRgb[2] - fromRgb[2]) * t,
  ]);
}

/** Euclidean RGB distance; Infinity when either color fails to parse. */
export function rgbDistance(a: string, b: string): number {
  const ra = hexRgb(a);
  const rb = hexRgb(b);
  if (!ra || !rb) return Number.POSITIVE_INFINITY;
  return Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]);
}

/**
 * Minimum contrast (RGB distance) a hat/scarf felt must keep from BOTH of
 * the wearer's skin tones. The skins are all low-chroma warm browns and so
 * are several felts (brick, mustard) — a brick cap on a warm-deep head
 * melts into the skin and the figure reads bald. 50 keeps a comfortable
 * margin over perceptual mush even after the wood-grain multiply darkens
 * both surfaces.
 */
const MIN_FELT_SKIN_DISTANCE = 50;

/**
 * Pick a felt for a cloth hat/scarf, starting at the seed-derived index
 * and walking forward until the felt clears the wearer's skin tones.
 * Deterministic: same start + same skin always lands on the same felt.
 * Navy and charcoal clear every cataloged skin, so the walk terminates
 * for any wearer; non-hex custom skins parse as Infinity and accept the
 * first felt.
 */
export function feltForSkin(startIdx: number, skin: string, skin2: string): Felt {
  const n = HAT_FELTS.length;
  const start = ((startIdx % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const felt = HAT_FELTS[(start + i) % n]!;
    const d = Math.min(rgbDistance(felt.felt, skin), rgbDistance(felt.felt, skin2));
    if (d >= MIN_FELT_SKIN_DISTANCE) return felt;
  }
  return HAT_FELTS[start]!;
}

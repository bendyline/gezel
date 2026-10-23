/**
 * Model-free checks for the ways a diffusion render fails outright: nothing
 * drawn, a black frame (a NaN in the VAE), color burned out by too much
 * guidance, and sampling noise left in the image (too few steps, a wrong
 * scheduler). The stats also measure the column and row seams a tiled VAE
 * decode can leave, without flagging them (see {@link sanityFlags}).
 *
 * These catch broken renders, not ugly ones. Thresholds were set against the
 * 2026-10 sweep (IMAGE-BENCH.md) and are deliberately loose: a flag here
 * means a person should look, and the absence of one proves nothing about
 * quality.
 */

export interface RgbaPixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ImageStats {
  width: number;
  height: number;
  /** Mean luma, 0-255. */
  meanLuma: number;
  /** Standard deviation of luma. Near zero means one flat color. */
  stdLuma: number;
  /** Mean HSV saturation, 0-1. */
  meanSaturation: number;
  /**
   * Fraction of strongly colored pixels with a channel pinned at 0 or 255:
   * the burned look of a guidance scale far above what the model expects.
   * White and black backgrounds do not count, so a logo on white is fine.
   */
  colorClipFraction: number;
  /** Mean absolute 4-neighbor Laplacian of luma: high when sampling noise is left in. */
  laplacian: number;
  /**
   * Largest single-column (or row) jump in the mean neighbor difference,
   * against its surroundings. A tile seam runs the full height or width and
   * stands out; so does a floorboard, which is why one axis is not enough.
   */
  seamScore: number;
  /** Columns whose jump exceeds {@link SEAM_SPIKE}. */
  seamColumns: number;
  /** Rows whose jump exceeds {@link SEAM_SPIKE}. */
  seamRows: number;
}

export const SEAM_SPIKE = 2.5;

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function imageStats(img: RgbaPixels): ImageStats {
  const { data, width, height } = img;
  const n = width * height;
  const y = new Float32Array(n);
  let sum = 0;
  let satSum = 0;
  let colored = 0;
  let clipped = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p] as number;
    const g = data[p + 1] as number;
    const b = data[p + 2] as number;
    const l = luma(r, g, b);
    y[i] = l;
    sum += l;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    satSum += sat;
    if (sat > 0.5 && max > 40) {
      colored++;
      if (max >= 255 || min <= 0) clipped++;
    }
  }
  const meanLuma = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += ((y[i] as number) - meanLuma) ** 2;

  let lapSum = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = row * width + col;
      lapSum += Math.abs(
        4 * (y[i] as number) -
          (y[i - 1] as number) -
          (y[i + 1] as number) -
          (y[i - width] as number) -
          (y[i + width] as number),
      );
    }
  }
  const cols = seamProfile(y, width, height, 'col');
  const rows = seamProfile(y, width, height, 'row');

  return {
    width,
    height,
    meanLuma,
    stdLuma: Math.sqrt(varSum / n),
    meanSaturation: satSum / n,
    // Too few colored pixels to judge (a grayscale photo, a line logo).
    colorClipFraction: colored >= n * 0.02 ? clipped / colored : 0,
    laplacian: lapSum / Math.max(1, (width - 2) * (height - 2)),
    seamScore: Math.max(cols.score, rows.score),
    seamColumns: cols.lines,
    seamRows: rows.lines,
  };
}

/**
 * The mean absolute difference between each pair of adjacent columns (or
 * rows), and how far each one stands out from the three on either side.
 */
function seamProfile(
  y: Float32Array,
  width: number,
  height: number,
  axis: 'col' | 'row',
): { score: number; lines: number } {
  const span = axis === 'col' ? width - 1 : height - 1;
  const across = axis === 'col' ? height : width;
  const d = new Float32Array(span);
  for (let k = 0; k < span; k++) {
    let s = 0;
    for (let j = 0; j < across; j++) {
      const a = axis === 'col' ? j * width + k : k * width + j;
      const b = axis === 'col' ? a + 1 : a + width;
      s += Math.abs((y[a] as number) - (y[b] as number));
    }
    d[k] = s / across;
  }
  let score = 0;
  let lines = 0;
  for (let k = 3; k < span - 3; k++) {
    let around = 0;
    for (const o of [-3, -2, -1, 1, 2, 3]) around += d[k + o] as number;
    // The floor keeps a flat background's near-zero neighbors from turning
    // one faint edge into an enormous ratio.
    const ratio = (d[k] as number) / Math.max(around / 6, 0.75);
    if (ratio > score) score = ratio;
    if (ratio > SEAM_SPIKE) lines++;
  }
  return { score, lines };
}

export type SanityFlag = 'wrong-size' | 'blank' | 'black' | 'burned' | 'noisy';

export function sanityFlags(
  stats: ImageStats,
  expected?: { width: number; height: number },
): SanityFlag[] {
  const flags: SanityFlag[] = [];
  if (expected && (stats.width !== expected.width || stats.height !== expected.height)) {
    flags.push('wrong-size');
  }
  if (stats.meanLuma < 10 && stats.stdLuma < 8) flags.push('black');
  else if (stats.stdLuma < 3) flags.push('blank');
  // A saturated subject clips on its own (a red apple pins its red channel);
  // over-guidance clips and saturates the whole frame.
  if (stats.colorClipFraction > 0.6 && stats.meanSaturation > 0.6) flags.push('burned');
  if (stats.laplacian > 45) flags.push('noisy');
  // No seam flag: brick walls, posters, app screens and logos are full-span
  // straight lines on both axes by design, and flagged as often as a tiled
  // decode would. The seam numbers stay in the stats for a person to sort by.
  return flags;
}

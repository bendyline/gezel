/**
 * Five-point face alignment: the closed-form Umeyama similarity transform
 * from detected landmarks to the canonical ArcFace 112×112 template, plus a
 * bilinear inverse-warp sampler. Pure math over typed arrays — the standard
 * preprocessing every ArcFace-lineage embedder (AuraFace included) expects.
 */

import type { RgbImage } from '../../memory/image-pixels.js';

/** Canonical ArcFace 112×112 landmark template (eyes, nose, mouth corners). */
export const ARCFACE_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export const ARCFACE_SIZE = 112;

export interface Similarity2D {
  /** Row-major 2×3: [a, b, tx, c, d, ty] mapping SOURCE → TEMPLATE space. */
  m: [number, number, number, number, number, number];
}

/**
 * Umeyama (1991) least-squares similarity (rotation + uniform scale +
 * translation) from `src` points to `dst` points. Five points, closed form.
 */
export function umeyama(
  src: ReadonlyArray<readonly [number, number]>,
  dst: ReadonlyArray<readonly [number, number]>,
): Similarity2D {
  const n = src.length;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]![0];
    sy += src[i]![1];
    dx += dst[i]![0];
    dy += dst[i]![1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;

  // Covariance of centered point sets + source variance.
  let cxx = 0;
  let cxy = 0;
  let cyx = 0;
  let cyy = 0;
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const ax = src[i]![0] - sx;
    const ay = src[i]![1] - sy;
    const bx = dst[i]![0] - dx;
    const by = dst[i]![1] - dy;
    cxx += bx * ax;
    cxy += bx * ay;
    cyx += by * ax;
    cyy += by * ay;
    varS += ax * ax + ay * ay;
  }
  cxx /= n;
  cxy /= n;
  cyx /= n;
  cyy /= n;
  varS /= n;

  // SVD-free 2D solve: the rotation maximizing trace(Rᵀ·D) for covariance
  // D = [[cxx, cxy], [cyx, cyy]] is θ = atan2(cyx − cxy, cxx + cyy), with
  // scale = trace at the optimum / source variance. The general Umeyama
  // solution also handles reflections (det(D) < 0), which cannot occur
  // between two face landmark sets — omitted deliberately.
  const theta = Math.atan2(cyx - cxy, cxx + cyy);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const traceDR = (cxx + cyy) * cos + (cyx - cxy) * sin;
  const scale = varS > 0 ? traceDR / varS : 1;

  const a = scale * cos;
  const b = scale * -sin;
  const c = scale * sin;
  const d = scale * cos;
  const tx = dx - (a * sx + b * sy);
  const ty = dy - (c * sx + d * sy);
  return { m: [a, b, tx, c, d, ty] };
}

/** Invert a similarity transform (always invertible for scale > 0). */
function invert(t: Similarity2D): Similarity2D {
  const [a, b, tx, c, d, ty] = t.m;
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return { m: [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)] };
}

/**
 * Warp the source image through the landmark similarity into the 112×112
 * ArcFace crop (inverse-mapped, bilinear, edge-clamped).
 */
export function alignToArcFace(image: RgbImage, landmarks: number[]): RgbImage {
  const src: Array<[number, number]> = [];
  for (let i = 0; i < 5; i++) src.push([landmarks[i * 2]!, landmarks[i * 2 + 1]!]);
  const forward = umeyama(src, ARCFACE_TEMPLATE);
  const [a, b, tx, c, d, ty] = invert(forward).m;

  const { data, width, height } = image;
  const out = new Uint8Array(ARCFACE_SIZE * ARCFACE_SIZE * 3);
  for (let y = 0; y < ARCFACE_SIZE; y++) {
    for (let x = 0; x < ARCFACE_SIZE; x++) {
      const sxf = Math.min(Math.max(a * x + b * y + tx, 0), width - 1);
      const syf = Math.min(Math.max(c * x + d * y + ty, 0), height - 1);
      const x0 = Math.floor(sxf);
      const y0 = Math.floor(syf);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = sxf - x0;
      const fy = syf - y0;
      const i00 = (y0 * width + x0) * 3;
      const i01 = (y0 * width + x1) * 3;
      const i10 = (y1 * width + x0) * 3;
      const i11 = (y1 * width + x1) * 3;
      const oi = (y * ARCFACE_SIZE + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = data[i00 + ch]! * (1 - fx) + data[i01 + ch]! * fx;
        const bottom = data[i10 + ch]! * (1 - fx) + data[i11 + ch]! * fx;
        out[oi + ch] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data: out, width: ARCFACE_SIZE, height: ARCFACE_SIZE };
}

import { BODY_ARCHETYPES, type BodyArchetype, FIGURE_SCALES } from '@bendyline/gezel/poppetje';

export interface ResolvedLayout {
  baseY: number;
  hipY: number;
  waistY: number;
  chestY: number;
  shoulderY: number;
  headR: number;
  headCY: number;
}

/**
 * Resolve the Y positions of the five body width control points and the
 * head ellipse, given the figure-scale knobs. A generous head and shorter
 * torso give the figure toy proportions. The head intentionally dips into the
 * body by ~22% of its radius — the join reads "turned wood", not glued.
 */
export function resolveLayout(scale: { bodyScale: number; headScale: number }): ResolvedLayout {
  const baseY = 160;
  const span = 86 * scale.bodyScale;
  const shoulderY = baseY - span;
  const chestY = shoulderY + span * 0.18;
  const waistY = shoulderY + span * 0.42;
  const hipY = shoulderY + span * 0.72;
  const headR = 25 * scale.headScale;
  const overlap = Math.max(4, headR * 0.22);
  const headCY = shoulderY - headR + overlap;
  return { baseY, hipY, waistY, chestY, shoulderY, headR, headCY };
}

/**
 * Build the body silhouette as one closed SVG path. Smooth cubic
 * segments between the five width control points, with a slight concave
 * shoulder pinch where the head sits.
 */
export function buildBodyPath(arch: BodyArchetype, L: ResolvedLayout): string {
  const cx = 40;
  const lx = (w: number) => cx - w / 2;
  const rx = (w: number) => cx + w / 2;
  const seg = (
    yA: number,
    _wA: number,
    yMid: number,
    wMid: number,
    yB: number,
    wB: number,
    side: 'L' | 'R',
  ): string => {
    const x = (w: number) => (side === 'L' ? cx - w / 2 : cx + w / 2);
    const c1y = yA + (yMid - yA) * 0.55;
    const c2y = yMid + (yB - yMid) * 0.45;
    return `C ${x(wMid)} ${c1y}, ${x(wMid)} ${c2y}, ${x(wB)} ${yB}`;
  };
  const { baseW, hipW, waistW, chestW, shoulderW } = arch;
  const { baseY, hipY, waistY, chestY, shoulderY } = L;
  const shoulderSideY = shoulderY + 2.4;
  const shoulderLeft = lx(shoulderW);
  const shoulderRight = rx(shoulderW);
  return [
    `M ${lx(baseW)} ${baseY}`,
    seg(baseY, baseW, hipY, hipW, waistY, waistW, 'L'),
    seg(waistY, waistW, chestY, chestW, shoulderSideY, shoulderW, 'L'),
    `Q ${shoulderLeft} ${shoulderY + 0.2}, ${shoulderLeft + 3.5} ${shoulderY - 1.1}`,
    `C ${shoulderLeft + shoulderW * 0.24} ${shoulderY - 2.4}, ${shoulderRight - shoulderW * 0.24} ${shoulderY - 2.4}, ${shoulderRight - 3.5} ${shoulderY - 1.1}`,
    `Q ${shoulderRight} ${shoulderY + 0.2}, ${shoulderRight} ${shoulderSideY}`,
    seg(shoulderSideY, shoulderW, chestY, chestW, waistY, waistW, 'R'),
    seg(waistY, waistW, hipY, hipW, baseY, baseW, 'R'),
    `Q ${rx(baseW)} ${baseY + 2.8}, ${rx(baseW) - 3} ${baseY + 3.2}`,
    `Q ${cx} ${baseY + 5.2}, ${lx(baseW) + 3} ${baseY + 3.2}`,
    `Q ${lx(baseW)} ${baseY + 2.8}, ${lx(baseW)} ${baseY}`,
    'Z',
  ].join(' ');
}

/**
 * A vertical band of the turned body between two fractions of its local
 * half-width (`-1` is the left silhouette, `1` the right). Every body control
 * point sits at `40 ± w / 2`, so scaling those widths maps the profile curve
 * itself: a band follows the waist pinch and the hip flare the way light and
 * shadow wrap a lathe-turned form. A bounding-box gradient cannot; at a curvy
 * waist it samples only its middle and the edge shading disappears. The band
 * overshoots the shoulder and foot and is meant to be clipped to the body.
 */
export function buildProfileBand(
  arch: BodyArchetype,
  L: ResolvedLayout,
  from: number,
  to: number,
): string {
  const { baseW, hipW, waistW, chestW, shoulderW } = arch;
  const { baseY, hipY, waistY, chestY, shoulderY } = L;
  const shoulderSideY = shoulderY + 2.4;
  const top = shoulderY - 4;
  const bottom = baseY + 6;
  const up = (u: number) => {
    const x = (w: number) => (40 + (u * w) / 2).toFixed(2);
    return [
      `C ${x(hipW)} ${baseY + (hipY - baseY) * 0.55}, ${x(hipW)} ${hipY + (waistY - hipY) * 0.45}, ${x(waistW)} ${waistY}`,
      `C ${x(chestW)} ${waistY + (chestY - waistY) * 0.55}, ${x(chestW)} ${chestY + (shoulderSideY - chestY) * 0.45}, ${x(shoulderW)} ${shoulderSideY}`,
    ];
  };
  const down = (u: number) => {
    const x = (w: number) => (40 + (u * w) / 2).toFixed(2);
    return [
      `C ${x(chestW)} ${chestY + (shoulderSideY - chestY) * 0.45}, ${x(chestW)} ${waistY + (chestY - waistY) * 0.55}, ${x(waistW)} ${waistY}`,
      `C ${x(hipW)} ${hipY + (waistY - hipY) * 0.45}, ${x(hipW)} ${baseY + (hipY - baseY) * 0.55}, ${x(baseW)} ${baseY}`,
    ];
  };
  const x0 = (u: number, w: number) => (40 + (u * w) / 2).toFixed(2);
  return [
    `M ${x0(from, baseW)} ${bottom}`,
    `L ${x0(from, baseW)} ${baseY}`,
    ...up(from),
    `L ${x0(from, shoulderW)} ${top}`,
    `L ${x0(to, shoulderW)} ${top}`,
    `L ${x0(to, shoulderW)} ${shoulderSideY}`,
    ...down(to),
    `L ${x0(to, baseW)} ${bottom}`,
    'Z',
  ].join(' ');
}

/** Build one organic whorl ring path (closed). */
export function whorlRing(
  rx: number,
  ry: number,
  lobes: number,
  amp: number,
  phase: number,
): string {
  const N = 48;
  let d = '';
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const distortion =
      1 +
      amp * Math.sin(t * lobes + phase) +
      amp * 0.5 * Math.sin(t * (lobes * 2 + 1) - phase * 1.3);
    const x = (Math.cos(t) * rx * distortion).toFixed(2);
    const y = (Math.sin(t) * ry * distortion).toFixed(2);
    d += `${i === 0 ? 'M' : 'L'}${x},${y} `;
  }
  return `${d}Z`;
}

/** Resolve the body archetype, falling back to `tapered` when unknown. */
export function archFor(bodyShape: string): BodyArchetype {
  return BODY_ARCHETYPES[bodyShape] ?? BODY_ARCHETYPES.tapered!;
}

/** Resolve the figure scale, falling back to `adult` when unknown. */
export function scaleFor(figureScale: string): { bodyScale: number; headScale: number } {
  const s = FIGURE_SCALES[figureScale] ?? FIGURE_SCALES.adult!;
  return { bodyScale: s.bodyScale, headScale: s.headScale };
}

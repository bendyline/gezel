import type { MapBlock, MapBuilding } from '@bendyline/gezel';
import type { CityPalette } from './palette.js';
import { hash32, seeded } from './seed.js';

type IssueSeverity = Exclude<NonNullable<MapBlock['health']>['maxSeverity'], null>;

const SEVERITY_SCALE: Record<IssueSeverity, number> = {
  info: 0.78,
  low: 0.86,
  medium: 0.96,
  high: 1.08,
  critical: 1.18,
};

export interface IssueMarkerStyle {
  findings: number;
  severity: IssueSeverity;
  flameCount: number;
  smokeCount: number;
  scale: number;
  severe: boolean;
}

/** Grow close-detail markers without letting them scale linearly into bonfires. */
export function issueMarkerZoomScale(cameraScale: number): number {
  const closeBoost = Math.max(0, Math.log2(Math.max(1, cameraScale))) * 0.52;
  return 0.82 + Math.min(1.25, closeBoost);
}

/**
 * Translate the server's file-health facts into one restrained visual marker.
 * New/removed/phantom files do not burn: those states already have their own
 * strong construction and demolition language.
 */
export function issueMarkerStyle(block: MapBlock): IssueMarkerStyle | null {
  const findings = block.health?.findings ?? 0;
  if (block.state !== 'live' || block.phantom || findings <= 0) return null;

  const severity = block.health?.maxSeverity ?? 'info';
  return {
    findings,
    severity,
    flameCount: Math.min(3, 1 + Math.floor(Math.log2(findings))),
    smokeCount: Math.min(7, 3 + Math.floor(Math.log2(findings + 1))),
    scale: SEVERITY_SCALE[severity] + Math.min(0.22, Math.log2(findings) * 0.07),
    severe: severity === 'critical' || severity === 'high',
  };
}

/** Pick a stable rooftop when a file lot contains several symbol buildings. */
export function representativeIssueBuilding(buildings: readonly MapBuilding[]): MapBuilding | null {
  let best: MapBuilding | null = null;
  let bestScore = -1;
  for (const building of buildings) {
    const score = building.lines ?? building.height * 1_000;
    if (score > bestScore) {
      best = building;
      bestScore = score;
    }
  }
  return best;
}

/** Draw a deterministic, animated screen-space fire and smoke plume. */
export function drawIssueMarker(
  ctx: CanvasRenderingContext2D,
  palette: CityPalette,
  style: IssueMarkerStyle,
  x: number,
  roofY: number,
  stableId: string,
  zoomScale = 1,
  animationTime = 0,
): void {
  const unit = style.scale * zoomScale;
  const rng = seeded(hash32(`${stableId}:issue-marker`));
  const flameHeight = 10 * unit;
  const baseY = roofY + 0.5;

  ctx.save();
  ctx.lineJoin = 'round';

  // Each smoke particle is a cluster of overlapping lobes. Seeded life phases
  // spread them along the column; animation lifts, expands, sways, and fades
  // each cluster before it quietly restarts at the roof.
  ctx.fillStyle = palette.districtLabel;
  for (let i = style.smokeCount - 1; i >= 0; i--) {
    const phase = rng();
    const speed = 0.00016 + rng() * 0.000055;
    const progress = fract(animationTime * speed + phase);
    const radius = (2.1 + progress * 2.7 + rng() * 0.45) * unit;
    const baseDrift = (rng() - 0.5) * 4.5 * unit;
    const sway =
      Math.sin(animationTime * 0.00125 + phase * Math.PI * 2) * (1.4 + progress * 3.2) * unit;
    const smokeX = x + baseDrift + sway;
    const smokeY = baseY - flameHeight - (3.5 + progress * 22) * unit;
    const lifeAlpha = Math.sin(progress * Math.PI);
    const opacity = (style.severe ? 0.38 : 0.3) * lifeAlpha;
    const lobePhase = rng() * Math.PI * 2;

    for (let lobe = 0; lobe < 3; lobe++) {
      const angle = lobePhase + (lobe * Math.PI * 2) / 3;
      const lobeRadius = radius * (0.62 + rng() * 0.15);
      ctx.globalAlpha = opacity * (0.78 + lobe * 0.08);
      ctx.beginPath();
      ctx.arc(
        smokeX + Math.cos(angle) * radius * 0.42,
        smokeY + Math.sin(angle) * radius * 0.3,
        lobeRadius,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  // The flame bodies share a base but flicker at different seeded rates, so
  // they never move as one rigid icon.
  const spread = 4.2 * unit;
  for (let i = 0; i < style.flameCount; i++) {
    const centered = i - (style.flameCount - 1) / 2;
    const flameX = x + centered * spread + (rng() - 0.5) * 1.3 * unit;
    const phase = rng() * Math.PI * 2;
    const speed = 0.008 + rng() * 0.005;
    const flicker = Math.sin(animationTime * speed + phase);
    const shimmy = Math.sin(animationTime * speed * 1.9 + phase * 0.7);
    const height = flameHeight * (0.82 + rng() * 0.18 + flicker * 0.1);
    const width = (3.3 + rng() * 1.1) * unit;
    const lean = (flicker * 0.34 + shimmy * 0.14) * width;

    ctx.globalAlpha = style.severe ? 0.96 : 0.86;
    ctx.fillStyle = palette.awning;
    flamePath(ctx, flameX, baseY, width, height, lean);
    ctx.fill();

    ctx.globalAlpha = 0.96;
    ctx.fillStyle = palette.crane;
    flamePath(ctx, flameX, baseY - 0.25 * unit, width * 0.66, height * 0.72, lean * 0.68);
    ctx.fill();

    ctx.globalAlpha = 0.98;
    ctx.fillStyle = palette.windowLit;
    flamePath(ctx, flameX, baseY - 0.45 * unit, width * 0.34, height * 0.44, lean * 0.42);
    ctx.fill();
  }

  ctx.restore();
}

function flamePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  width: number,
  height: number,
  lean: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x - width / 2, baseY);
  ctx.bezierCurveTo(
    x - width * 0.62,
    baseY - height * 0.35,
    x - width * 0.16 + lean * 0.3,
    baseY - height * 0.7,
    x + lean,
    baseY - height,
  );
  ctx.bezierCurveTo(
    x + width * 0.15 + lean * 0.35,
    baseY - height * 0.62,
    x + width * 0.62,
    baseY - height * 0.3,
    x + width / 2,
    baseY,
  );
  ctx.closePath();
}

function fract(value: number): number {
  return value - Math.floor(value);
}

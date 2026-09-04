import type { CityPalette } from '../palette.js';
import { hash32, seeded } from '../seed.js';
import type { ScreenPt } from './state.js';

/**
 * Working chimney smoke for the industrial zone — foundries, works, kilns,
 * mills. A thin grey plume drifting off to the right, deliberately quieter
 * than the fire marker's column so a busy foundry is never mistaken for a
 * file on fire. Deterministic per building; animated on the frame clock, and
 * a still frame at t=0 under reduced motion.
 */

const PUFFS_PER_STACK = 3;
const MAX_STACKS = 2;

export function drawChimneySmoke(
  ctx: CanvasRenderingContext2D,
  palette: CityPalette,
  stacks: readonly ScreenPt[],
  stableId: string,
  scale: number,
  animationTime: number,
): void {
  if (stacks.length === 0) return;
  const rng = seeded(hash32(`${stableId}:chimney-smoke`));
  const unit = Math.max(0.6, 0.34 * scale);
  ctx.save();
  ctx.fillStyle = palette.street.smoke;
  for (const stack of stacks.slice(0, MAX_STACKS)) {
    for (let i = 0; i < PUFFS_PER_STACK; i++) {
      const phase = rng();
      const speed = 0.00011 + rng() * 0.00005;
      const progress = fract(animationTime * speed + phase);
      const radius = (1.1 + progress * 2.8 + rng() * 0.4) * unit;
      const sway = Math.sin(animationTime * 0.0009 + phase * Math.PI * 2) * 0.8 * unit;
      const x = stack.x + progress * 10 * unit + sway;
      const y = stack.y - 0.5 * unit - progress * 15 * unit;
      ctx.globalAlpha = 0.24 * Math.sin(progress * Math.PI);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function fract(value: number): number {
  return value - Math.floor(value);
}

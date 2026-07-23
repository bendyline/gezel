import type { CityPalette } from './palette.js';

/**
 * A tiny pre-rendered sprite atlas for map decorations (trees, weeds, rubble).
 * Rendered lazily per (theme, dpr-bucket) onto one offscreen canvas so the
 * per-frame cost of decor is drawImage blits, not path drawing. Nullable by
 * design: with no 2D context available (jsdom), callers skip decor entirely.
 */

export const SPRITE_KEYS = [
  'tree1',
  'tree2',
  'tree3',
  'shrub',
  'weed',
  'dryPatch',
  'deadTree',
  'rubble1',
  'rubble2',
] as const;
export type SpriteKey = (typeof SPRITE_KEYS)[number];

/** Base cell size in CSS px; drawn at 2× and scaled down when blitting. */
const CELL = 24;

export interface SpriteAtlas {
  canvas: HTMLCanvasElement;
  /** Source cell size in atlas pixels. */
  cell: number;
  /** Column index per sprite key. */
  index: Record<SpriteKey, number>;
}

const cache = new Map<string, SpriteAtlas | null>();

export function getSpriteAtlas(palette: CityPalette, dpr: number): SpriteAtlas | null {
  const bucket = dpr > 1.5 ? 2 : 1;
  const key = `${palette.dark ? 'dark' : 'light'}|${bucket}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const atlas = buildAtlas(palette, bucket * 2);
  cache.set(key, atlas);
  return atlas;
}

function buildAtlas(p: CityPalette, scale: number): SpriteAtlas | null {
  const cell = CELL * scale;
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = cell * SPRITE_KEYS.length;
    canvas.height = cell;
    ctx = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!ctx) return null;

  const treeA = p.dark ? 'hsl(135 28% 30%)' : 'hsl(120 35% 52%)';
  const treeB = p.dark ? 'hsl(150 30% 24%)' : 'hsl(95 38% 45%)';
  const shrub = p.dark ? 'hsl(140 24% 27%)' : 'hsl(110 30% 60%)';
  const trunk = p.dark ? 'hsl(30 25% 25%)' : 'hsl(30 35% 40%)';
  const weed = p.dark ? 'hsl(60 20% 28%)' : 'hsl(65 35% 55%)';
  const dry = p.dark ? 'hsl(38 25% 30%)' : 'hsl(42 45% 70%)';
  const dead = p.dark ? 'hsl(30 12% 32%)' : 'hsl(30 15% 45%)';

  const index = {} as Record<SpriteKey, number>;
  SPRITE_KEYS.forEach((k, i) => {
    index[k] = i;
  });

  const at = (i: number, draw: (c: CanvasRenderingContext2D) => void): void => {
    ctx.save();
    ctx.translate(i * cell + cell / 2, cell / 2);
    ctx.scale(scale, scale);
    draw(ctx);
    ctx.restore();
  };

  const circle = (c: CanvasRenderingContext2D, x: number, y: number, r: number): void => {
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  };

  const tree = (c: CanvasRenderingContext2D, canopy: string, r: number): void => {
    c.fillStyle = trunk;
    c.fillRect(-1, 2, 2, 6);
    c.fillStyle = canopy;
    circle(c, 0, -1, r);
    c.fillStyle = 'rgba(255, 255, 255, 0.14)';
    circle(c, -r * 0.3, -1 - r * 0.3, r * 0.45);
  };

  at(index.tree1, (c) => tree(c, treeA, 7));
  at(index.tree2, (c) => tree(c, treeB, 6));
  at(index.tree3, (c) => {
    // conifer: stacked triangles
    c.fillStyle = trunk;
    c.fillRect(-1, 5, 2, 4);
    c.fillStyle = treeB;
    for (const [w, y] of [
      [7, 5],
      [5.5, 1],
      [4, -3],
    ] as const) {
      c.beginPath();
      c.moveTo(0, y - 6);
      c.lineTo(-w, y);
      c.lineTo(w, y);
      c.closePath();
      c.fill();
    }
  });
  at(index.shrub, (c) => {
    c.fillStyle = shrub;
    circle(c, -2.5, 2, 3.5);
    circle(c, 2.5, 2, 3);
    circle(c, 0, -1, 3.5);
  });
  at(index.weed, (c) => {
    c.strokeStyle = weed;
    c.lineWidth = 1.2;
    c.beginPath();
    for (const [dx, lean] of [
      [-3, -1.5],
      [0, 0.5],
      [3, 2],
    ] as const) {
      c.moveTo(dx, 6);
      c.quadraticCurveTo(dx + lean, 0, dx + lean * 1.6, -4);
    }
    c.stroke();
  });
  at(index.dryPatch, (c) => {
    c.fillStyle = dry;
    c.beginPath();
    c.ellipse(0, 0, 9, 6, 0.4, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(0, 0, 0, 0.08)';
    c.beginPath();
    c.ellipse(2, 1, 4, 2.5, 0.2, 0, Math.PI * 2);
    c.fill();
  });
  at(index.deadTree, (c) => {
    c.strokeStyle = dead;
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(0, 8);
    c.lineTo(0, -2);
    c.moveTo(0, 0);
    c.lineTo(-4, -5);
    c.moveTo(0, -2);
    c.lineTo(3, -7);
    c.moveTo(0, 3);
    c.lineTo(4, -1);
    c.stroke();
  });
  const rubble = (
    c: CanvasRenderingContext2D,
    seedOffsets: ReadonlyArray<readonly [number, number, number]>,
  ): void => {
    c.fillStyle = p.rubble;
    for (const [x, y, s] of seedOffsets) c.fillRect(x, y, s, s);
  };
  at(index.rubble1, (c) =>
    rubble(c, [
      [-6, -2, 4],
      [-1, 2, 3],
      [3, -4, 3.5],
      [4, 3, 2.5],
    ]),
  );
  at(index.rubble2, (c) =>
    rubble(c, [
      [-5, 3, 3],
      [-4, -5, 2.5],
      [1, -1, 4],
      [6, -4, 2],
    ]),
  );

  return { canvas, cell, index };
}

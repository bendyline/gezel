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

  const treeA = p.dark ? 'hsl(138 22% 29%)' : 'hsl(106 25% 40%)';
  const treeB = p.dark ? 'hsl(152 24% 23%)' : 'hsl(142 22% 32%)';
  const leafLight = p.dark ? '#566d47' : '#8f9f61';
  const shrub = p.dark ? 'hsl(140 24% 27%)' : 'hsl(108 22% 48%)';
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

  const tree = (c: CanvasRenderingContext2D, narrow: boolean): void => {
    c.fillStyle = p.dark ? 'rgba(0,0,0,0.22)' : 'rgba(62,67,39,0.16)';
    c.beginPath();
    c.ellipse(1, 9, narrow ? 3.8 : 7.5, 1.7, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = trunk;
    c.fillRect(-0.8, 1, 1.6, 8);
    c.strokeStyle = trunk;
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(0, 5);
    c.lineTo(-3.5, -1);
    c.moveTo(0, 4);
    c.lineTo(4, -2);
    c.stroke();
    const lobes = narrow
      ? [
          [0, -7.5, 3],
          [-1.8, -4.5, 3.3],
          [1.5, -3.8, 3.2],
          [-1.5, -0.5, 3.5],
          [1.5, 0.8, 3.5],
        ]
      : [
          [-5.2, -0.5, 4],
          [3.8, 0, 4.5],
          [0.4, -5.5, 4.7],
          [-4, -5, 4.2],
          [4.8, -4.2, 3.4],
          [0, 0.5, 5],
        ];
    c.fillStyle = treeB;
    for (const [x, y, r] of lobes) circle(c, x!, y!, r!);
    c.fillStyle = treeA;
    for (const [x, y, r] of lobes) circle(c, x! - 0.6, y! - 1, r! * 0.82);
    c.fillStyle = leafLight;
    c.globalAlpha = 0.5;
    for (const [x, y, r] of lobes.slice(0, 4)) circle(c, x! - 1.2, y! - 1.9, r! * 0.64);
    c.globalAlpha = 1;
  };

  at(index.tree1, (c) => tree(c, false));
  at(index.tree2, (c) => tree(c, true));
  at(index.tree3, (c) => {
    c.fillStyle = trunk;
    c.fillRect(-1, 5, 2, 4);
    for (const [w, y] of [
      [7, 5],
      [5.5, 1],
      [4, -3],
    ] as const) {
      c.fillStyle = treeB;
      c.beginPath();
      c.moveTo(0, y - 6);
      c.lineTo(-w * 0.6, y - 2);
      c.lineTo(-w * 0.48, y - 1.7);
      c.lineTo(-w, y + 0.4);
      c.quadraticCurveTo(0, y + 2, w, y + 0.4);
      c.lineTo(w * 0.52, y - 2);
      c.closePath();
      c.fill();
      c.fillStyle = treeA;
      c.beginPath();
      c.moveTo(0, y - 6);
      c.lineTo(-w, y + 0.4);
      c.lineTo(-0.8, y);
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

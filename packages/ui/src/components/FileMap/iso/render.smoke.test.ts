import type { FileMapResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { lodTier } from '../camera.js';
import { buildPalette } from '../palette.js';
import { SPRITE_KEYS, type SpriteAtlas, type SpriteKey } from '../sprites.js';
import { geometryForModel, hitTestIso } from './geometry.js';
import { createLabelEngineState, renderIso } from './index.js';
import { fitToBoundsIso, toIso, townRoofRiseIso } from './projection.js';
import type { IsoRenderState } from './state.js';

// jsdom can't build the real atlas (no 2D context) — a stub is enough for the
// recording ctx, which just records the drawImage args.
function fakeAtlas(): SpriteAtlas {
  const index = {} as Record<SpriteKey, number>;
  SPRITE_KEYS.forEach((k, i) => {
    index[k] = i;
  });
  return { canvas: {} as HTMLCanvasElement, cell: 48, index };
}

interface RecordedCall {
  method: string;
  args: unknown[];
}

// jsdom has no real 2D context, so the pipeline is exercised against a
// recording stub: every method call is captured, every property set allowed.
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const target: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (!(prop in t)) {
        t[prop] = (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return null;
        };
      }
      return t[prop];
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const NOW = Date.parse('2026-07-05T12:00:00Z');

/** A v5-flavored fixture: displayLabels, plates, plazas, levels, a landmark. */
function model(withOverlay: boolean): FileMapResponse {
  return {
    domain: 'code',
    root: '/repo',
    bounds: { x: 0, y: 0, w: 130, h: 110 },
    builtAt: new Date(NOW).toISOString(),
    indexed: true,
    districts: [
      {
        id: 'src',
        parentId: null,
        rect: { x: 10, y: 10, w: 110, h: 90 },
        label: 'src',
        depth: 1,
        fileCount: 5,
        weight: 6000,
        displayLabel: 'src',
        labelPlate: { x: 14, y: 14, w: 40, h: 11 },
      },
      {
        id: 'src/x',
        parentId: 'src',
        rect: { x: 15, y: 15, w: 100, h: 80 },
        label: 'x',
        depth: 2,
        fileCount: 5,
        weight: 6000,
      },
    ],
    blocks: [
      {
        id: 'src/x/a.ts',
        districtId: 'src/x',
        rect: { x: 20, y: 30, w: 30, h: 30 },
        lot: { x: 18, y: 28, w: 34, h: 34 },
        label: 'a.ts',
        weight: 500,
        lang: 'typescript',
        state: 'live',
        buildingCount: 2,
        levels: 3,
        placedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
        lastTouchedAt: new Date(NOW - 86_400_000).toISOString(),
        health: {
          findings: 0,
          maxSeverity: null,
          fanIn: 1,
          fanOut: 1,
          vibe: 'lush',
          zone: 'residential',
          importance: 0.6,
          churn: 4,
        },
      },
      {
        id: 'src/x/b.ts',
        districtId: 'src/x',
        rect: { x: 60, y: 30, w: 20, h: 20 },
        label: 'b.ts',
        weight: 100,
        lang: 'typescript',
        state: 'new',
        buildingCount: 0,
        placedAt: new Date(NOW).toISOString(),
      },
      {
        id: 'src/x/gone.ts',
        districtId: 'src/x',
        rect: { x: 95, y: 30, w: 16, h: 16 },
        label: 'gone.ts',
        weight: 50,
        lang: 'typescript',
        state: 'tombstoned',
        buildingCount: 0,
        placedAt: null,
      },
      {
        id: 'src/x/ghost.ts',
        districtId: 'src/x',
        rect: { x: 20, y: 70, w: 20, h: 20 },
        label: 'ghost.ts',
        weight: 80,
        lang: 'typescript',
        state: 'new',
        buildingCount: 0,
        phantom: true,
        placedAt: null,
      },
      {
        id: 'src/x/huge.py',
        districtId: 'src/x',
        rect: { x: 60, y: 66, w: 40, h: 30 },
        lot: { x: 58, y: 64, w: 45, h: 35 },
        label: 'huge.py',
        weight: 5000,
        lang: 'python',
        state: 'live',
        buildingCount: 0,
        levels: 5,
        landmark: true,
        placedAt: new Date(NOW - 200 * 86_400_000).toISOString(),
        health: {
          findings: 3,
          maxSeverity: 'critical',
          fanIn: 9,
          fanOut: 0,
          vibe: 'blighted',
          zone: 'civic',
          importance: 1,
          churn: 30,
        },
      },
    ],
    buildings: [
      {
        id: 'src/x/a.ts#Klass',
        blockId: 'src/x/a.ts',
        rect: { x: 22, y: 32, w: 8, h: 8 },
        height: 0.9,
        label: 'Klass',
        kind: 'class',
      },
      {
        id: 'src/x/a.ts#doIt',
        blockId: 'src/x/a.ts',
        rect: { x: 34, y: 32, w: 8, h: 8 },
        height: 0.4,
        label: 'doIt',
        kind: 'function',
      },
    ],
    roads: [
      { a: 'src/x/a.ts', b: 'src/x/huge.py', affinity: 1, source: 'import', bidirectional: false },
      { a: 'src/x/b.ts', b: 'src/x/a.ts', affinity: 1, source: 'import', bidirectional: true },
    ],
    streets: [
      { id: 'st:1', rect: { x: 10, y: 62, w: 110, h: 4 }, tier: 0, districtId: null },
      { id: 'st:2', rect: { x: 55, y: 10, w: 4, h: 90 }, tier: 2, districtId: 'src' },
    ],
    plazas: [
      {
        id: 'plaza:src/x/huge.py',
        districtId: 'src/x',
        rect: { x: 102, y: 66, w: 12, h: 12 },
        kind: 'plaza',
        blockId: 'src/x/huge.py',
      },
      { id: 'green:src:0', districtId: 'src', rect: { x: 20, y: 92, w: 20, h: 6 }, kind: 'green' },
    ],
    ...(withOverlay
      ? {
          overlay: {
            prNumber: 7,
            title: 'test pr',
            changedBlocks: [
              { blockId: 'src/x/a.ts', change: 'modified' as const, additions: 5, deletions: 2 },
              { blockId: 'src/x/ghost.ts', change: 'added' as const, additions: 40, deletions: 0 },
            ],
          },
        }
      : {}),
  };
}

function state(scale: number, m: FileMapResponse, extra?: Partial<IsoRenderState>): IsoRenderState {
  return {
    cam: { scale, offsetX: -60, offsetY: 0 },
    model: m,
    palette: buildPalette(true),
    tier: lodTier(scale),
    viewW: 800,
    viewH: 600,
    selectedId: null,
    hoverId: null,
    now: NOW,
    geom: geometryForModel(m),
    ...extra,
  };
}

const fullViewportFills = (calls: RecordedCall[]) =>
  calls.filter(
    (c) =>
      c.method === 'fillRect' &&
      c.args[0] === 0 &&
      c.args[1] === 0 &&
      c.args[2] === 800 &&
      c.args[3] === 600,
  );

describe('iso render pipeline smoke', () => {
  it.each([
    ['city', 0.2],
    ['district', 1.0],
    ['street', 2.0],
  ])('draws the %s tier without throwing', (_tier, scale) => {
    const { ctx, calls } = recordingCtx();
    renderIso(ctx, state(scale, model(false)));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('labels display districts only, blocks join at street zoom', () => {
    const street = recordingCtx();
    renderIso(street.ctx, state(2.0, model(false)));
    const texts = street.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('src');
    expect(texts).toContain('a.ts');
    // src/x has no displayLabel (collapsed-chain interior) — never labeled
    expect(texts).not.toContain('x');
  });

  it('reveals compact symbol tags only at close-detail zoom', () => {
    const street = recordingCtx();
    renderIso(street.ctx, state(2.0, model(false)));
    const streetTexts = street.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(streetTexts).not.toContain('doIt');

    const detail = recordingCtx();
    renderIso(detail.ctx, state(3.0, model(false)));
    const detailTexts = detail.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0]);
    expect(detailTexts).toContain('doIt');
  });

  it('paints the PR scrim as a second full-viewport fill, after the base city', () => {
    const base = recordingCtx();
    renderIso(base.ctx, state(1.0, model(false)));
    expect(fullViewportFills(base.calls)).toHaveLength(1);

    const withPr = recordingCtx();
    renderIso(withPr.ctx, state(1.0, model(true), { affectedIds: new Set(['src/x/huge.py']) }));
    const fills = fullViewportFills(withPr.calls);
    expect(fills).toHaveLength(2);
    const scrimIndex = withPr.calls.indexOf(fills[1]!);
    expect(scrimIndex).toBeGreaterThan(withPr.calls.length / 3);
  });

  it('survives the age lens, selection, and hover in one frame', () => {
    const { ctx, calls } = recordingCtx();
    renderIso(
      ctx,
      state(2.0, model(false), {
        ageLens: true,
        selectedId: 'src/x/a.ts',
        hoverId: 'src/x/huge.py',
      }),
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it('handles the phantom scaffold path without a canvas pattern (jsdom)', () => {
    const { ctx, calls } = recordingCtx();
    renderIso(ctx, state(1.0, model(true)));
    expect(calls.some((c) => c.method === 'setLineDash')).toBe(true);
  });

  it('blits yard decor only with an atlas, and never under the age lens', () => {
    const bare = recordingCtx();
    renderIso(bare.ctx, state(2.0, model(false)));
    expect(bare.calls.some((c) => c.method === 'drawImage')).toBe(false);

    const decorated = recordingCtx();
    renderIso(decorated.ctx, state(2.0, model(false), { atlas: fakeAtlas() }));
    expect(decorated.calls.some((c) => c.method === 'drawImage')).toBe(true);

    const lensed = recordingCtx();
    renderIso(lensed.ctx, state(2.0, model(false), { atlas: fakeAtlas(), ageLens: true }));
    expect(lensed.calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('keeps the label engine stable across identical frames (hysteresis)', () => {
    const labels = createLabelEngineState();
    const a = recordingCtx();
    renderIso(a.ctx, state(2.0, model(false), { labels }));
    const first = new Set(labels.accepted);
    const b = recordingCtx();
    renderIso(b.ctx, state(2.0, model(false), { labels }));
    expect(labels.accepted).toEqual(first);
    expect(first.size).toBeGreaterThan(0);
  });

  it('hit-tests prisms exactly: top-face clicks select the tall building', () => {
    const m = model(false);
    const geom = geometryForModel(m);
    const cam = fitToBoundsIso(m.bounds, geom.maxHIso, 800, 600);
    const huge = m.blocks.find((b) => b.id === 'src/x/huge.py')!;
    const g = geom.geoms.find((x) => x.block.id === 'src/x/huge.py')!;
    const c = toIso(huge.rect.x + huge.rect.w / 2, huge.rect.y + huge.rect.h / 2);
    // Screen point of the prism's top-face center.
    const sx = (c.u - cam.offsetX) * cam.scale;
    const sy = (c.v - g.hIso - cam.offsetY) * cam.scale;
    expect(hitTestIso(geom, cam, sx, sy)?.id).toBe('src/x/huge.py');
    // The pitched roof extends above the old cuboid and remains clickable.
    const roofSy =
      (c.v - g.hIso - townRoofRiseIso(huge.rect, cam.scale) * 0.8 - cam.offsetY) * cam.scale;
    expect(hitTestIso(geom, cam, sx, roofSy)?.id).toBe('src/x/huge.py');
    // The same point with a ground-plane-only test would miss the block:
    // the unprojected ground point sits north of the footprint.
    const groundY = (c.v - cam.offsetY) * cam.scale;
    expect(hitTestIso(geom, cam, sx, groundY)?.id).toBe('src/x/huge.py');
  });
});
